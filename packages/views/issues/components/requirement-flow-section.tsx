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
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { api } from "@multica/core/api";
import { issueBehavesAsAny } from "@multica/core/issues";
import { useCreateComment } from "@multica/core/issues/mutations";
import {
  calendarIssuesOptions,
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
import { AppLink } from "../../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { RequirementPrototypePanel } from "./requirement-prototype-panel";
import { RequirementDecomposePanel } from "./requirement-decompose-panel";
import {
  draftsAreConfirmable,
  synthesizeFallbackDrafts,
} from "./requirement-decompose-fallback";
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
  /**
   * 打开时定位的阶段（日历色块 / 待确认 chip / `?stage=`）。
   * 未传则跟随 deriveFlowStage 的当前阶段。
   */
  initialViewedStage?: FlowStage;
  /** 已在工作台内时隐藏「打开工作台」跳转，避免自指。 */
  embedded?: boolean;
}

/** 普通顶层任务（无日历/流水线字段）不挂四阶段条。不用 goal：任务创建也会带交付目标。 */
export function isRequirementWorkbench(issue: Issue): boolean {
  if (issue.parent_issue_id != null) return false;
  if (!issue.project_id) return false;
  return Boolean(
    issue.start_at ||
      issue.repo_resource_id ||
      issue.decomposition_confirmed_at ||
      issue.triggered_at,
  );
}

