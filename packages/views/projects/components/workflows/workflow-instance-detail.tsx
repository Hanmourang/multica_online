"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Send } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  workflowGateMessagesOptions,
  workflowInstanceDetailOptions,
  workflowRecoveryDiagnosisOptions,
  useDecideWorkflowGate,
  usePostWorkflowGateMessage,
  useWorkflowInstanceAction,
  useWorkflowStageAction,
  workflowActiveRefetchInterval,
} from "@multica/core/workflow";
import type {
  WorkflowGateRun,
  WorkflowInstanceStatus,
  WorkflowStageRun,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../../i18n";
import { QueryError, QueryLoading } from "../archive/query-states";
import { InstanceStatusBadge, StageStateBadge, formatDateTime } from "./workflow-shared";

/**
 * 实例详情（plan 20261024 §01 F3）：状态机动作按钮按后端允许的迁移矩阵
 * 渲染（pause:[running] / resume:[paused] / cancel:[waiting,running,paused] /
 * succeed:[running,paused] / recover:[failed]），409 冲突统一 toast 提示后由
 * invalidate 收敛真实状态。活跃实例 30s refetch 兜底（WS 断线场景）。
 */

const INSTANCE_ACTIONS: Record<
  WorkflowInstanceStatus,
  Array<"pause" | "resume" | "cancel" | "succeed" | "recover">
> = {
  waiting: ["cancel"],
  running: ["pause", "succeed", "cancel"],
  paused: ["resume", "succeed", "cancel"],
  done: [],
  failed: ["recover", "cancel"],
  cancelled: [],
};

export function WorkflowInstanceDetail({
  projectId,
  instanceId,
  onBack,
}: {
  projectId: string;
  instanceId: string;
  onBack: () => void;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const detailQuery = useQuery({
    ...workflowInstanceDetailOptions(wsId, instanceId),
    refetchInterval: (query) =>
      workflowActiveRefetchInterval(query.state.data?.instance.status),
  });
  const actionMutation = useWorkflowInstanceAction(projectId, instanceId);

  const detail = detailQuery.data;
  const stages = detail?.stages ?? [];
  const gates = detail?.gates ?? [];
  const waitingGates = gates.filter((g) => g.state === "waiting");

  const runAction = async (
    action: "pause" | "resume" | "cancel" | "succeed" | "recover",
  ) => {
    try {
      await actionMutation.mutateAsync(action);
      toast.success(t(($) => $.toast.action_ok));
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  if (detailQuery.isPending) return <QueryLoading rows={6} />;
  if (detailQuery.isError || !detail) {
    return (
      <QueryError
        onRetry={() => void detailQuery.refetch()}
        message={String(detailQuery.error)}
      />
    );
  }

  const { instance } = detail;

  return (
    <div className="space-y-4" data-testid="workflow-instance-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onBack}>
          <ArrowLeft />
          {t(($) => $.actions.back)}
        </Button>
        <span className="font-mono text-micro text-muted-foreground">
          {instance.id.slice(0, 8)}
        </span>
        <InstanceStatusBadge status={instance.status} />
        <span className="text-caption text-muted-foreground">
          {`${t(($) => $.detail.started_at)}: ${formatDateTime(instance.created_at)}`}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {INSTANCE_ACTIONS[instance.status].map((action) => (
            <Button
              key={action}
              type="button"
              size="xs"
              variant={action === "cancel" ? "ghost" : "outline"}
              disabled={actionMutation.isPending}
              onClick={() => void runAction(action)}
            >
              {t(($) => $.instance_actions[action])}
            </Button>
          ))}
        </div>
      </div>

      {instance.status === "failed" ? (
        <RecoveryPanel wsId={wsId} instanceId={instanceId} />
      ) : null}

      <div>
        <h3 className="mb-2 text-caption font-semibold">{t(($) => $.detail.stages)}</h3>
        <ol className="space-y-2">
          {stages.map((stage) => (
            <StageRow
              key={stage.id}
              projectId={projectId}
              instanceId={instanceId}
              stage={stage}
            />
          ))}
        </ol>
      </div>

      <div>
        <h3 className="mb-2 text-caption font-semibold">{t(($) => $.detail.gates)}</h3>
        {waitingGates.length === 0 && gates.length === 0 ? (
          <p className="text-caption text-muted-foreground">{t(($) => $.detail.no_gates)}</p>
        ) : (
          <div className="space-y-3">
            {waitingGates.map((gate) => (
              <GatePanel
                key={gate.id}
                projectId={projectId}
                instanceId={instanceId}
                gate={gate}
              />
            ))}
            {gates
              .filter((g) => g.state !== "waiting")
              .map((gate) => (
                <div
                  key={gate.id}
                  className="flex items-center gap-2 rounded-md border border-surface-border px-3 py-2 text-caption text-muted-foreground"
                >
                  <span className="font-mono text-micro">{gate.id.slice(0, 8)}</span>
                  <Badge variant="outline" className="shrink-0">
                    {`${t(($) => $.detail.gate_round)} ${gate.round}`}
                  </Badge>
                  <span>{gate.state}</span>
                  {gate.decision ? <span>{gate.decision}</span> : null}
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 阶段行
// ---------------------------------------------------------------------------

function StageRow({
  projectId,
  instanceId,
  stage,
}: {
  projectId: string;
  instanceId: string;
  stage: WorkflowStageRun;
}) {
  const { t } = useT("workflow");
  const stageActionMutation = useWorkflowStageAction(projectId, instanceId);

  const runStageAction = async (
    action: "approve" | "loop-back" | "skip" | "rerun" | "interrupt",
  ) => {
    try {
      await stageActionMutation.mutateAsync({ stageRunId: stage.id, action });
      toast.success(t(($) => $.toast.action_ok));
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  const canSkip = ["pending", "running", "waiting_gate"].includes(stage.state);
  const canRerun = ["done", "failed", "skipped"].includes(stage.state);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-surface-border px-3 py-2">
      <span className="text-micro tabular-nums text-muted-foreground">{stage.seq}</span>
      <span className="min-w-0 truncate text-caption font-medium" title={stage.name}>
        {stage.name}
      </span>
      <Badge variant="outline" className="shrink-0">
        {t(($) => $.modes[stage.mode])}
      </Badge>
      <StageStateBadge state={stage.state} />
      <div className="ml-auto flex flex-wrap gap-1">
        {stage.state === "waiting_gate" ? (
          <>
            <Button
              type="button"
              size="xs"
              disabled={stageActionMutation.isPending}
              onClick={() => void runStageAction("approve")}
            >
              {t(($) => $.actions.approve)}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={stageActionMutation.isPending}
              onClick={() => void runStageAction("loop-back")}
            >
              {t(($) => $.actions.loop_back)}
            </Button>
          </>
        ) : null}
        {stage.state === "running" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={stageActionMutation.isPending}
            onClick={() => void runStageAction("interrupt")}
          >
            {t(($) => $.actions.interrupt)}
          </Button>
        ) : null}
        {canSkip ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={stageActionMutation.isPending}
            onClick={() => void runStageAction("skip")}
          >
            {t(($) => $.actions.skip)}
          </Button>
        ) : null}
        {canRerun ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={stageActionMutation.isPending}
            onClick={() => void runStageAction("rerun")}
          >
            {t(($) => $.actions.rerun)}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 门禁裁决面板（waiting 门 + 门边消息）
// ---------------------------------------------------------------------------

function GatePanel({
  projectId,
  instanceId,
  gate,
}: {
  projectId: string;
  instanceId: string;
  gate: WorkflowGateRun;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const decideMutation = useDecideWorkflowGate(projectId, instanceId);
  const messagesQuery = useQuery(workflowGateMessagesOptions(wsId, gate.id));
  const messageMutation = usePostWorkflowGateMessage(gate.id);
  const [draft, setDraft] = useState("");

  const decide = async (decision: "exit" | "loop") => {
    try {
      await decideMutation.mutateAsync({ gateRunId: gate.id, decision });
      toast.success(t(($) => $.toast.decided));
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    try {
      await messageMutation.mutateAsync(content);
      setDraft("");
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  const messages = messagesQuery.data?.messages ?? [];

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-semibold">{t(($) => $.detail.gate_waiting)}</span>
        <Badge variant="secondary" className="shrink-0">
          {`${t(($) => $.detail.gate_round)} ${gate.round}`}
        </Badge>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            size="xs"
            disabled={decideMutation.isPending}
            onClick={() => void decide("exit")}
          >
            {t(($) => $.actions.decide_exit)}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={decideMutation.isPending}
            onClick={() => void decide("loop")}
          >
            {t(($) => $.actions.decide_loop)}
          </Button>
        </div>
      </div>
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {messages.map((message) => (
          <li key={message.id} className="text-caption">
            <span className="mr-1.5 text-micro text-muted-foreground">
              {formatDateTime(message.created_at)}
            </span>
            {message.content}
          </li>
        ))}
      </ul>
      <div className="flex gap-1.5">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t(($) => $.detail.message_placeholder)}
          aria-label={t(($) => $.detail.message_placeholder)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!draft.trim() || messageMutation.isPending}
          onClick={() => void send()}
          aria-label={t(($) => $.actions.send)}
        >
          <Send />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 失败恢复诊断（failed 实例才请求）
// ---------------------------------------------------------------------------

function RecoveryPanel({ wsId, instanceId }: { wsId: string; instanceId: string }) {
  const { t } = useT("workflow");
  const diagnosisQuery = useQuery(workflowRecoveryDiagnosisOptions(wsId, instanceId));
  const suggestions = diagnosisQuery.data?.suggestions ?? [];
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-md border border-surface-border bg-muted/30 p-3 space-y-1">
      <h3 className="text-caption font-semibold">{t(($) => $.detail.recovery_title)}</h3>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={s.stage_run_id} className="text-caption text-muted-foreground">
            <span className="mr-1 font-medium text-foreground">{s.name}</span>
            {s.recommendation}
          </li>
        ))}
      </ul>
    </div>
  );
}
