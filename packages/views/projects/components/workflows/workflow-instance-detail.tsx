"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Send } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { projectDetailOptions } from "@multica/core/projects/queries";
import { sprintDetailOptions } from "@multica/core/sprints/queries";
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
import type { StageAction } from "@multica/core/workflow";
import type {
  WorkflowGateRun,
  WorkflowInstanceDetailResponse,
  WorkflowInstanceStatus,
  WorkflowStageRun,
} from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { readAcceptanceSpec } from "../../../issues/components/requirement-plan";
import { QueryError, QueryLoading } from "../archive/query-states";
import {
  InstanceStatusBadge,
  StageStateBadge,
  formatDateTime,
  stageOutputs,
} from "./workflow-shared";
import {
  RunAcceptancePanel,
  RunAdmissionGatePanel,
  RunArtifactsPanel,
  RunEntityMappingPanel,
  RunSubtasksPanel,
} from "./workflow-run-panels";

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
  const wsId = useWorkspaceId();
  const detailQuery = useQuery({
    ...workflowInstanceDetailOptions(wsId, instanceId),
    refetchInterval: (query) =>
      workflowActiveRefetchInterval(query.state.data?.instance.status),
  });

  if (detailQuery.isPending) return <QueryLoading rows={6} />;
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <QueryError
        onRetry={() => void detailQuery.refetch()}
        message={String(detailQuery.error)}
      />
    );
  }

  return (
    <DetailBody
      projectId={projectId}
      instanceId={instanceId}
      detail={detailQuery.data}
      onBack={onBack}
    />
  );
}

/** workitem_snapshot 取值兜底：实例创建时若带快照，即便 issue 桥接缺失也能显示标题。 */
function snapshotText(snapshot: Record<string, unknown>, key: string): string {
  const value = snapshot?.[key];
  return typeof value === "string" ? value : "";
}

