"use client";

/**
 * RequirementDrawer — B4 需求工作台。
 * 全屏容器：头部身份 + 四阶段条（FlowSection）+ 主区面板 + 右栏常驻需求信息。
 * 与 issue 详情页共享 issueKeys；日历页与项目需求 tab 复用。
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  issueDetailOptions,
  childIssuesOptions,
  issueKeys,
  issueRolesOptions,
  issueRolePlaybooksOptions,
} from "@multica/core/issues/queries";
import { calendarIssuesOptions } from "@multica/core/issues/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { projectResourcesOptions } from "@multica/core/projects";
import type { FlowStage } from "../issues/components/requirement-flow-section";
import { RequirementFlowSection } from "../issues/components/requirement-flow-section";
import { RoleStrip } from "../issues/components/role-strip";
import { hasEnabledRole, toRosterPutBody } from "../issues/components/role-roster";
import { withOverride } from "../issues/components/role-playbook";
import { ActorAvatar } from "../common/actor-avatar";
import { AppLink } from "../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { useT } from "../i18n";
import { findModuleHolder } from "./calendar-helpers";
import type { RoleAssignment } from "@multica/core/types";
import { QuickConfirmButton } from "../issues/components/quick-confirm-button";
import { RequirementConfigEditor } from "../issues/components/requirement-config-editor";
import { needsQuickConfirm } from "../projects/components/requirement-drill/requirement-display";

export function RequirementDrawer({
  issueId,
  statusBadge,
  initialViewedStage,
  onOpenChange,
}: {
  /** 打开中的需求 id；null 时抽屉关闭且不发起任何查询。 */
  issueId: string | null;
  /**
   * 派生状态徽标文案（10 态）。requirement_status 是列表端投影列，
   * GetIssue 不返回——由持有列表数据的宿主（日历页/需求列表）传入。
   */
  statusBadge?: string | null;
  initialViewedStage?: FlowStage;
  onOpenChange: (open: boolean) => void;
}) {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { t } = useT("calendar");
  const paths = useWorkspacePaths();
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });
  const { data: childIssues = [] } = useQuery({
    ...childIssuesOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });
  const { data: roster } = useQuery({
    ...issueRolesOptions(issueId ?? ""),
    enabled: !!issueId,
  });
  const { data: projects = [] } = useQuery({
    ...projectListOptions(wsId),
    enabled: !!issueId,
  });
  const { data: modules = [] } = useQuery({
    ...projectModulesOptions(wsId, issue?.project_id ?? ""),
    enabled: !!issue?.project_id,
  });
  const { data: resources = [] } = useQuery({
    ...projectResourcesOptions(wsId, issue?.project_id ?? ""),
    enabled: !!issue?.project_id,
  });
  const { data: peers = [] } = useQuery({
    ...calendarIssuesOptions(wsId),
    enabled: !!issueId,
  });
  const enabledRoles = (roster?.roles ?? []).filter((r) => r.enabled);
  const projectName =
    projects.find((p) => p.id === issue?.project_id)?.title ?? "—";
  const module = modules.find((m) => m.id === issue?.module_id);
  const repo = resources.find((r) => r.id === issue?.repo_resource_id);
  const holder = issue ? findModuleHolder(peers, issue) : null;

  const handleClose = () => {
    void qc.invalidateQueries({ queryKey: issueKeys.calendar(wsId) });
    onOpenChange(false);
  };

  return (
    <Sheet
      // 创建需求弹窗也是 Base UI Dialog。两层 modal 叠在一起会把
      // pointer-events 锁在底层弹窗，工作台里拆解 / × 都点不到。
      modal={false}
      open={!!issueId}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent
        side="right"
        showOverlay={false}
        showCloseButton={false}
        data-testid="requirement-workbench"
        className="pointer-events-auto relative z-50 flex flex-col gap-0 overflow-hidden p-0 data-[side=right]:inset-2 data-[side=right]:left-2 data-[side=right]:h-auto data-[side=right]:w-auto data-[side=right]:max-w-none data-[side=right]:rounded-xl data-[side=right]:sm:max-w-none"
      >
        {issue ? (
          <div className="relative z-0 flex min-h-0 flex-1 flex-col">
            <SheetHeader className="relative z-20 shrink-0 border-b px-4 py-3 pr-12">
              <div className="flex items-start gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  data-testid="workbench-back"
                  onClick={handleClose}
                  className="relative z-20 mt-0.5 shrink-0"
                >
                  <ArrowLeft className="size-3.5" />
                  {t(($) => $.workbench.back)}
                </Button>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">#{issue.number}</span>
                {issue.title}
                {statusBadge && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-caption font-normal">
                    {statusBadge}
                  </span>
                )}
                {needsQuickConfirm({
                  status: issue.status,
                  statusCategory: issue.status_category,
                  requirementStatus: statusBadge,
                }) && (
                  <QuickConfirmButton
                    issueId={issue.id}
                    onDone={() =>
                      void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) })
                    }
                  />
                )}
                {enabledRoles.length > 0 && (
                  <span className="ml-1 flex items-center -space-x-1">
                    {enabledRoles.map((r) => (
                      <span key={r.id} data-testid={`roster-${r.role}`}>
                        <ActorAvatar
                          actorType={r.assignee_type}
                          actorId={r.assignee_id}
                          size="sm"
                        />
                      </span>
                    ))}
                  </span>
                )}
                  </SheetTitle>
                  <p className="flex flex-wrap items-center gap-2 pr-2 text-caption text-muted-foreground">
                {module && (
                  <span>
                    <span
                      className="mr-1 inline-block size-2 rounded-full"
                      style={{ backgroundColor: module.color }}
                    />
                    {module.name}
                  </span>
                )}
                <span className="font-mono">
                  {issue.start_at
                    ? issue.start_at.slice(0, 16).replace("T", " ")
                    : "—"}
                  {" ~ "}
                  {issue.due_date ?? "—"}
                </span>
                {repo && (
                  <span className="font-mono text-[10px]">
                    {repo.label ?? "git"}
                  </span>
                )}
                <AppLink
                  href={paths.issueDetail(issue.id)}
                  data-testid="workbench-back-issue"
                  className="text-caption font-normal text-muted-foreground hover:text-foreground"
                >
                  {t(($) => $.workbench.issue_detail)} →
                </AppLink>
                {issue.project_id && (
                  <AppLink
                    href={paths.projectRequirement(issue.project_id, issue.id)}
                    className="text-caption font-normal text-muted-foreground hover:text-foreground"
                  >
                    {t(($) => $.workbench.project_detail)} →
                  </AppLink>
                )}
              </p>
                </div>
              </div>
            </SheetHeader>
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 overflow-y-auto px-5 py-3">
                <RequirementFlowSection
                  issue={issue}
                  childIssues={childIssues}
                  initialViewedStage={initialViewedStage}
                  embedded
                />
              </div>
              <aside
                data-testid="workbench-aside"
                className="hidden w-[260px] shrink-0 overflow-y-auto border-l px-3 py-3 text-caption lg:block"
              >
                <h4 className="mb-2 font-semibold">{t(($) => $.workbench.info)}</h4>
                <dl className="mb-3 space-y-1.5">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">
                      {t(($) => $.page.project_filter)}
                    </dt>
                    <dd>{projectName}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">
                      {t(($) => $.page.module_filter)}
                    </dt>
                    <dd>{module?.name ?? "—"}</dd>
                  </div>
                </dl>
                <RequirementConfigEditor issue={issue} showTitle compact />
                <h4 className="mb-1 mt-4 font-semibold">
                  {t(($) => $.workbench.roster)}
                </h4>
                <WorkbenchRoster
                  issueId={issue.id}
                  roles={roster?.roles ?? []}
                />
                <h4 className="mb-1 mt-4 font-semibold">
                  {t(($) => $.workbench.mutex)}
                </h4>
                <p className="text-muted-foreground leading-relaxed">
                  {holder
                    ? t(($) => $.workbench.mutex_held, {
                        n: holder.number,
                        title: holder.title,
                      })
                    : t(($) => $.workbench.mutex_free)}
                </p>
                {issue.project_id && (
                  <>
                    <h4 className="mb-1 mt-4 font-semibold">
                      {t(($) => $.workbench.links)}
                    </h4>
                    <AppLink
                      href={paths.projectRequirement(issue.project_id, issue.id)}
                      className="block text-center text-muted-foreground hover:text-foreground"
                    >
                      {t(($) => $.workbench.project_detail)} →
                    </AppLink>
                  </>
                )}
              </aside>
            </div>
          </div>
        ) : (
          <SheetHeader className="relative z-0 flex-row items-center p-4 pr-12">
            <SheetTitle>{t(($) => $.drawer.loading)}</SheetTitle>
          </SheetHeader>
        )}
        <SheetClose
          aria-label={t(($) => $.workbench.close)}
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              data-testid="workbench-close"
              className="absolute top-3 right-3 z-[100] pointer-events-auto"
            />
          }
        >
          <X className="size-4" />
          <span className="sr-only">{t(($) => $.workbench.close)}</span>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

