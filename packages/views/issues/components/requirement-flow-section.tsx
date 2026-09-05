/**
 * RequirementFlowSection — 需求流水线区块（spec 2026-09-04-requirement-calendar
 * 画面 4/5 落点）：顶层 issue 详情页顶部的四节点 stage 条
 * （原型 → plan+拆解 → 执行 → 验收），当前阶段高亮；条下渲染当前阶段的面板 ——
 * stage 1 挂原型确认面板（班底有启用原型师时），stage 2 挂拆解入口/进行中态；
 * PM 产出草稿评论后（含 manual 模式人工贴块）直接换挂拆解确认面板。
 *
 * 子 issue 永不渲染（stage 标记只对需求本身有意义）；班底无启用原型师时
 * 原型节点渲染跳过态，流水线从 stage 2 起步。
 */
import { Fragment, useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { api } from "@multica/core/api";
import { issueBehavesAsAny } from "@multica/core/issues";
import {
  decompositionOptions,
  issueKeys,
  issueRolesOptions,
  prototypeVersionsOptions,
} from "@multica/core/issues/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { projectResourcesOptions } from "@multica/core/projects";
import type {
  DecomposeDraftTask,
  Issue,
  RoleAssignment,
} from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { RequirementPrototypePanel } from "./requirement-prototype-panel";
import { RequirementDecomposePanel } from "./requirement-decompose-panel";
import { RequirementSchedulePanel } from "./requirement-schedule-panel";
import { RequirementAcceptancePanel } from "./requirement-acceptance-panel";

/** 流水线阶段：1=原型 2=plan+拆解 3=执行 4=验收。 */
export type FlowStage = 1 | 2 | 3 | 4;

export interface FlowStageInput {
  /** 子任务的 stage 分布；terminal = done/cancelled（含自定义状态类目）。 */
  children: { stage: number | null; terminal: boolean }[];
  /** 班底（项目默认或需求快照）里有启用的原型师。 */
  hasPrototyper: boolean;
  /** 存在已确认的原型版本。 */
  hasConfirmedPrototype: boolean;
  /** decomposition_confirmed_at 已落（拆解确认门通过）。 */
  decompositionConfirmed: boolean;
}

/**
 * 与 server requirement_status 投影（issue.sql §6）同语义的详情页本地推导：
 * GetIssue 不带投影列，用（子任务 stage 分布 + 原型师在班 + 原型已确认 +
 * 拆解确认时间）现推当前阶段。规则按序命中，与 9 态投影的阶段语义对齐。
 */
export function deriveFlowStage({
  children,
  hasPrototyper,
  hasConfirmedPrototype,
  decompositionConfirmed,
}: FlowStageInput): FlowStage {
  // 验收子任务已存在 → 验收阶段（打回环会重开执行，但条上仍停在 4 直到新一轮）。
  if (children.some((c) => c.stage === 4)) return 4;
  // 拆解确认门通过 → 执行阶段（stage barrier 控制实际派发）。
  if (decompositionConfirmed) return 3;
  // stage≥2 子任务已存在 → 拆解已发起，停在 plan+拆解。
  if (children.some((c) => c.stage != null && c.stage >= 2)) return 2;
  // 原型师在班且原型未确认 → 原型阶段。
  if (hasPrototyper && !hasConfirmedPrototype) return 1;
  // 兜底：stage-1 子任务仍在跑（如原型师半路被禁用）→ 仍算原型阶段。
  if (children.some((c) => c.stage === 1 && !c.terminal)) return 1;
  return 2;
}

/**
 * PM 草稿只带 assignee_role（developer|data|tester）；确认前解析为班底里第一个
 * 启用的同角色成员。已有具体 assignee_id 的草稿（用户手调过）保持不动。
 */
export function resolveDraftAssignees(
  drafts: DecomposeDraftTask[],
  roster: RoleAssignment[],
): DecomposeDraftTask[] {
  return drafts.map((d) => {
    if (d.assignee_id || !d.assignee_role) return d;
    const m = roster.find((r) => r.enabled && r.role === d.assignee_role);
    return m
      ? { ...d, assignee_type: m.assignee_type, assignee_id: m.assignee_id }
      : d;
  });
}

export interface RequirementFlowSectionProps {
  issue: Issue;
  /** 挂载点已查询的子任务列表，避免重复请求。 */
  childIssues: Issue[];
}

export function RequirementFlowSection({
  issue,
  childIssues,
}: RequirementFlowSectionProps) {
  const { t } = useT("issues");
  const queryClient = useQueryClient();
  const [decomposeStarting, setDecomposeStarting] = useState(false);
  // 面板内的草稿微调按来源评论归档：新一轮 PM 产出（新 source）到来时丢弃旧编辑。
  const [draftState, setDraftState] = useState<{
    source: string | null;
    drafts: DecomposeDraftTask[];
  } | null>(null);

  const isTopLevel = issue.parent_issue_id == null;
  const projectId = issue.project_id ?? null;
  // PM 子任务在跑时轮询拆解产出，草稿出现即停（confirm 后 drafts 仍在，不会长轮询）。
  const hasStage2Child = childIssues.some((c) => c.stage === 2);
  const rosterQuery = useQuery({
    ...issueRolesOptions(issue.id),
    enabled: isTopLevel,
  });
  const versionsQuery = useQuery({
    ...prototypeVersionsOptions(issue.id),
    enabled: isTopLevel,
  });
  const decompQuery = useQuery({
    ...decompositionOptions(issue.id),
    enabled: isTopLevel,
    refetchInterval: (query) =>
      !query.state.data || query.state.data.drafts.length > 0
        ? false
        : hasStage2Child
          ? 4000
          : false,
  });
  const modulesQuery = useQuery({
    ...projectModulesOptions(issue.workspace_id, projectId ?? ""),
    enabled: isTopLevel && !!projectId,
  });
  const resourcesQuery = useQuery({
    ...projectResourcesOptions(issue.workspace_id, projectId ?? ""),
    enabled: isTopLevel && !!projectId,
  });

  // 面板回调走同一 queryKey 的缓存：面板内部的版本轮询与容器共享结果。
  const listVersions = useCallback(
    (issueId: string) => queryClient.fetchQuery(prototypeVersionsOptions(issueId)),
    [queryClient],
  );
  const generatePrototype = useCallback(
    (issueId: string, body: Parameters<typeof api.generatePrototype>[1]) =>
      api.generatePrototype(issueId, body),
    [],
  );
  const saveMarks = useCallback(
    (issueId: string, version: number, marks: Parameters<typeof api.updatePrototypeMarks>[2]) =>
      api.updatePrototypeMarks(issueId, version, marks).then((r) => r.version),
    [],
  );
  const confirmPrototype = useCallback(
    (issueId: string, version: number) =>
      api.confirmPrototype(issueId, version).then(async (r) => {
        // 确认门通过 → 刷新版本列表，流水线条推进到 stage 2。
        await queryClient.invalidateQueries({
          queryKey: issueKeys.prototypeVersions(issueId),
        });
        return r.version;
      }),
    [queryClient],
  );
  const confirmDecomposition = useCallback(
    (issueId: string, drafts: DecomposeDraftTask[]) =>
      api.confirmDecomposition(issueId, drafts).then(async (r) => {
        // 批量生效后：子任务列表出现新任务、需求详情落 decomposition_confirmed_at，
        // 拆解产出保留（面板内部切换到已生效视图）。
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: issueKeys.children(issue.workspace_id, issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.decomposition(issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.detail(issue.workspace_id, issueId),
          }),
        ]);
        return r.issues;
      }),
    [queryClient, issue.workspace_id],
  );
  const triggerRequirement = useCallback(
    (issueId: string) =>
      api.triggerRequirement(issueId).then(async (r) => {
        // 触发后 stage3 子任务入队 → 刷新子任务列表与需求详情（triggered_at / 派生态）。
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: issueKeys.children(issue.workspace_id, issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.detail(issue.workspace_id, issueId),
          }),
        ]);
        return r;
      }),
    [queryClient, issue.workspace_id],
  );
  const submitAcceptanceVerdict = useCallback(
    (issueId: string, body: { verdict: "pass" | "fail"; evidence: string }) =>
      api.submitAcceptanceVerdict(issueId, body).then(async (r) => {
        // pass → 需求 done（WS3 释放组锁）；fail → round+1 + 新 stage3 修复子任务入队。
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: issueKeys.children(issue.workspace_id, issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.detail(issue.workspace_id, issueId),
          }),
        ]);
        return r;
      }),
    [queryClient, issue.workspace_id],
  );

  if (!isTopLevel) return null;
  // 数据未齐不渲染：阶段推导依赖班底与版本列表，半态渲染会闪错节点。
  const roster = rosterQuery.data;
  const versions = versionsQuery.data;
  const decomp = decompQuery.data;
  if (!roster || !versions || !decomp) return null;

  const hasPrototyper = roster.roles.some(
    (r) => r.role === "prototyper" && r.enabled,
  );
  const hasConfirmedPrototype = versions.some((v) => v.status === "confirmed");
  const stage = deriveFlowStage({
    children: childIssues.map((c) => ({
      stage: c.stage,
      terminal: issueBehavesAsAny(c, ["done", "cancelled"]),
    })),
    hasPrototyper,
    hasConfirmedPrototype,
    decompositionConfirmed: issue.decomposition_confirmed_at != null,
  });
  const stage2Children = childIssues.filter((c) => c.stage === 2);

  // 草稿：面板编辑优先（同一来源评论内），否则用服务端产出解析角色指派。
  const sourceId = decomp.source_comment_id ?? null;
  const serverDrafts = resolveDraftAssignees(decomp.drafts, roster.roles);
  const drafts =
    draftState && draftState.source === sourceId
      ? draftState.drafts
      : serverDrafts;
  const moduleName =
    modulesQuery.data?.find((m) => m.id === issue.module_id)?.name ?? null;
  const repoLabel =
    resourcesQuery.data?.find((r) => r.id === issue.repo_resource_id)?.label ??
    null;

  const STAGES: { n: FlowStage; label: string }[] = [
    { n: 1, label: t(($) => $.requirement_flow.stage_prototype) },
    { n: 2, label: t(($) => $.requirement_flow.stage_decompose) },
    { n: 3, label: t(($) => $.requirement_flow.stage_execute) },
    { n: 4, label: t(($) => $.requirement_flow.stage_accept) },
  ];

  const startDecompose = async () => {
    setDecomposeStarting(true);
    try {
      await api.decomposeRequirement(issue.id);
      // PM 子任务已建 → 刷新子任务列表，入口切换为进行中态。
      await queryClient.invalidateQueries({
        queryKey: issueKeys.children(issue.workspace_id, issue.id),
      });
    } catch {
      toast.error(t(($) => $.requirement_flow.decompose_start_failed));
    } finally {
      setDecomposeStarting(false);
    }
  };

  return (
    <section className="mt-4 flex flex-col gap-3">
      <div
        data-testid="requirement-flow"
        className="flex items-center rounded-md border bg-card px-3 py-2"
      >
        {STAGES.map((s, i) => {
          const skipped = s.n === 1 && !hasPrototyper;
          const current = s.n === stage;
          const done = !skipped && s.n < stage;
          return (
            <Fragment key={s.n}>
              {i > 0 && (
                <span
                  className={cn(
                    "mx-2 h-px min-w-3.5 flex-1 bg-border",
                    (done || current) && "bg-emerald-500/45",
                  )}
                />
              )}
              <span
                data-stage-node={s.n}
                data-current={current || undefined}
                data-skipped={skipped || undefined}
                className={cn(
                  "flex items-center gap-1.5 text-[11.5px] text-muted-foreground",
                  done && "text-emerald-600",
                  current && "font-semibold text-primary",
                  skipped && "line-through opacity-55",
                )}
              >
                <span
                  className={cn(
                    "flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full bg-accent text-[10px] font-bold text-muted-foreground",
                    done && "bg-emerald-500/15 text-emerald-600",
                    current && "bg-primary text-primary-foreground",
                  )}
                >
                  {s.n}
                </span>
                {s.label}
              </span>
            </Fragment>
          );
        })}
      </div>

      {stage === 1 && hasPrototyper && (
        <RequirementPrototypePanel
          issue={issue}
          listVersions={listVersions}
          generatePrototype={generatePrototype}
          saveMarks={saveMarks}
          confirmPrototype={confirmPrototype}
        />
      )}

      {stage === 2 &&
        (drafts.length > 0 ? (
          <RequirementDecomposePanel
            key={sourceId ?? "local"}
            issue={issue}
            moduleName={moduleName}
            repoLabel={repoLabel}
            roster={roster.roles}
            plan={decomp.plan}
            drafts={drafts}
            onDraftsChange={(next) =>
              setDraftState({ source: sourceId, drafts: next })
            }
            confirmDecomposition={confirmDecomposition}
          />
        ) : stage2Children.length > 0 ? (
          <p
            data-testid="decompose-running"
            className="text-xs text-muted-foreground"
          >
            {t(($) => $.requirement_flow.decompose_running)}
          </p>
        ) : (
          <div>
            <button
              type="button"
              data-testid="decompose-start"
              disabled={decomposeStarting}
              onClick={() => void startDecompose()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            >
              {decomposeStarting
                ? t(($) => $.requirement_flow.decompose_starting)
                : t(($) => $.requirement_flow.decompose_start)}
            </button>
          </div>
        ))}

      {stage === 3 && (
        <RequirementSchedulePanel
          issue={issue}
          childIssues={childIssues}
          triggerRequirement={triggerRequirement}
        />
      )}

      {stage === 4 && (
        <RequirementAcceptancePanel
          issue={issue}
          childIssues={childIssues}
          submitAcceptanceVerdict={submitAcceptanceVerdict}
        />
      )}
    </section>
  );
}