export function RequirementFlowSection({
  issue,
  childIssues,
  initialViewedStage,
  embedded = false,
}: RequirementFlowSectionProps) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const queryClient = useQueryClient();
  const [decomposeStarting, setDecomposeStarting] = useState(false);
  const [userViewed, setUserViewed] = useState<FlowStage | null>(
    initialViewedStage ?? null,
  );
  // 面板内的草稿微调按来源评论归档：新一轮 PM 产出（新 source）到来时丢弃旧编辑。
  const [draftState, setDraftState] = useState<{
    source: string | null;
    drafts: DecomposeDraftTask[];
  } | null>(null);

  const isTopLevel = issue.parent_issue_id == null;
  const showWorkbench = isRequirementWorkbench(issue);
  const projectId = issue.project_id ?? null;
  const createComment = useCreateComment(issue.id);
  const autoStarted = useRef(false);
  const fallbackSeeded = useRef<string | null>(null);
  const autoConfirmed = useRef(false);
  // PM 子任务在跑时轮询拆解产出，草稿出现即停（confirm 后 drafts 仍在，不会长轮询）。
  const hasStage2Child = childIssues.some((c) => c.stage === 2);
  const stage2Children = childIssues.filter((c) => c.stage === 2);
  const pmSettled = stage2Children.some(isPmAnalysisSettled);
  const rosterQuery = useQuery({
    ...issueRolesOptions(issue.id),
    enabled: isTopLevel && showWorkbench,
  });
  const versionsQuery = useQuery({
    ...prototypeVersionsOptions(issue.id),
    enabled: isTopLevel && showWorkbench,
  });
  const peersQuery = useQuery({
    ...calendarIssuesOptions(issue.workspace_id),
    enabled: isTopLevel && showWorkbench,
  });
  const decompQuery = useQuery({
    ...decompositionOptions(issue.id),
    enabled: isTopLevel && showWorkbench,
    refetchInterval: (query) => {
      if (query.state.data?.drafts.length) return false;
      if (!hasStage2Child) return false;
      if (pmSettled && query.state.data?.plan?.trim()) return false;
      return 4000;
    },
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
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: issueKeys.prototypeVersions(issueId),
          }),
          queryClient.invalidateQueries({
            queryKey: issueKeys.calendar(issue.workspace_id),
          }),
        ]);
        return r.version;
      }),
    [queryClient, issue.workspace_id],
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
          queryClient.invalidateQueries({
            queryKey: issueKeys.calendar(issue.workspace_id),
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
          queryClient.invalidateQueries({
            queryKey: issueKeys.calendar(issue.workspace_id),
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
          queryClient.invalidateQueries({
            queryKey: issueKeys.calendar(issue.workspace_id),
          }),
        ]);
        return r;
      }),
    [queryClient, issue.workspace_id],
  );

  const roster = rosterQuery.data;
  const versions = versionsQuery.data;
  const decomp = decompQuery.data;
  const hasPrototyper = Boolean(
    roster?.roles.some((r) => r.role === "prototyper" && r.enabled),
  );
  const hasConfirmedPrototype = Boolean(
    versions?.some((v) => v.status === "confirmed"),
  );
  const stage = deriveFlowStage({
    children: childIssues.map((c) => ({
      stage: c.stage,
      terminal: issueBehavesAsAny(c, ["done", "cancelled"]),
    })),
    hasPrototyper,
    hasConfirmedPrototype,
    decompositionConfirmed: issue.decomposition_confirmed_at != null,
  });
  const sourceId = decomp?.source_comment_id ?? null;
  const serverDrafts = roster
    ? resolveDraftAssignees(decomp?.drafts ?? [], roster.roles)
    : [];
  const drafts =
    draftState && draftState.source === sourceId
      ? draftState.drafts
      : serverDrafts;
  const hasPlan = Boolean(decomp?.plan?.trim());

  const startDecompose = async () => {
    const hasPm = roster?.roles.some((r) => r.role === "pm" && r.enabled);
    if (!hasPm) {
      toast.error(t(($) => $.requirement_flow.decompose_pm_required));
      return;
    }
    setDecomposeStarting(true);
    try {
      await api.decomposeRequirement(issue.id);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: issueKeys.children(issue.workspace_id, issue.id),
        }),
        queryClient.invalidateQueries({
          queryKey: issueKeys.decomposition(issue.id),
        }),
        queryClient.invalidateQueries({
          queryKey: issueKeys.calendar(issue.workspace_id),
        }),
      ]);
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.requirement_flow.decompose_start_failed),
      );
    } finally {
      setDecomposeStarting(false);
    }
  };

  const requeryGraph = useCallback(async () => {
    const pm = roster?.roles.find((r) => r.role === "pm" && r.enabled);
    const mention = pm ? `@${pm.assignee_id}` : "@PM";
    await createComment.mutateAsync({
      content: `${mention} 请按当前仓库重跑 /impact-analysis，更新本需求拆解草稿的 graph_context`,
    });
  }, [createComment, roster?.roles]);

  useEffect(() => {
    autoStarted.current = false;
    fallbackSeeded.current = null;
    autoConfirmed.current = false;
  }, [issue.id]);

  useEffect(() => {
    if (!showWorkbench || !roster || !versions || !decomp) return;
    if (issue.decompose_mode !== "auto") return;
    if (stage !== 2) return;
    if (drafts.length > 0 || stage2Children.length > 0) return;
    if (!roster.roles.some((r) => r.role === "pm" && r.enabled)) return;
    if (autoStarted.current) return;
    autoStarted.current = true;
    void startDecompose();
  }, [showWorkbench, roster, versions, decomp, issue.decompose_mode, stage, drafts.length, stage2Children.length]);

  useEffect(() => {
    if (!showWorkbench || !roster || !decomp) return;
    if (issue.decomposition_confirmed_at) return;
    if (serverDrafts.length > 0) return;
    if (!pmSettled && !hasPlan) return;
    const seedKey = `${issue.id}:${sourceId ?? "none"}`;
    if (fallbackSeeded.current === seedKey) return;
    if (draftState && draftState.source === sourceId && draftState.drafts.length > 0) {
      return;
    }
    const fallback = synthesizeFallbackDrafts({
      title: issue.title,
      goal: issue.goal,
      plan: decomp.plan,
      roster: roster.roles,
    });
    fallbackSeeded.current = seedKey;
    setDraftState({
      source: sourceId,
      drafts: resolveDraftAssignees(fallback, roster.roles),
    });
  }, [
    showWorkbench,
    roster,
    decomp,
    issue.id,
    issue.title,
    issue.goal,
    issue.decomposition_confirmed_at,
    serverDrafts.length,
    pmSettled,
    hasPlan,
    sourceId,
    draftState,
  ]);

  useEffect(() => {
    if (!showWorkbench) return;
    if (issue.decompose_mode !== "auto") return;
    if (issue.decomposition_confirmed_at) return;
    if (stage !== 2) return;
    if (!draftsAreConfirmable(drafts)) return;
    if (autoConfirmed.current) return;
    autoConfirmed.current = true;
    void confirmDecomposition(issue.id, drafts).catch(() => {
      autoConfirmed.current = false;
    });
  }, [
    showWorkbench,
    issue.decompose_mode,
    issue.decomposition_confirmed_at,
    issue.id,
    stage,
    drafts,
    confirmDecomposition,
  ]);

  useEffect(() => {
    setUserViewed(initialViewedStage ?? null);
  }, [issue.id, initialViewedStage]);

  const prevStage = useRef(stage);
  useEffect(() => {
    if (prevStage.current !== stage) {
      prevStage.current = stage;
      setUserViewed(null);
    }
  }, [stage]);

  if (!isTopLevel || !showWorkbench) return null;
  if (!roster || !versions || !decomp) return null;

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

  const decomposeMode = issue.decompose_mode ?? "confirm";
  const displayStage = userViewed ?? stage;
  const actionsLocked = displayStage > stage;
  const showDecomposePanel =
    drafts.length > 0 ||
    hasPlan ||
    pmSettled ||
    (decomposeMode === "manual" && stage2Children.length === 0);
  const decomposePlan =
    decomp.plan?.trim() ||
    (pmSettled
      ? t(($) => $.requirement_flow.decompose_recovered_empty)
      : decomp.plan);

  const decomposePanel =
    showDecomposePanel ? (
      <RequirementDecomposePanel
        key={sourceId ?? (decomposeMode === "manual" ? "manual-empty" : "recovered")}
        issue={issue}
        moduleName={moduleName}
        repoLabel={repoLabel}
        roster={roster.roles}
        plan={decomposePlan}
        drafts={drafts}
        onDraftsChange={(next) =>
          setDraftState({ source: sourceId, drafts: next })
        }
        confirmDecomposition={confirmDecomposition}
        requeryGraph={requeryGraph}
      />
    ) : stage2Children.length > 0 ? (
      <RequirementDecomposeRunning
        child={stage2Children[0]}
        viewHref={
          stage2Children[0]?.id
            ? paths.issueExecLog(stage2Children[0].id)
            : undefined
        }
      />
    ) : (
      <div>
        <button
          type="button"
          data-testid="decompose-start"
          disabled={decomposeStarting || actionsLocked}
          onClick={() => void startDecompose()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {decomposeStarting
            ? t(($) => $.requirement_flow.decompose_starting)
            : t(($) => $.requirement_flow.decompose_start)}
        </button>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(($) => $.requirement_flow.decompose_start_hint)}
        </p>
      </div>
    );

  const stagePanel =
    displayStage === 1 ? (
      hasPrototyper ? (
        <RequirementPrototypePanel
          issue={issue}
          listVersions={listVersions}
          generatePrototype={generatePrototype}
          saveMarks={saveMarks}
          confirmPrototype={confirmPrototype}
        />
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="proto-skipped">
          {t(($) => $.requirement_flow.stage_prototype)}
        </p>
      )
    ) : displayStage === 2 ? (
      decomposePanel
    ) : displayStage === 3 ? (
      <RequirementSchedulePanel
        issue={issue}
        childIssues={childIssues}
        peerIssues={peersQuery.data ?? []}
        triggerRequirement={triggerRequirement}
      />
    ) : (
      <RequirementAcceptancePanel
        issue={issue}
        childIssues={childIssues}
        submitAcceptanceVerdict={submitAcceptanceVerdict}
      />
    );

  return (
    <section className="mt-4 flex flex-col gap-3">
      <div
        data-testid="requirement-flow"
        className="flex items-center rounded-md border bg-card px-3 py-2"
      >
        {STAGES.map((s, i) => {
          const skipped = s.n === 1 && !hasPrototyper;
          const current = s.n === stage;
          const viewed = s.n === displayStage;
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
              <button
                type="button"
                data-stage-node={s.n}
                data-current={current || undefined}
                data-viewed={viewed || undefined}
                data-skipped={skipped || undefined}
                onClick={() => setUserViewed(s.n)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-foreground",
                  done && "text-emerald-600",
                  current && "font-semibold text-primary",
                  viewed && !current && "underline decoration-dotted",
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
              </button>
            </Fragment>
          );
        })}
        {!embedded && (
          <AppLink
            href={paths.calendarRequirement(issue.id, stage, "issue")}
            className="ml-auto shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            {t(($) => $.requirement_flow.workbench_link)} →
          </AppLink>
        )}
        {embedded && (
          <span className="ml-auto hidden text-[10.5px] text-faint-foreground sm:inline">
            {t(($) => $.requirement_flow.barrier_hint)}
          </span>
        )}
      </div>

      {actionsLocked && (
        <div
          data-testid="stage-future-lock"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-2 py-1.5"
        >
          <p className="text-xs text-muted-foreground">
            {t(($) => $.requirement_flow.future_locked)}
          </p>
          <button
            type="button"
            data-testid="stage-return-current"
            onClick={() => setUserViewed(stage)}
            className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
          >
            {t(($) => $.requirement_flow.return_current_stage, {
              stage: STAGES.find((item) => item.n === stage)?.label ?? "",
            })}
          </button>
        </div>
      )}

      <div
        className={cn("min-w-0", actionsLocked && "pointer-events-none opacity-70")}
      >
        {stagePanel}
      </div>
    </section>
  );
}