function DetailBody({
  projectId,
  instanceId,
  detail,
  onBack,
}: {
  projectId: string;
  instanceId: string;
  detail: WorkflowInstanceDetailResponse;
  onBack: () => void;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const actionMutation = useWorkflowInstanceAction(projectId, instanceId);

  const { instance } = detail;
  const stages = detail.stages;
  const gates = detail.gates;
  const waitingGates = gates.filter((g) => g.state === "waiting");
  const blockedCount = stages.filter((s) => s.state === "blocked").length;

  // 顶栏上下文（plan 20261025 §A1.5）：项目 / 需求 / 迭代取实时对象标题展示，
  // root_issue_id 缺失的旧实例退回 workitem_snapshot.title——两者都没有就不渲染该项。
  const rootIssueId = instance.root_issue_id ?? "";
  const issueQuery = useQuery({
    ...issueDetailOptions(wsId, rootIssueId),
    enabled: rootIssueId !== "",
  });
  const projectQuery = useQuery({
    ...projectDetailOptions(wsId, projectId),
    enabled: Boolean(projectId),
  });
  const sprintId = instance.sprint_id ?? "";
  const sprintQuery = useQuery({
    ...sprintDetailOptions(wsId, projectId, sprintId),
    enabled: sprintId !== "",
  });

  const issue = issueQuery.data;
  const workitemTitle =
    issue?.title || snapshotText(instance.workitem_snapshot, "title");
  const acceptance = readAcceptanceSpec(issue?.acceptance_spec);
  const acceptanceLines =
    acceptance.assertions.length > 0 ? acceptance.assertions : acceptance.cases;

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
        {blockedCount > 0 ? (
          <Badge variant="destructive" className="shrink-0" data-testid="workflow-blocked-count">
            {t(($) => $.detail.blocked_count, { n: blockedCount })}
          </Badge>
        ) : null}
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

      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground"
        data-testid="workflow-instance-context"
      >
        <span className="inline-flex items-center gap-1">
          {t(($) => $.detail.context_project)}:
          <AppLink href={paths.projectDetail(projectId)} className="text-foreground hover:underline">
            {projectQuery.data?.title ?? projectId.slice(0, 8)}
          </AppLink>
        </span>
        {rootIssueId ? (
          <span className="inline-flex min-w-0 items-center gap-1">
            {t(($) => $.detail.context_workitem)}:
            <AppLink
              href={paths.issueDetail(rootIssueId)}
              className="max-w-64 truncate text-foreground hover:underline"
            >
              {workitemTitle || rootIssueId.slice(0, 8)}
            </AppLink>
            {issue?.identifier ? (
              <span className="font-mono text-micro">{issue.identifier}</span>
            ) : null}
          </span>
        ) : null}
        {sprintId ? (
          <span className="inline-flex items-center gap-1">
            {t(($) => $.detail.context_sprint)}:
            <AppLink href={paths.projectView(projectId, "sprints")} className="text-foreground hover:underline">
              {sprintQuery.data?.name ?? sprintId.slice(0, 8)}
            </AppLink>
          </span>
        ) : null}
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
              rootIssueId={rootIssueId}
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
                stages={stages}
                acceptanceLines={acceptanceLines}
                acceptanceRound={issue?.acceptance_round ?? 0}
                rootIssueId={rootIssueId}
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

      {/* 原型「流程把控」页的四面板（plan 20261025 §C1–C4）：验收 / 产物 / 子任务 / 实体映射。
          事实源全部留在既有面（issue.acceptance_spec、父子任务、project_asset_binding），
          本区只做运行视角的聚合展示与跳转，不引入第二套编辑器或新端点。 */}
      <div className="grid gap-3 lg:grid-cols-2" data-testid="workflow-run-panels">
        <RunAcceptancePanel projectId={projectId} rootIssueId={rootIssueId} issue={issue} />
        <RunArtifactsPanel projectId={projectId} stages={stages} />
        <RunSubtasksPanel
          projectId={projectId}
          instanceId={instanceId}
          rootIssueId={rootIssueId}
          stages={stages}
        />
        <RunAdmissionGatePanel projectId={projectId} stages={stages} />
        <RunEntityMappingPanel />
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
  rootIssueId,
}: {
  projectId: string;
  instanceId: string;
  stage: WorkflowStageRun;
  rootIssueId: string;
}) {
  const { t } = useT("workflow");
  const paths = useWorkspacePaths();
  const stageActionMutation = useWorkflowStageAction(projectId, instanceId);

  const runStageAction = async (action: StageAction) => {
    try {
      await stageActionMutation.mutateAsync({ stageRunId: stage.id, action });
      toast.success(t(($) => $.toast.action_ok));
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    }
  };

  const blocked = stage.state === "blocked";
  // blocked 阶段必须可 skip：缺件在资产模块补不了时，人工跳过是唯一的逃生口（§A-3）。
  const canSkip = ["pending", "running", "waiting_gate", "blocked"].includes(stage.state);
  const canRerun = ["done", "failed", "skipped"].includes(stage.state);
  const spec = stage.spec;
  const outputs = stageOutputs(stage.outputs);
  const missing = stage.admission_missing ?? [];
  // auto 阶段的执行线程落在 root issue（dispatchStage 把 prompt 与回复都写在那），
  // 因此 task_id 非空时给需求详情链接，而不是去猜并不存在的路由（§A-2）。
  const taskHref = stage.task_id && rootIssueId ? paths.issueDetail(rootIssueId) : "";

  return (
    <li
      className={`space-y-1.5 rounded-md border px-3 py-2 ${
        blocked ? "border-destructive/60 bg-destructive/5" : "border-surface-border"
      }`}
      data-testid={`workflow-stage-row-${stage.seq}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-micro tabular-nums text-muted-foreground">{stage.seq}</span>
        <span className="min-w-0 truncate text-caption font-medium" title={stage.name}>
          {stage.name}
        </span>
        <Badge variant="outline" className="shrink-0">
          {t(($) => $.modes[stage.mode])}
        </Badge>
        <StageStateBadge state={stage.state} />
        {taskHref ? (
          <AppLink
            href={taskHref}
            className="shrink-0 text-micro text-muted-foreground underline-offset-2 hover:underline"
            data-testid={`workflow-stage-task-link-${stage.seq}`}
          >
            {t(($) => $.detail.task_link)}
          </AppLink>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-1">
          {blocked ? (
            <Button
              type="button"
              size="xs"
              disabled={stageActionMutation.isPending}
              onClick={() => void runStageAction("recheck")}
              data-testid={`workflow-stage-recheck-${stage.seq}`}
            >
              {t(($) => $.actions.recheck)}
            </Button>
          ) : null}
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
      </div>

      {spec?.goal || spec?.criteria ? (
        <div className="space-y-0.5 text-caption">
          {spec?.goal ? (
            <p className="text-muted-foreground">
              <span className="mr-1 font-medium text-foreground">{t(($) => $.detail.goal)}</span>
              {spec.goal}
            </p>
          ) : null}
          {spec?.criteria ? (
            <p className="text-muted-foreground">
              <span className="mr-1 font-medium text-foreground">{t(($) => $.detail.criteria)}</span>
              {spec.criteria}
            </p>
          ) : null}
        </div>
      ) : null}

      {outputs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1" data-testid={`workflow-stage-outputs-${stage.seq}`}>
          <span className="text-micro text-muted-foreground">{t(($) => $.detail.outputs_title)}</span>
          {outputs.map((output, index) => (
            <Badge key={output.id || output.name || index} variant="secondary" className="text-micro">
              {output.name || output.id}
            </Badge>
          ))}
        </div>
      ) : null}

      {/* 输入/输出模板查看（对齐原型阶段行「输入/输出模板」按钮）：内容来自 spec 快照，
          渲染发生在 dispatchStage（composeSpecPrompt → CreateComment 正文），这里展示模板原文。 */}
      {spec?.inputTpl || spec?.outputTpl ? (
        <details className="text-caption" data-testid={`workflow-stage-templates-${stage.seq}`}>
          <summary className="cursor-pointer text-micro text-muted-foreground hover:text-foreground">
            {t(($) => $.detail.templates_toggle)}
          </summary>
          <div className="mt-1 space-y-1.5">
            {spec?.inputTpl ? (
              <div>
                <p className="text-micro text-muted-foreground">{t(($) => $.detail.input_tpl)}</p>
                <pre className="whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-mono text-micro">{spec.inputTpl}</pre>
              </div>
            ) : null}
            {spec?.outputTpl ? (
              <div>
                <p className="text-micro text-muted-foreground">{t(($) => $.detail.output_tpl)}</p>
                <pre className="whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-mono text-micro">{spec.outputTpl}</pre>
              </div>
            ) : null}
            <p className="text-micro text-muted-foreground">{t(($) => $.detail.rendered_hint)}</p>
          </div>
        </details>
      ) : null}

      {blocked ? (
        <div
          className="flex flex-wrap items-center gap-2 text-caption"
          data-testid={`workflow-stage-missing-${stage.seq}`}
        >
          {missing.length > 0 ? (
            <span className="text-destructive">
              {t(($) => $.detail.missing_assets, { names: missing.join("・") })}
            </span>
          ) : null}
          <AppLink
            href={paths.projectView(projectId, "assets")}
            className="text-destructive underline-offset-2 hover:underline"
            data-testid={`workflow-stage-assets-link-${stage.seq}`}
          >
            {t(($) => $.detail.go_assets)}
          </AppLink>
          <span className="text-micro text-muted-foreground">{t(($) => $.detail.recheck_hint)}</span>
        </div>
      ) : null}
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
  stages,
  acceptanceLines,
  acceptanceRound,
  rootIssueId,
}: {
  projectId: string;
  instanceId: string;
  gate: WorkflowGateRun;
  stages: WorkflowStageRun[];
  acceptanceLines: string[];
  acceptanceRound: number;
  rootIssueId: string;
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const decideMutation = useDecideWorkflowGate(projectId, instanceId);
  const messagesQuery = useQuery(workflowGateMessagesOptions(wsId, gate.id));
  const messageMutation = usePostWorkflowGateMessage(gate.id);
  const [draft, setDraft] = useState("");

  // 裁决面板补齐（plan 20261025 §B4）：按钮文案优先模板自定义标签（存于
  // stage_run.spec 快照，在途实例不受模板后续修改影响），缺省回退通用文案。
  const owner = stages.find((s) => s.id === gate.stage_run_id);
  const ownerSpec = owner?.spec;
  const ownerOutputs = owner ? stageOutputs(owner.outputs) : [];
  const exitLabel = ownerSpec?.exitLabel?.trim() || t(($) => $.actions.decide_exit);
  const loopLabel = ownerSpec?.loopLabel?.trim() || t(($) => $.actions.decide_loop);

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
        {owner ? (
          <span className="min-w-0 truncate text-caption text-muted-foreground" title={owner.name}>
            {`${owner.seq}. ${owner.name}`}
          </span>
        ) : null}
        <Badge variant="secondary" className="shrink-0">
          {`${t(($) => $.detail.gate_round)} ${gate.round}`}
        </Badge>
        <div className="ml-auto flex gap-1">
          <Button
            type="button"
            size="xs"
            disabled={decideMutation.isPending}
            onClick={() => void decide("exit")}
            data-testid={`workflow-gate-exit-${owner?.seq ?? gate.round}`}
          >
            {exitLabel}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={decideMutation.isPending}
            onClick={() => void decide("loop")}
            data-testid={`workflow-gate-loop-${owner?.seq ?? gate.round}`}
          >
            {loopLabel}
          </Button>
        </div>
      </div>

      {acceptanceLines.length > 0 || acceptanceRound > 0 || rootIssueId ? (
        <div className="space-y-1 rounded-md bg-muted/40 px-2 py-1.5" data-testid="workflow-gate-acceptance">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-medium">{t(($) => $.detail.acceptance_title)}</span>
            <Badge variant={acceptanceRound > 0 ? "secondary" : "outline"} className="text-micro">
              {t(($) => $.detail.acceptance_round, { n: acceptanceRound })}
            </Badge>
            {rootIssueId ? (
              <AppLink
                href={paths.projectView(projectId, "acceptance")}
                className="ml-auto text-micro text-muted-foreground underline-offset-2 hover:underline"
              >
                {t(($) => $.actions.detail)}
              </AppLink>
            ) : null}
          </div>
          {acceptanceLines.length > 0 ? (
            <ul className="space-y-0.5 text-caption text-muted-foreground">
              {acceptanceLines.map((line, index) => (
                <li key={`${index}-${line.slice(0, 12)}`}>{`· ${line}`}</li>
              ))}
            </ul>
          ) : (
            <p className="text-micro text-muted-foreground">{t(($) => $.detail.acceptance_empty)}</p>
          )}
        </div>
      ) : null}

      {ownerOutputs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-micro text-muted-foreground">{t(($) => $.detail.outputs_title)}</span>
          {ownerOutputs.map((output, index) => (
            <Badge key={output.id || output.name || index} variant="outline" className="text-micro">
              {output.name || output.id}
            </Badge>
          ))}
        </div>
      ) : null}

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
