import type { TaskMessagePayload } from "@multica/core/types";
import { buildSteps } from "../../common/task-transcript/build-steps";

/**
 * 执行进展：把实时 task:message 流压成「用户在跑什么」的可读步骤序列。
 *
 * 数据源就是聊天已经在收的那条流（`taskMessagesOptions`）—— 每步的
 * tool_use.input 里带着真实参数（bash 的 command、read 的 file_path、
 * skill 的 name），所以不需要后端另开投影端点：agent_run_todo 投影的
 * title 只有工具名，反而不如这里可读。
 *
 * 只产出 tool 调用步骤。thinking 批次在库里是逐 500ms flush 的碎片
 * （实测一条 20 秒的思考能落几十行），逐条渲染只会刷屏；它的存在感由
 * 阶段 pill 的「思考中」承担。
 */
export type RunToolKind =
  | "skill"
  | "command"
  | "read"
  | "write"
  | "search"
  | "web"
  | "mcp"
  | "other";

export interface ToolDescriptor {
  kind: RunToolKind;
  /** 可读目标：命令首行、文件路径、搜索词、技能名……为空时由 UI 回落工具名。 */
  target: string;
}

export interface RunProgressStep {
  /** 稳定键：call 的 seq（无 call 时用 result 的 seq）。 */
  key: string;
  seq: number;
  tool: string;
  kind: RunToolKind;
  target: string;
  status: "running" | "done";
  durationMs?: number;
  /** 该步发生时正在执行的 skill（skill 调用本身不带）。 */
  skillName?: string;
}

export interface RunProgressSkill {
  name: string;
  /** 归属该 skill 的 tool 步数（含 skill 调用本身）。 */
  stepCount: number;
}

export interface RunProgress {
  steps: RunProgressStep[];
  /** 最后一个还没有 result 的调用；任务已收尾时为 null。 */
  active: RunProgressStep | null;
  latest: RunProgressStep | null;
  currentSkill: string | null;
  skills: RunProgressSkill[];
  finished: number;
  total: number;
  errors: number;
}

// 各家 runtime 的工具 slug 集合（大小写/连字符先归一成下划线）。
const TOOL_KINDS: Record<string, RunToolKind> = {
  skill: "skill",
  skills: "skill",
  use_skill: "skill",
  load_skill: "skill",

  bash: "command",
  shell: "command",
  terminal: "command",
  exec: "command",
  exec_command: "command",
  run: "command",
  run_command: "command",

  read: "read",
  read_file: "read",
  readfile: "read",
  get_file: "read",
  cat: "read",
  view: "read",
  view_file: "read",

  write: "write",
  write_file: "write",
  create: "write",
  create_file: "write",
  edit: "write",
  multi_edit: "write",
  multiedit: "write",
  patch: "write",
  apply_patch: "write",
  patch_apply: "write",
  str_replace: "write",
  str_replace_editor: "write",
  insert: "write",
  delete: "write",

  grep: "search",
  glob: "search",
  ls: "search",
  list_files: "search",
  search: "search",
  search_files: "search",
  search_code: "search",
  codebase_search: "search",
  find: "search",

  web_search: "web",
  websearch: "web",
  web_fetch: "web",
  webfetch: "web",
  fetch: "web",
  exa: "web",
};

const TARGET_KEYS: Record<RunToolKind, string[]> = {
  skill: ["name", "skill", "skill_name", "command", "args"],
  command: ["command", "cmd", "script", "shell_command"],
  read: ["file_path", "filePath", "path", "filename", "file", "target_file"],
  write: ["file_path", "filePath", "path", "filename", "file", "target_file"],
  search: ["pattern", "query", "glob", "path", "q"],
  web: ["query", "url", "q"],
  mcp: ["tool", "name", "server", "query"],
  other: [],
};

/** 命令类目标只留首行：`cat <<EOF` 那种多行脚本会把一行 UI 撑成一屏。 */
function firstLine(value: string): string {
  const line = value.split(/[\r\n]+/).find((part) => part.trim().length > 0) ?? "";
  return line.replace(/\s+/g, " ").trim();
}

