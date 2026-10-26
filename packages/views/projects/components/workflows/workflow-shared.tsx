"use client";

import { Badge } from "@multica/ui/components/ui/badge";
import type {
  DefinitionInput,
  DefinitionOutput,
  StageRunState,
  WorkflowInstanceStatus,
  WorkflowTemplateStatus,
} from "@multica/core/types";
import { useT } from "../../../i18n";

/**
 * 工作流 views 共享件：状态枚举常量 + 徽章 + 日期格式化。
 * 枚举顺序即过滤 chip / 时间线的展示顺序，与后端 CHECK 约束取值一致。
 */

export const INSTANCE_STATUSES: readonly WorkflowInstanceStatus[] = [
  "waiting",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled",
];

export const STAGE_STATES: readonly StageRunState[] = [
  "pending",
  "running",
  "waiting_gate",
  "done",
  "failed",
  "skipped",
  // 缺件阻塞（plan 20261025 §A1.4）：得能被筛选/计数，否则 blocked 实例看不见。
  "blocked",
];

export type TemplateStatus = WorkflowTemplateStatus;

const INSTANCE_TONES: Record<WorkflowInstanceStatus, "default" | "secondary" | "destructive" | "outline"> = {
  waiting: "secondary",
  running: "default",
  paused: "outline",
  done: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

const STAGE_TONES: Record<StageRunState, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  running: "default",
  waiting_gate: "secondary",
  done: "secondary",
  failed: "destructive",
  skipped: "outline",
  // 缺件阻塞要用 destructive：顶栏计数与行内徽章得一眼看出是「卡住了」而非「待处理」。
  blocked: "destructive",
};

const TEMPLATE_TONES: Record<TemplateStatus, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  published: "default",
  archived: "secondary",
};

export function InstanceStatusBadge({ status }: { status: WorkflowInstanceStatus }) {
  const { t } = useT("workflow");
  return (
    <Badge variant={INSTANCE_TONES[status] ?? "outline"} className="shrink-0">
      {t(($) => $.statuses[status])}
    </Badge>
  );
}

export function StageStateBadge({ state }: { state: StageRunState }) {
  const { t } = useT("workflow");
  return (
    <Badge variant={STAGE_TONES[state] ?? "outline"} className="shrink-0">
      {t(($) => $.stage_states[state])}
    </Badge>
  );
}

export function TemplateStatusBadge({ status }: { status: TemplateStatus }) {
  const { t } = useT("workflow");
  return (
    <Badge variant={TEMPLATE_TONES[status] ?? "outline"} className="shrink-0">
      {t(($) => $.template_statuses[status])}
    </Badge>
  );
}

/** Date-only, tolerant of an unparseable / empty timestamp. */
export function formatDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

export function formatDateTime(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// stage_run JSONB 快照读取（plan 20261025 §A1）
// ---------------------------------------------------------------------------

/**
 * stage_run.outputs / inputs 是创建实例时从模板编译的 raw JSONB（前端透传 unknown）。
 * 形状不符（旧数据/手工写入）一律回空数组，视图退化为"未声明"而不是崩，
 * 与 Go 侧 declaredOutputs / requiredAssets 的容错口径一致。
 */
function asArray(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

export function stageOutputs(raw: unknown): DefinitionOutput[] {
  return asArray(raw).map((o) => ({
    id: typeof o.id === "string" ? o.id : "",
    name: typeof o.name === "string" ? o.name : "",
    type: typeof o.type === "string" ? o.type : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
  }));
}

export function stageInputs(raw: unknown): DefinitionInput[] {
  return asArray(raw).map((i) => ({
    fromStageId: typeof i.fromStageId === "string" ? i.fromStageId : undefined,
    outputId: typeof i.outputId === "string" ? i.outputId : undefined,
    outputName: typeof i.outputName === "string" ? i.outputName : undefined,
    assetRole: i.assetRole === "out" ? "out" : i.assetRole === "in" ? "in" : undefined,
    required: i.required === true,
  }));
}

/** 必检项展示名：优先 outputName，退回 outputId（与 Go assetNameOf 同口径）。 */
export function inputAssetName(input: DefinitionInput): string {
  return input.outputName?.trim() || input.outputId?.trim() || "";
}
