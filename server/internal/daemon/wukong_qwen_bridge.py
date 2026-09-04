#!/usr/bin/env python3
"""wukong-qwen-bridge — adapts Wukong CLI print mode (AG-UI stream-json) to the
JSONL event stream Multica's `qwen` protocol family expects.

Multica qwen family contract (server/pkg/agent/qwen.go):
  argv:  <cmd> --output-format stream-json [--model M] [--resume SID] --yolo
  stdin: task prompt (read to EOF)
  stdout: JSONL, event type in system / assistant / user / result

This file is embedded in the multica daemon (wukong_bridge.go) and
materialized to ~/.multica/shims/wukong-qwen-bridge at probe time. The
__WUKONG_CLI_DEFAULT__ placeholder is replaced with the wukong-cli path the
daemon actually detected, so the shim keeps working when the CLI lives
outside the default app-bundle location.

Environment:
  WUKONG_CLI_PATH  overrides the wukong-cli location (baked-in default below).
"""

import json
import os
import subprocess
import sys

WUKONG_CLI = os.environ.get("WUKONG_CLI_PATH", "__WUKONG_CLI_DEFAULT__")

# Protocol args Multica appends (qwen family): swallowed, never forwarded.
_IGNORE_WITH_VALUE = {
    "--output-format", "-o", "--input-format", "--mcp-config",
    "--approval-mode", "--chat-recording",
}
_IGNORE_STANDALONE = {"--yolo", "-y", "--safe-mode", "--continue", "-c"}
# Custom args allowed through to wukong-cli (agent custom_args).
_FORWARD_WITH_VALUE = {"--max-turns"}
_FORWARD_STANDALONE = {"--no-color", "-q", "--quiet"}


def parse_args(argv):
    """Returns (model, resume_id, forwarded_args). Unknown args are dropped
    (--flag=value forms are safe: the value rides in the same token)."""
    model = ""
    resume = ""
    forwarded = []
    i = 0
    while i < len(argv):
        a = argv[i]
        name, eq, val = a.partition("=")
        if a in ("--model", "-m"):
            if i + 1 < len(argv):
                model = argv[i + 1]
                i += 2
                continue
        elif name in ("--model", "-m") and eq:
            model = val
        elif a in ("--resume", "-r"):
            if i + 1 < len(argv):
                resume = argv[i + 1]
                i += 2
                continue
        elif name in ("--resume", "-r") and eq:
            resume = val
        elif a in _IGNORE_WITH_VALUE:
            i += 2
            continue
        elif name in _IGNORE_WITH_VALUE and eq:
            pass
        elif a in _IGNORE_STANDALONE:
            pass
        elif a in _FORWARD_WITH_VALUE:
            if i + 1 < len(argv):
                forwarded += [a, argv[i + 1]]
                i += 2
                continue
        elif name in _FORWARD_WITH_VALUE and eq:
            forwarded.append(a)
        elif a in _FORWARD_STANDALONE:
            forwarded.append(a)
        # Everything else is dropped so an unknown flag cannot break wukong-cli.
        i += 1
    return model, resume, forwarded


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reject_resume(model_name):
    """wukong-cli print mode cannot resume a prior session. Report it through
    the exact failure channel the qwen family classifies as a REFUSED resume
    (the "no saved session found" phrase is what resumeWasRejected matches),
    so the daemon retries with a fresh cold-context run instead of silently
    losing the conversation."""
    emit({"type": "result",
          "subtype": "error",
          "is_error": True,
          "result": "no saved session found: wukong print mode cannot resume "
                    "prior sessions; start a fresh session",
          "session_id": "",
          "model": model_name})
    return 1