function clip(value: string, max = 96): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * 有的 provider 把整条命令塞进 tool 字段（实测库里有
 * `cat_>_/tmp/check8.mjs_<<'eof'`、`cd_/users/…_&&_node_-e_…` 这种把空格换成
 * 下划线的脏数据）。它们不在任何 slug 集合里，长度和分隔符却是命令的形状，
 * 直接当命令渲染比显示一串下划线 slug 有用。
 */
function looksLikeInlineCommand(raw: string): boolean {
  if (raw.length <= 24) return false;
  return /[\s/]/.test(raw) || raw.includes("_&&_");
}

function pickTarget(kind: RunToolKind, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const keys = [...TARGET_KEYS[kind], ...TARGET_KEYS.other];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return clip(firstLine(value));
    }
  }
  // 兜底：拿第一个字符串值 —— 新工具的参数名猜不到时，也比空着强。
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return clip(firstLine(value));
  }
  return "";
}

export function describeToolCall(
  tool: string | undefined,
  input?: Record<string, unknown> | null,
): ToolDescriptor {
  const raw = (tool ?? "").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const known = TOOL_KINDS[normalized];
  if (known) {
    return { kind: known, target: pickTarget(known, input ?? undefined) };
  }
  if (normalized.includes("mcp")) {
    return { kind: "mcp", target: pickTarget("mcp", input ?? undefined) };
  }
  if (looksLikeInlineCommand(raw)) {
    return { kind: "command", target: clip(firstLine(raw)) };
  }
  return { kind: "other", target: pickTarget("other", input ?? undefined) };
}

/**
 * 不只 Claude Code 那种 `skill` 工具：很多 runtime 加载技能就是「读一个
 * SKILL.md」。把这类 read 也当成技能阶段，否则技能名根本不出现。
 */
export function skillNameFromPath(target: string): string | null {
  const match = /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/i.exec(target.trim());
  return match?.[1] ?? null;
}

export function buildRunProgress(
  messages: readonly TaskMessagePayload[],
): RunProgress {
  const steps: RunProgressStep[] = [];
  const skillIndex = new Map<string, RunProgressSkill>();
  let currentSkill: string | null = null;
  let errors = 0;

  for (const step of buildSteps([...messages])) {
    if (step.kind !== "call") {
      if (step.kind === "error") errors += 1;
      continue;
    }
    const call = step.call;
    const tool = call?.tool || step.tool || "";
    const descriptor = describeToolCall(tool, call?.input);
    // read 一张 SKILL.md 就是在加载技能：归到 skill 阶段，目标换成技能名。
    const viaSkillFile =
      descriptor.kind === "read" ? skillNameFromPath(descriptor.target) : null;
    const kind = viaSkillFile ? "skill" : descriptor.kind;
    const target = viaSkillFile ?? descriptor.target;

    if (kind === "skill") {
      currentSkill = target || call?.input?.name?.toString() || "skill";
      if (!skillIndex.has(currentSkill)) {
        const entry: RunProgressSkill = { name: currentSkill, stepCount: 0 };
        skillIndex.set(currentSkill, entry);
      }
    }

    const progressStep: RunProgressStep = {
      key: String(step.seq),
      seq: step.seq,
      tool,
      kind,
      target,
      status: step.result ? "done" : "running",
      durationMs: step.durationMs,
      skillName: kind === "skill" ? undefined : (currentSkill ?? undefined),
    };
    steps.push(progressStep);

    if (currentSkill) {
      const entry = skillIndex.get(currentSkill);
      if (entry) entry.stepCount += 1;
    }
  }

  let active: RunProgressStep | null = null;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.status === "running") {
      active = steps[i]!;
      break;
    }
  }

  return {
    steps,
    active,
    latest: steps[steps.length - 1] ?? null,
    currentSkill,
    skills: [...skillIndex.values()],
    finished: steps.filter((step) => step.status === "done").length,
    total: steps.length,
    errors,
  };
}
