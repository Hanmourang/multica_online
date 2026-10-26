"use client";

/**
 * 实例详情的原型五面板补齐（plan 20261025 §C1–C4）：
 *   1. 目标管理·需求验收（C-1）
 *   2. 需求拆解·子任务（C-2）
 *   3. 全流程产物追踪（C-3）
 *   4. 实体关联映射（C-4）
 *
 * 刻意不新建后端端点或第二套编辑器：验收标准与子任务的事实源都在既有 issue 面
 * （acceptance_spec / 父子任务 / 评论线程），这里只做「运行视角的聚合 + 跳转」。
 * 与既有底座并行一个平行验收编辑器会立刻产生双事实源，是上一轮已经否决过的方向。
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { childIssuesOptions } from "@multica/core/issues/queries";
import { useCreateComment, useCreateIssue, useUpdateAcceptanceCriteria } from "@multica/core/issues/mutations";
import { projectAssetsOptions } from "@multica/core/assets/queries";
import type { AssetBinding, Issue, WorkflowStageRun } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { useT } from "../../../i18n";
import { AppLink } from "../../../navigation";
import { readAcceptanceSpec } from "../../../issues/components/requirement-plan";
import { QueryError, QueryLoading } from "../archive/query-states";
import { inputAssetName, stageInputs, stageOutputs } from "./workflow-shared";

/** 产物落地行的分组键：external_ref.stage_run_id 由 service.landStageOutputs 写入。 */
function bindingStageId(binding: AssetBinding): string {
  const ref = binding.external_ref as Record<string, unknown> | undefined;
  return typeof ref?.stage_run_id === "string" ? ref.stage_run_id : "";
}

/** 从 acceptance_spec 原始对象抽取已勾选条文集（checked_criteria 纯追加键，
 *  readAcceptanceSpec 会忽略它，互不干扰）。非数组/缺失一律视为空。 */
function readCheckedCriteria(raw: unknown): Set<string> {
  if (raw && typeof raw === "object") {
    const value = (raw as Record<string, unknown>).checked_criteria;
    if (Array.isArray(value)) {
      return new Set(value.filter((item): item is string => typeof item === "string"));
    }
  }
  return new Set();
}

// ---------------------------------------------------------------------------
// C-1 目标管理·需求验收
// ---------------------------------------------------------------------------

