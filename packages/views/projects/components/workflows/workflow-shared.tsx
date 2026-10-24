"use client";

import { Badge } from "@multica/ui/components/ui/badge";
import type {
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