def main():
    argv = sys.argv[1:]

    # Multica probes `<cmd> --version` at registration time.
    if argv in (["--version"], ["-V"], ["--help"], ["-h"]):
        os.execv(WUKONG_CLI, [WUKONG_CLI] + argv)

    model, resume, forwarded = parse_args(argv)
    model_name = model or "wukong"

    if resume:
        return reject_resume(model_name)

    # The qwen family delivers the prompt on stdin, read to EOF.
    prompt = sys.stdin.read()

    cmd = [
        WUKONG_CLI,
        "-p", prompt,
        "--output-format", "stream-json",
        "-w", os.getcwd(),
    ]
    if model:
        cmd += ["--model", model]
    cmd += forwarded

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=os.environ.copy(),
        )
    except OSError as e:
        emit({"type": "result", "subtype": "error", "is_error": True,
              "result": "failed to launch wukong-cli at %s: %s" % (WUKONG_CLI, e)})
        return 1

    session_id = ""
    text_buffers = {}          # messageId -> [deltas]
    tool_buffers = {}          # toolCallId -> {"name": str, "args": [deltas]}
    last_usage = None          # last wukong USAGE event
    result_emitted = False

    def flush_text(message_id):
        buf = text_buffers.pop(message_id, None)
        if not buf:
            return
        text = "".join(buf)
        if text:
            emit({"type": "assistant", "session_id": session_id, "model": model_name,
                  "message": {"model": model_name,
                              "content": [{"type": "text", "text": text}]}})

    def flush_tool(call_id):
        rec = tool_buffers.pop(call_id, None)
        if not rec:
            return
        raw = "".join(rec["args"])
        try:
            tool_input = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            tool_input = {"raw": raw}
        emit({"type": "assistant", "session_id": session_id, "model": model_name,
              "message": {"model": model_name,
                          "content": [{"type": "tool_use", "id": call_id,
                                       "name": rec["name"], "input": tool_input}]}})

    def emit_result(is_error, text, usage):
        nonlocal result_emitted
        if result_emitted:
            return
        result_emitted = True
        out = {"type": "result",
               "subtype": "error" if is_error else "success",
               "is_error": is_error,
               "result": text or "",
               "session_id": session_id,
               "model": model_name}
        if usage:
            out["usage"] = {
                "input_tokens": usage.get("prompt_tokens", 0),
                "output_tokens": usage.get("completion_tokens", 0),
                "cache_read_input_tokens": usage.get("cached_tokens", 0),
            }
        emit(out)

    def handle_agui(ev):
        nonlocal session_id, last_usage
        etype = ev.get("type", "")
        if ev.get("threadId") and not session_id:
            session_id = ev["threadId"]
        if etype == "RUN_STARTED":
            emit({"type": "system", "subtype": "init",
                  "session_id": session_id, "model": model_name})
        elif etype == "TEXT_MESSAGE_START":
            text_buffers[ev.get("messageId", "")] = []
        elif etype == "TEXT_MESSAGE_CONTENT":
            text_buffers.setdefault(ev.get("messageId", ""), []).append(ev.get("delta", ""))
        elif etype == "TEXT_MESSAGE_END":
            flush_text(ev.get("messageId", ""))
        elif etype == "TOOL_CALL_START":
            tool_buffers[ev.get("toolCallId", "")] = {
                "name": ev.get("toolCallName", "tool"), "args": []}
        elif etype == "TOOL_CALL_ARGS":
            rec = tool_buffers.get(ev.get("toolCallId", ""))
            if rec is not None:
                rec["args"].append(ev.get("delta", ""))
        elif etype == "TOOL_CALL_END":
            flush_tool(ev.get("toolCallId", ""))
        elif etype == "TOOL_CALL_RESULT":
            emit({"type": "user", "session_id": session_id,
                  "message": {"content": [{"type": "tool_result",
                                           "tool_use_id": ev.get("toolCallId", ""),
                                           "content": str(ev.get("content", ""))}]}})
        elif etype == "USAGE":
            last_usage = ev
        elif etype == "RUN_ERROR":
            emit_result(True, str(ev.get("message") or ev.get("error") or "wukong run error"),
                        last_usage)

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue  # drop non-JSON diagnostics
        ftype = frame.get("type")
        if ftype == "agui":
            handle_agui(frame.get("event") or {})
        elif ftype == "result":
            # wukong-cli terminal envelope: {"type":"result","result":{...}}
            r = frame.get("result") or {}
            if isinstance(r, dict):
                if r.get("session_id"):
                    session_id = r["session_id"]
                usage = r.get("usage") or last_usage
                emit_result(r.get("status") not in ("finished", "success"),
                            str(r.get("output_text") or ""), usage)
            else:
                emit_result(False, str(r), last_usage)
        # Other top-level shapes are ignored.

    # Flush any buffers left unterminated by a truncated stream.
    for mid in list(text_buffers):
        flush_text(mid)
    for cid in list(tool_buffers):
        flush_tool(cid)

    stderr_tail = proc.stderr.read() if proc.stderr else ""
    exit_code = proc.wait()

    if not result_emitted:
        if exit_code == 0:
            emit_result(False, "", last_usage)
        else:
            detail = stderr_tail.strip().splitlines()
            emit_result(True, detail[-1] if detail else "wukong-cli exited %d" % exit_code,
                        last_usage)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