export function RunAcceptancePanel({
  projectId,
  rootIssueId,
  issue,
}: {
  projectId: string;
  rootIssueId: string;
  issue: Issue | undefined;
}) {
  const { t } = useT("workflow");
  const paths = useWorkspacePaths();
  const checkMutation = useUpdateAcceptanceCriteria(rootIssueId);
  if (!rootIssueId) return null;

  const spec = readAcceptanceSpec(issue?.acceptance_spec);
  const criteria = spec.assertions.length > 0 ? spec.assertions : spec.cases;
  const round = issue?.acceptance_round ?? 0;
  const checked = readCheckedCriteria(issue?.acceptance_spec);
  const doneCount = criteria.filter((line) => checked.has(line)).length;

  // 勾选回写（§C-1）：把「已核条文全文集合」写进 acceptance_spec.checked_criteria，
  // refetch 后保持一致；只保留仍在当前 criteria 中的项，剔除历史失效条文。
  const toggle = (line: string, nextChecked: boolean) => {
    const set = new Set(checked);
    if (nextChecked) set.add(line);
    else set.delete(line);
    void checkMutation.mutateAsync(criteria.filter((c) => set.has(c)));
  };

  return (
    <section
      className="rounded-lg border border-surface-border bg-card p-3 space-y-2"
      data-testid="workflow-panel-acceptance"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold">{t(($) => $.detail.acceptance_title)}</h3>
        <Badge variant={round > 0 ? "secondary" : "outline"} className="text-micro">
          {t(($) => $.detail.acceptance_round, { n: round })}
        </Badge>
        {criteria.length > 0 ? (
          <Badge variant={doneCount === criteria.length ? "default" : "outline"} className="text-micro">
            {t(($) => $.detail.criteria_checked_progress, { done: doneCount, total: criteria.length })}
          </Badge>
        ) : null}
        <AppLink
          href={paths.projectView(projectId, "acceptance")}
          className="ml-auto text-micro text-muted-foreground underline-offset-2 hover:underline"
        >
          {t(($) => $.actions.detail)}
        </AppLink>
      </header>
      {issue?.goal ? (
        <p className="text-caption text-muted-foreground">
          <span className="mr-1 font-medium text-foreground">{t(($) => $.detail.goal)}</span>
          {issue.goal}
        </p>
      ) : null}
      {criteria.length > 0 ? (
        <ul className="space-y-1" data-testid="workflow-panel-acceptance-list">
          {criteria.map((line, index) => {
            const isChecked = checked.has(line);
            return (
              <li
                key={`${index}-${line.slice(0, 12)}`}
                className="flex items-start gap-2 text-caption"
                data-testid={`workflow-acceptance-criterion-${index}`}
              >
                <Checkbox
                  checked={isChecked}
                  disabled={checkMutation.isPending}
                  onCheckedChange={(next) => toggle(line, Boolean(next))}
                  aria-label={line}
                  className="mt-0.5"
                />
                <span className={isChecked ? "text-muted-foreground line-through" : ""}>{line}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-caption text-muted-foreground">{t(($) => $.detail.acceptance_empty)}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// C-2 需求拆解·子任务
// ---------------------------------------------------------------------------

export function RunSubtasksPanel({
  projectId,
  instanceId,
  rootIssueId,
  stages,
}: {
  projectId: string;
  instanceId: string;
  rootIssueId: string;
  stages: WorkflowStageRun[];
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const childrenQuery = useQuery({
    ...childIssuesOptions(wsId, rootIssueId),
    enabled: rootIssueId !== "",
  });
  const createIssueMutation = useCreateIssue();
  const createCommentMutation = useCreateComment(rootIssueId);
  const children = childrenQuery.data ?? [];
  // 一次只创建一个：按钮逐个阶段呈现，标题/描述预填来自阶段快照（§C-2）。
  const [pendingStageId, setPendingStageId] = useState<string | null>(null);

  if (!rootIssueId) return null;

  const createFromStage = async (stage: WorkflowStageRun) => {
    setPendingStageId(stage.id);
    try {
      const created = await createIssueMutation.mutateAsync({
        title: `[${stage.seq}] ${stage.name}`,
        description: stage.spec?.goal ?? "",
        parent_issue_id: rootIssueId,
        project_id: projectId,
        // 子任务的 barrier 组顺序沿用阶段 seq，让父任务的阶段进度与流程顺序一致。
        stage: stage.seq,
      });
      await createCommentMutation.mutateAsync({
        content: `${t(($) => $.detail.subtask_note, { name: stage.name })} ${created.identifier}`,
      });
      toast.success(t(($) => $.toast.action_ok));
    } catch {
      toast.error(t(($) => $.toast.action_failed));
    } finally {
      setPendingStageId(null);
    }
  };

  return (
    <section
      className="rounded-lg border border-surface-border bg-card p-3 space-y-2"
      data-testid="workflow-panel-subtasks"
      data-instance={instanceId}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold">{t(($) => $.detail.subtasks_title)}</h3>
        <AppLink
          href={paths.issueDetail(rootIssueId)}
          className="ml-auto text-micro text-muted-foreground underline-offset-2 hover:underline"
        >
          {t(($) => $.detail.context_workitem)}
        </AppLink>
      </header>

      {childrenQuery.isPending ? (
        <QueryLoading rows={2} />
      ) : childrenQuery.isError ? (
        <QueryError
          onRetry={() => void childrenQuery.refetch()}
          message={String(childrenQuery.error)}
        />
      ) : children.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(($) => $.detail.subtasks_empty)}</p>
      ) : (
        <ul className="space-y-1">
          {children.map((child) => (
            <li key={child.id} className="flex flex-wrap items-center gap-2 text-caption">
              <AppLink
                href={paths.issueDetail(child.id)}
                className="min-w-0 truncate underline-offset-2 hover:underline"
              >
                {child.title}
              </AppLink>
              <span className="font-mono text-micro text-muted-foreground">{child.identifier}</span>
              <span className="text-micro text-muted-foreground">{child.status}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-1 pt-1">
        {stages.map((stage) => (
          <Button
            key={stage.id}
            type="button"
            size="xs"
            variant="outline"
            disabled={createIssueMutation.isPending || pendingStageId === stage.id}
            onClick={() => void createFromStage(stage)}
            data-testid={`workflow-subtask-create-${stage.seq}`}
          >
            {`${t(($) => $.detail.create_subtask)} · ${stage.seq}. ${stage.name}`}
          </Button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// C-3 全流程产物追踪（声明 ∪ 已落地）
// ---------------------------------------------------------------------------

export function RunArtifactsPanel({
  projectId,
  stages,
}: {
  projectId: string;
  stages: WorkflowStageRun[];
}) {
  const { t } = useT("workflow");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  // 已落地项「可点击跳转资产」（§C-3）：无单资产深链路由，统一跳项目资产 TAB。
  const assetsHref = paths.projectView(projectId, "assets");
  // 端点没有 source 过滤器：一次取宽页再按 source='workflow' 收窄，
  // 避免为了一个面板新增后端契约。
  const assetsQuery = useQuery(projectAssetsOptions(wsId, projectId, { pageSize: 200 }));
  const landed = (assetsQuery.data?.items ?? []).filter(
    (binding) => binding.source === "workflow" && binding.asset_role === "output",
  );

  const rows = stages
    .map((stage) => {
      const declared = stageOutputs(stage.outputs);
      const stageLanded = landed.filter((binding) => bindingStageId(binding) === stage.id);
      const landedNames = new Set(stageLanded.map((binding) => binding.asset_name));
      return { stage, declared, stageLanded, landedNames };
    })
    .filter((row) => row.declared.length > 0 || row.stageLanded.length > 0);

  if (assetsQuery.isPending) {
    return (
      <section className="rounded-lg border border-surface-border bg-card p-3" data-testid="workflow-panel-artifacts">
        <h3 className="text-caption font-semibold">{t(($) => $.detail.artifacts_title)}</h3>
        <div className="pt-2">
          <QueryLoading rows={2} />
        </div>
      </section>
    );
  }

  return (
    <section
      className="rounded-lg border border-surface-border bg-card p-3 space-y-2"
      data-testid="workflow-panel-artifacts"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold">{t(($) => $.detail.artifacts_title)}</h3>
        <AppLink
          href={assetsHref}
          className="ml-auto text-micro text-muted-foreground underline-offset-2 hover:underline"
        >
          {t(($) => $.detail.go_assets)}
        </AppLink>
      </header>

      {rows.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(($) => $.detail.artifacts_empty)}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ stage, declared, stageLanded, landedNames }) => (
            <li key={stage.id} className="space-y-1" data-testid={`workflow-artifact-stage-${stage.seq}`}>
              <p className="text-caption font-medium">
                {`${stage.seq}. ${stage.name}`}
              </p>
              <div className="flex flex-wrap gap-1">
                {declared.map((output, index) => {
                  const name = output.name || output.id;
                  const isLanded = landedNames.has(name);
                  const label = `${name} · ${isLanded ? t(($) => $.detail.artifacts_landed) : t(($) => $.detail.artifacts_declared)}`;
                  // 已落地项跳资产（可点击）；仅声明项无落库行，保持普通徒章。
                  if (isLanded) {
                    return (
                      <AppLink
                        key={output.id || name || index}
                        href={assetsHref}
                        className="underline-offset-2 hover:opacity-80"
                        data-testid={`workflow-artifact-${stage.seq}-${name}`}
                      >
                        <Badge variant="default" className="text-micro">
                          {label}
                        </Badge>
                      </AppLink>
                    );
                  }
                  return (
                    <Badge
                      key={output.id || name || index}
                      variant="outline"
                      className="text-micro"
                      data-testid={`workflow-artifact-${stage.seq}-${name}`}
                    >
                      {label}
                    </Badge>
                  );
                })}
                {stageLanded
                  .filter((binding) => !declared.some((output) => (output.name || output.id) === binding.asset_name))
                  .map((binding) => (
                    <AppLink
                      key={binding.id}
                      href={assetsHref}
                      className="underline-offset-2 hover:opacity-80"
                      data-testid={`workflow-artifact-${stage.seq}-${binding.asset_name}`}
                    >
                      <Badge variant="default" className="text-micro">
                        {`${binding.asset_name} · ${t(($) => $.detail.artifacts_landed)}`}
                      </Badge>
                    </AppLink>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// C-4 实体关联映射（纯说明面板）
// ---------------------------------------------------------------------------

export function RunEntityMappingPanel() {
  const { t } = useT("workflow");
  const rows = [
    t(($) => $.detail.mapping_template),
    t(($) => $.detail.mapping_instance),
    t(($) => $.detail.mapping_stage),
    t(($) => $.detail.mapping_gate),
    t(($) => $.detail.mapping_acceptance),
    t(($) => $.detail.mapping_binding),
    t(($) => $.detail.mapping_sprint),
    t(($) => $.detail.mapping_goal),
    t(($) => $.detail.mapping_artifact),
    t(($) => $.detail.mapping_admission),
  ];
  return (
    <section
      className="rounded-lg border border-surface-border bg-card p-3 space-y-1"
      data-testid="workflow-panel-mapping"
    >
      <h3 className="text-caption font-semibold">{t(($) => $.detail.mapping_title)}</h3>
      <p className="text-micro text-muted-foreground">{t(($) => $.detail.mapping_desc)}</p>
      <ul className="space-y-0.5 text-caption text-muted-foreground">
        {rows.map((row) => (
          <li key={row.slice(0, 24)}>{`· ${row}`}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 阶段准入强制门禁（对齐原型控制视图左列聚合面板）
// ---------------------------------------------------------------------------

export function RunAdmissionGatePanel({
  projectId,
  stages,
}: {
  projectId: string;
  stages: WorkflowStageRun[];
}) {
  const { t } = useT("workflow");
  const paths = useWorkspacePaths();
  // fromStageId 是 definition node id，等于对应 stage_run.node_id → 用同实例阶段名回显来源。
  const nameByNode = useMemo(() => {
    const map: Record<string, string> = {};
    for (const stage of stages) if (stage.node_id) map[stage.node_id] = stage.name;
    return map;
  }, [stages]);
  const assetsHref = paths.projectView(projectId, "assets");

  // 必检项来自 stage 快照的 required 输入；admission_missing 仅 blocked 阶段由后端附带，
  // 因此未报缺件即视为「准入通过」（引擎只在派发受阻时标记缺件），与顶栏 blocked 计数同源。
  const rows = stages
    .map((stage) => {
      const required = stageInputs(stage.inputs).filter((input) => input.required);
      const missing = new Set(stage.admission_missing ?? []);
      return { stage, required, missing };
    })
    .filter((row) => row.required.length > 0);
  const passCount = rows.filter((row) => row.missing.size === 0).length;

  return (
    <section
      className="rounded-lg border border-surface-border bg-card p-3 space-y-2"
      data-testid="workflow-panel-admission-gate"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-caption font-semibold">{t(($) => $.detail.gate_panel_title)}</h3>
        <Badge variant={rows.length > 0 && passCount < rows.length ? "destructive" : "outline"} className="text-micro">
          {`${passCount}/${rows.length}`}
        </Badge>
      </header>
      {rows.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t(($) => $.detail.gate_empty)}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ stage, required, missing }) => {
            const blockedRow = required.some((input) => missing.has(inputAssetName(input)));
            return (
              <li key={stage.id} className="space-y-1" data-testid={`workflow-gate-stage-${stage.seq}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-caption font-medium" title={stage.name}>
                    {`${stage.seq}. ${stage.name}`}
                  </span>
                  <Badge variant={blockedRow ? "destructive" : "secondary"} className="text-micro">
                    {blockedRow ? t(($) => $.detail.gate_block) : t(($) => $.detail.gate_pass)}
                  </Badge>
                </div>
                <ul className="space-y-0.5">
                  {required.map((input, index) => {
                    const name = inputAssetName(input);
                    const ok = !missing.has(name);
                    const src = input.fromStageId
                      ? `${t(($) => $.detail.gate_from_upstream)} · ${nameByNode[input.fromStageId] ?? input.fromStageId}`
                      : t(($) => $.detail.gate_external);
                    return (
                      <li
                        key={`${index}-${name.slice(0, 12)}`}
                        className={`flex flex-wrap items-center gap-2 text-caption ${ok ? "" : "text-destructive"}`}
                        data-testid={`workflow-gate-asset-${stage.seq}-${index}`}
                      >
                        <span className="font-mono text-micro">{ok ? "\u2713" : "\u2717"}</span>
                        <span className="min-w-0 truncate">{name}</span>
                        <span className="text-micro text-muted-foreground">{src}</span>
                        {!ok ? (
                          <AppLink
                            href={assetsHref}
                            className="ml-auto text-micro text-destructive underline-offset-2 hover:underline"
                          >
                            {t(($) => $.detail.gate_bind)}
                          </AppLink>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