function isPmAnalysisSettled(child: Issue): boolean {
  if (issueBehavesAsAny(child, ["done", "cancelled"])) return true;
  return child.status === "in_review" || child.status_category === "in_review";
}

/** S2 进行中：PM 分析需求，确认前不派研发开工。 */
function RequirementDecomposeRunning({
  child,
  viewHref,
}: {
  child?: Issue | null;
  viewHref?: string;
}) {
  const { t } = useT("issues");
  const title = child?.identifier
    ? `${child.identifier} ${child.title ?? ""}`.trim()
    : child?.title;
  const waiting = !child || child.status === "todo" || child.status === "queued";
  const runningTitle = waiting
    ? t(($) => $.requirement_flow.decompose_running_title_waiting)
    : t(($) => $.requirement_flow.decompose_running_title);
  const steps = [
    t(($) => $.requirement_flow.decompose_running_step_read),
    t(($) => $.requirement_flow.decompose_running_step_repo),
    t(($) => $.requirement_flow.decompose_running_step_plan),
    t(($) => $.requirement_flow.decompose_running_step_drafts),
  ];

  return (
    <div
      data-testid="decompose-running"
      className="rounded-lg border bg-card px-3 py-3"
    >
      <p className="text-sm font-medium">{runningTitle}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(($) => $.requirement_flow.decompose_running)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(($) => $.requirement_flow.decompose_running_hint)}
      </p>
      <ol className="mt-3 space-y-1 text-xs text-muted-foreground">
        {steps.map((label, index) => (
          <li key={label} className="flex gap-2">
            <span className="tabular-nums text-faint-foreground">{index + 1}.</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      {viewHref && (
        <AppLink
          href={viewHref}
          data-testid="decompose-running-view"
          className="mt-3 inline-flex text-xs text-primary hover:underline"
        >
          {title
            ? `${t(($) => $.requirement_flow.decompose_running_view)} · ${title}`
            : t(($) => $.requirement_flow.decompose_running_view)}
        </AppLink>
      )}
    </div>
  );
}
