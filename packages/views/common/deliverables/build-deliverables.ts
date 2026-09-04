import type { TraceStep } from "../task-transcript/build-steps";
import type { TimelineItem } from "../task-transcript/build-timeline";
import {
  traceEventDetail,
  type TraceDiffLine,
} from "../task-transcript/trace-event-presenter";

/**
 * One deliverable produced by a run. Everything is derived from data we
 * already persist — the run's transcript stream plus the completion reply —
 * so the wall works for historical runs with no schema change.
 *
 * `content` holds the final full text when the run wrote the file outright
 * (a later write of the same path wins); `diff` accumulates the changed lines
 * for edit-only files whose full text the stream never carried. `source` is
 * "reply" when the path was declared in the completion reply but never
 * touched by a tool call — such cards render without a preview.
 */
export interface Deliverable {
  path: string;
  name: string;
  kind: "added" | "modified";
  source: "trace" | "reply";
  addedLines: number;
  removedLines: number;
  content?: string;
  diff?: TraceDiffLine[];
}

/**
 * Extensions we treat as "this backticked token is a file path". Deliberately
 * a denylist-free allowlist: commands like `pnpm test` or `git status` carry
 * no known extension and stay out.
 */
const KNOWN_EXTS = new Set([
  "md", "markdown", "txt", "json", "jsonc", "yaml", "yml", "toml",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "py", "rs", "java",
  "kt", "swift", "sh", "bash", "zsh", "sql", "html", "css", "scss",
  "vue", "svelte", "xml", "csv", "svg", "png", "jpg", "jpeg", "gif",
  "webp", "pdf",
]);

/**
 * File paths declared in a reply's backticked code spans. A path must contain
 * "/" (bare filenames like `README.md` are too ambiguous against prose) and
 * end in a known extension. Deduped, first-mention order.
 */
export function extractReplyFilePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1]!.trim();
    if (!token.includes("/") || token.includes(" ")) continue;
    const dot = token.lastIndexOf(".");
    if (dot === -1) continue;
    if (!KNOWN_EXTS.has(token.slice(dot + 1).toLowerCase())) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Aggregate a run's final deliverables from its steps, merged with the file
 * paths its completion reply declares. Returns null when the run produced
 * nothing the wall can name — a read-only run must not render an empty row.
 */
export function buildDeliverables(
  steps: TraceStep[],
  replyText: string | null | undefined,
): Deliverable[] | null {
  const byPath = new Map<string, Deliverable>();
  const order: string[] = [];

  const touch = (path: string): Deliverable => {
    let d = byPath.get(path);
    if (!d) {
      d = {
        path,
        name: baseName(path),
        kind: "modified",
        source: "trace",
        addedLines: 0,
        removedLines: 0,
      };
      byPath.set(path, d);
      order.push(path);
    }
    return d;
  };

  const applyFile = (path: string, text: string, lineCount: number, changeKind?: string) => {
    const d = touch(path);
    d.content = text;
    d.diff = undefined;
    d.addedLines += lineCount;
    if (changeKind === "add") d.kind = "added";
  };

  const applyDiff = (path: string, lines: TraceDiffLine[], call?: TimelineItem) => {
    const d = touch(path);
    if (d.content !== undefined) {
      // Write-then-edit: the write's full text is stale the moment an edit
      // lands on top, so fold the edit's old→new replacement into it. The
      // Edit tool contract is "old_string matches uniquely" — apply only
      // then (or everywhere, for replace_all); when the text can't be found
      // the stream has drifted from what the agent saw, and keeping the
      // write's snapshot beats corrupting it.
      const input = call?.input;
      const oldStr = typeof input?.old_string === "string" ? input.old_string : undefined;
      const newStr = typeof input?.new_string === "string" ? input.new_string : undefined;
      if (oldStr !== undefined && newStr !== undefined && oldStr !== "") {
        if (input?.replace_all === true) {
          if (d.content.includes(oldStr)) d.content = d.content.split(oldStr).join(newStr);
        } else {
          const at = d.content.indexOf(oldStr);
          if (at !== -1 && d.content.indexOf(oldStr, at + 1) === -1) {
            d.content = d.content.slice(0, at) + newStr + d.content.slice(at + oldStr.length);
          }
        }
      }
    } else {
      d.diff = [...(d.diff ?? []), ...lines];
    }
    for (const line of lines) {
      if (line.kind === "add") d.addedLines += 1;
      else if (line.kind === "remove") d.removedLines += 1;
    }
  };

  for (const step of steps) {
    if (step.kind !== "call" || !step.call) continue;
    const detail = traceEventDetail(step.call);
    switch (detail.kind) {
      case "file":
        applyFile(detail.path, detail.text, detail.lineCount);
        break;
      case "diff":
        applyDiff(detail.path, detail.lines, step.call);
        break;
      case "patch":
        for (const f of detail.files) {
          if (f.body.kind === "file") applyFile(f.path, f.body.text, f.body.lineCount, f.changeKind);
          else if (f.body.kind === "diff") applyDiff(f.path, f.body.lines);
        }
        break;
    }
  }

  // A file the run wrote and never removed a line from reads as added; the
  // same rule covers write-then-edit since the edit's removals flip it back.
  for (const d of byPath.values()) {
    if (d.content !== undefined && d.removedLines === 0) d.kind = "added";
  }

  for (const path of replyText ? extractReplyFilePaths(replyText) : []) {
    if (byPath.has(path)) continue;
    byPath.set(path, {
      path,
      name: baseName(path),
      kind: "added",
      source: "reply",
      addedLines: 0,
      removedLines: 0,
    });
    order.push(path);
  }

  if (order.length === 0) return null;
  return order.map((p) => byPath.get(p)!);
}

/** Extensions whose content reads as prose — rendered as rich markdown. */
const MARKDOWN_EXTS = new Set(["md", "markdown"]);

/**
 * Render input for the preview dialog. Markdown files pass through so prose
 * gets rich rendering; every other file type is wrapped in a code fence so
 * source stays verbatim and syntax-highlighted instead of being typeset as
 * markdown. The fence is sized past the content's longest backtick run so an
 * embedded ``` example can't break out early.
 */
export function previewContent(d: Deliverable): string | undefined {
  if (d.content === undefined) return undefined;
  const dot = d.path.lastIndexOf(".");
  const ext = dot === -1 ? "" : d.path.slice(dot + 1).toLowerCase();
  if (MARKDOWN_EXTS.has(ext)) return d.content;
  let fenceLen = 3;
  for (const m of d.content.matchAll(/`+/g)) {
    if (m[0].length >= fenceLen) fenceLen = m[0].length + 1;
  }
  const fence = "`".repeat(fenceLen);
  const lang = ext === "txt" ? "" : ext;
  return `${fence}${lang}\n${d.content}\n${fence}`;
}