function WorkbenchRoster({
  issueId,
  roles,
}: {
  issueId: string;
  roles: RoleAssignment[];
}) {
  const qc = useQueryClient();
  const { t } = useT("calendar");
  const [entries, setEntries] = useState(roles);
  const { data: playbooks } = useQuery(issueRolePlaybooksOptions(issueId));

  useEffect(() => {
    setEntries(roles);
  }, [roles]);

  const save = async (next: RoleAssignment[]) => {
    setEntries(next);
    try {
      await api.replaceIssueRoleAssignments(issueId, toRosterPutBody(next));
      await qc.invalidateQueries({ queryKey: issueKeys.issueRoles(issueId) });
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.workbench.roster_save_failed),
      );
    }
  };

  return (
    <div className="space-y-1">
      {!hasEnabledRole(entries, "pm") && (
        <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          {t(($) => $.workbench.roster_hint)}
        </p>
      )}
      <RoleStrip
        entries={entries}
        onChange={(next) => void save(next)}
        className="flex-col"
        playbooks={playbooks}
        onPlaybookChange={(role, override) => {
          if (!playbooks) return;
          void (async () => {
            try {
              const next = withOverride(playbooks, role, override);
              await api.replaceIssueRolePlaybooks(issueId, next.overrides);
              await qc.invalidateQueries({
                queryKey: issueKeys.issueRolePlaybooks(issueId),
              });
            } catch (err) {
              toast.error(
                err instanceof Error && err.message
                  ? err.message
                  : t(($) => $.workbench.playbook_save_failed),
              );
            }
          })();
        }}
      />
    </div>
  );
}
