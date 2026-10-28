"use client";

import { useMemo, useState } from "react";
import { CornerDownRight } from "lucide-react";
import type { IssueStatus, IssueWorkflowStep, Project, UpdateIssueRequest } from "@multica/core/types";
import { STATUS_CONFIG } from "@multica/core/issues/config";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { stepHandsOff, workflowStep } from "@multica/core/issue-workflows";
import { StatusIcon } from "../status-icon";
import { PropertyPicker, PickerItem } from "./property-picker";
import { useT } from "../../../i18n";
import { useStatusLabel } from "../../utils/status-label";
import { useIssueStatusOptions } from "../../utils/status-options";
import { stepHandlerActor, useStepHandlerLabel } from "../../../issue-workflows/step-handler";
import { WorkflowHandoffConfirmDialog } from "../../../issue-workflows/handoff-confirm-dialog";
import { ActorAvatar } from "../../../common/actor-avatar";

/** Above this many options the flat list stops being scannable. */
const SEARCH_THRESHOLD = 9;

export function StatusPicker({
  status,
  onUpdate,
  trigger: customTrigger,
  triggerRender,
  tooltip,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  align,
  projectId,
  allowedStatuses,
  issue,
}: {
  /**
   * The currently-selected status, used to check the matching row. `null`
   * means "no single current value" (e.g. a batch selection spanning several
   * statuses) — no row is checked. Single-issue callers always pass a concrete
   * status.
   */
  status: IssueStatus | null;
  onUpdate: (updates: Partial<UpdateIssueRequest>) => void;
  trigger?: React.ReactNode;
  triggerRender?: React.ReactElement;
  /** Hover tooltip naming the property; hidden while the picker is open. */
  tooltip?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  align?: "start" | "center" | "end";
  /**
   * The issue's project. When it uses a workflow, only that workflow's steps
   * are offered, in workflow order, each naming who entering it hands the
   * issue to. (MUL-7420) `null` is an issue outside any project: it offers
   * the Default workflow's statuses, and search still reaches every status.
   * (MUL-8121) Omit (`undefined`) when the surface spans projects.
   */
  projectId?: string | null;
  /**
   * Narrows the options to these keys — for a selection spanning projects,
   * the statuses every selected issue's workflow allows. Null offers all.
   */
  allowedStatuses?: ReadonlySet<string> | null;
  /**
   * The single issue being edited. With a workflow, choosing a step that
   * hands the issue off first shows the handoff confirmation for it; the
   * write carries the choice to stop the previous agent's run. (MUL-7420)
   */
  issue?: { id: string; identifier: string };
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;
  const [query, setQuery] = useState("");
  const { t } = useT("issues");
  // Every StatusPicker call site lives inside the workspace shell (issue
  // detail, table, board batch toolbar, create-issue modal), so the provider
  // is guaranteed here.
  const wsId = useWorkspaceId();
  const { categoryOf, colorOf } = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);

  // The project workflow's steps, or the catalog in canonical category order
  // without archived statuses (MUL-6243).
  const {
    options: projectOptions,
    workflow,
    project,
    defaultScope,
    catalog,
  } = useIssueStatusOptions(wsId, projectId, status);
  const allOptions = useMemo(
    () => (allowedStatuses ? projectOptions.filter((o) => allowedStatuses.has(o.key)) : projectOptions),
    [projectOptions, allowedStatuses],
  );

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    // Outside a project only the list is narrowed to Default, not what the
    // issue may take: search reaches every status. (MUL-8121)
    const pool = defaultScope ? catalog : allOptions;
    return pool.filter((o) => o.label.toLowerCase().includes(q));
  }, [allOptions, catalog, defaultScope, query]);

  const searchable = !!workflow || !!defaultScope || allOptions.length > SEARCH_THRESHOLD;
  const [pendingStatus, setPendingStatus] = useState<IssueStatus | null>(null);

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={(v) => {
          if (!v) setQuery("");
          setOpen(v);
        }}
        width={workflow || defaultScope ? "w-60" : "w-52"}
        align={align}
        triggerRender={triggerRender}
        tooltip={tooltip}
        searchable={searchable}
        searchPlaceholder={t(($) => $.filters.search_status)}
        onSearchChange={setQuery}
        header={
          workflow ? (
            <div className="truncate px-2 pb-1 pt-1.5 text-caption text-muted-foreground">
              {project
                ? t(($) => $.workflows.picker.header, { workflow: workflow.name, project: project.title })
                : workflow.name}
            </div>
          ) : defaultScope ? (
            <div className="truncate px-2 pb-1 pt-1.5 text-caption text-muted-foreground">
              {t(($) => $.workflows.picker.header_no_project, { workflow: defaultScope.name })}
            </div>
          ) : undefined
        }
        trigger={
          customTrigger ??
          (status != null ? (
            <>
              <StatusIcon
                status={status}
                category={categoryOf(status)}
                color={colorOf(status)}
                className="h-3.5 w-3.5 shrink-0"
              />
              <span className="truncate">{labelOf(status)}</span>
            </>
          ) : null)
        }
      >
        {options.map((option) => (
          <PickerItem
            key={option.key}
            selected={option.key === status}
            hoverClassName={STATUS_CONFIG[option.category].hoverBg}
            onClick={() => {
              setOpen(false);
              setQuery("");
              if (workflow && issue && option.key !== status && stepHandsOff(workflowStep(workflow, option.key))) {
                setPendingStatus(option.key);
                return;
              }
              onUpdate({ status: option.key });
            }}
          >
            <StatusIcon
              status={option.key}
              category={option.category}
              color={option.color}
              className="h-3.5 w-3.5"
            />
            <span className="min-w-12 truncate">{option.label}</span>
            {workflow && option.key !== status && (
              <StepHandoffHint step={workflowStep(workflow, option.key)} project={project} />
            )}
          </PickerItem>
        ))}
      </PropertyPicker>
      {workflow && issue && (
        <WorkflowHandoffConfirmDialog
          issue={pendingStatus ? issue : null}
          toStatus={pendingStatus ?? ""}
          onCancel={() => setPendingStatus(null)}
          onConfirm={({ stopPreviousRuns }) => {
            const next = pendingStatus;
            setPendingStatus(null);
            if (next) onUpdate({ status: next, ...(stopPreviousRuns ? { stop_previous_assignee_runs: true } : {}) });
          }}
        />
      )}
    </>
  );
}

/**
 * The avatar of whoever entering a workflow column hands the issue to; the
 * name is in the tooltip. Nothing for a column that keeps the assignee.
 * (MUL-7420)
 */
function StepHandoffHint({ step, project }: { step: IssueWorkflowStep | undefined; project: Project | null }) {
  const { t } = useT("issues");
  const handlerLabel = useStepHandlerLabel(project);
  const handler = handlerLabel(step);
  if (!handler) return null;
  const actor = stepHandlerActor(step, project);
  const text = t(($) => $.workflows.hands_off_to, { name: handler });
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-caption text-muted-foreground" title={text}>
      <span className="sr-only">{text}</span>
      <CornerDownRight aria-hidden className="size-3 shrink-0" />
      {actor ? (
        <ActorAvatar actorType={actor.type} actorId={actor.id} size="xs" profileLink={false} />
      ) : (
        <span aria-hidden className="max-w-20 truncate">{handler}</span>
      )}
    </span>
  );
}
