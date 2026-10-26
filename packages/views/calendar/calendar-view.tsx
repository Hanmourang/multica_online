"use client";

/**
 * CalendarView — requirement calendar (month / week). Each top-level
 * requirement occupies a single UTC day (the start_at / start_date cell;
 * due_date only supplies the tooltip clock). Colored by module, carrying
 * the derived pipeline status badge + stage progress.
 *
 * Spec: docs/superpowers/specs/2026-09-04-requirement-calendar-design.md §6/§10
 * (prototype frames 1–2). Drag rescheduling lands in Task 9 on top of this
 * renderer.
 */
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import type { Issue, ProjectModule } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import {
  useViewStore,
  useViewStoreApi,
} from "@multica/core/issues/stores/view-store-context";
import { dateOnlyToUTCDate } from "@multica/core/issues/date";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import { Button } from "@multica/ui/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AppLink } from "../navigation";
import { useWorkspacePaths } from "@multica/core/paths";
import { useLocale, useT } from "../i18n";
import { ActorAvatar } from "../common/actor-avatar";
import {
  findModuleHolder,
  findRescheduleConflict,
  formatTriggerLabel,
  parseStageProgress,
  PIPELINE_STATUS_LEGEND,
  showsTriggerLabel,
  suggestFreeWindow,
} from "./calendar-helpers";
import { ProgressRing } from "../issues/components/progress-ring";

// ---------------------------------------------------------------------------
// Date utilities — UTC-day aligned, mirroring gantt-view so a minute-level
// ISO string maps to exactly one calendar cell.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS_PER_DAY);
}

function isWeekendUTC(d: Date): boolean {
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6;
}

function sameDayUTC(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function dayKey(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** Monday-first offset of a UTC day within its week (Mon=0 … Sun=6). */
function mondayFirstOffset(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** Month grid: Monday of the first week's row through Sunday of the last. */
function monthGridDays(anchor: Date): Date[] {
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const gridStart = addDays(first, -mondayFirstOffset(first));
  const last = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  const gridEnd = addDays(last, 6 - mondayFirstOffset(last));
  const days: Date[] = [];
  for (let d = gridStart; d.getTime() <= gridEnd.getTime(); d = addDays(d, 1)) {
    days.push(d);
  }
  return days;
}

/** Week grid: the anchor's Monday through Sunday. */
function weekGridDays(anchor: Date): Date[] {
  const monday = addDays(startOfDayUTC(anchor), -mondayFirstOffset(anchor));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** HH:mm of a full ISO timestamp, in UTC — the same frame the cells floor to. */
function formatMinuteUTC(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Requirement spans
// ---------------------------------------------------------------------------

interface RequirementSpan {
  issue: Issue;
  start: Date;
  end: Date;
}

/**
 * Calendar cells are same-day: start_at wins over start_date, then due_date.
 * A later due_date must not paint extra cells — stale multi-day rows still
 * render as one block until the next reschedule writes due_date back.
 */
function requirementSpan(issue: Issue): RequirementSpan | null {
  const day = dateOnlyToUTCDate(
    issue.start_at ?? issue.start_date ?? issue.due_date ?? null,
  );
  if (!day) return null;
  return { issue, start: day, end: day };
}

type Segment = "start" | "mid" | "end";

interface DayBlock {
  span: RequirementSpan;
  segment: Segment;
}

// ---------------------------------------------------------------------------
// Derived pipeline status → block marker (spec §6; labels arrive as Chinese
// projection strings from the list endpoint).
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
  未拆解: "○",
  原型待确认: "🎨",
  拆解待确认: "⚠",
  待触发: "⏱",
  执行中: "▶",
  等待模块释放: "🔒",
  验收中: "🧪",
  已完成: "✅",
  已取消: "—",
  验收失败: "✗",
};

const STATUS_TONE: Record<string, string> = {
  原型待确认: "text-amber-600 dark:text-amber-400",
  拆解待确认: "text-amber-600 dark:text-amber-400",
  等待模块释放: "text-muted-foreground",
  已完成: "text-emerald-600 dark:text-emerald-400",
  已取消: "text-muted-foreground",
  验收失败: "text-destructive",
};

/**
 * Reschedule lock (spec §7.2): once the pipeline has fired, the schedule is
 * owned by the run — the server rejects start_at changes with 409. These
 * derived statuses all sit at or after the trigger point, so their blocks
 * render undraggable with the reason on the title.
 */
const RESCHEDULE_LOCKED_STATUSES = new Set([
  "执行中",
  "等待模块释放",
  "验收中",
  "已完成",
  "已取消",
  "验收失败",
]);

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function CalendarView({
  issues,
  onOpenRequirement,
}: {
  issues: Issue[];
  /** 提供时色块点击走回调（抽屉），缺省保持 AppLink 跳详情页。 */
  onOpenRequirement?: (issueId: string) => void;
}) {
  const { t } = useT("issues");
  const { t: tc } = useT("calendar");
  const locale = useLocale();
  const zoom = useViewStore((s) => s.calendarZoom);
  const act = useViewStoreApi().getState();
  const paths = useWorkspacePaths();
  const wsId = useWorkspaceId();
  const updateIssue = useUpdateIssue();

  const today = useMemo(() => startOfDayUTC(new Date()), []);
  const [anchor, setAnchor] = useState(today);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const days = useMemo(
    () => (zoom === "month" ? monthGridDays(anchor) : weekGridDays(anchor)),
    [anchor, zoom],
  );

  // Module colors, aggregated across every project in scope (workspace
  // surfaces span projects — same fan-out pattern as ModuleFilterBar).
  const { data: projects } = useQuery(projectListOptions(wsId));
  const projectIds = useMemo(
    () => (projects ?? []).map((p) => p.id),
    [projects],
  );
  const moduleColorById = useQueries({
    queries: projectIds.map((id) => projectModulesOptions(wsId, id)),
    combine: (results) => {
      const map = new Map<string, string>();
      for (const query of results) {
        for (const mod of (query.data ?? []) as ProjectModule[]) {
          if (!map.has(mod.id)) map.set(mod.id, mod.color);
        }
      }
      return map;
    },
  });

  // Top-level requirements only — stage children stay out of the calendar.
  const spans = useMemo(() => {
    const out: RequirementSpan[] = [];
    for (const issue of issues) {
      if (issue.parent_issue_id) continue;
      const span = requirementSpan(issue);
      if (span) out.push(span);
    }
    // Stable ordering: earlier start first so cells stack deterministically.
    out.sort((a, b) => a.start.getTime() - b.start.getTime());
    return out;
  }, [issues]);

  const blocksByDay = useMemo(() => {
    const map = new Map<string, DayBlock[]>();
    if (days.length === 0) return map;
    const gridStart = days[0];
    const gridEnd = days[days.length - 1];
    if (!gridStart || !gridEnd) return map;
    for (const span of spans) {
      if (span.end.getTime() < gridStart.getTime() || span.start.getTime() > gridEnd.getTime()) {
        continue;
      }
      const from = span.start.getTime() < gridStart.getTime() ? gridStart : span.start;
      const to = span.end.getTime() > gridEnd.getTime() ? gridEnd : span.end;
      for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) {
        const segment: Segment = sameDayUTC(d, span.start)
          ? "start"
          : sameDayUTC(d, span.end)
            ? "end"
            : "mid";
        const key = dayKey(d);
        const list = map.get(key);
        const block: DayBlock = { span, segment };
        if (list) list.push(block);
        else map.set(key, [block]);
      }
    }
    return map;
  }, [spans, days]);

  const dowLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        // 2026-09-14 is a Monday — any Monday-anchored week works.
        new Intl.DateTimeFormat(locale, {
          weekday: "short",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2026, 8, 14 + i))),
      ),
    [locale],
  );

  const title = useMemo(() => {
    if (zoom === "month") {
      return new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(anchor);
    }
    const first = days[0];
    const last = days[days.length - 1];
    if (!first || !last) return "";
    const fmt = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const year = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      timeZone: "UTC",
    }).format(last);
    return `${fmt.format(first)} – ${fmt.format(last)}, ${year}`;
  }, [anchor, zoom, days, locale]);

  const shiftAnchor = (direction: -1 | 1) => {
    setAnchor((current) =>
      zoom === "month"
        ? new Date(
            Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + direction, 1),
          )
        : addDays(current, direction * 7),
    );
  };

  /**
   * Drop onto a day cell: move start_at (minute kept) and force due_date to
   * that same UTC day so a stale multi-day row cannot be written back.
   * Trigger toast is optimistic; the server still 409s after fire (spec §7.2).
   */
  const handleDrop = (day: Date, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverKey(null);
    const id = e.dataTransfer.getData("text/plain");
    const span = spans.find((s) => s.issue.id === id);
    if (!span) return;
    const offset = Math.round(
      (startOfDayUTC(day).getTime() - span.start.getTime()) / MS_PER_DAY,
    );
    if (offset === 0) return;
    const issue = span.issue;
    const nextStart = addDays(span.start, offset);
    const payload: {
      id: string;
      start_at?: string;
      start_date?: string;
      due_date?: string;
    } = { id, due_date: dayKey(nextStart) };
    if (issue.start_at) {
      const instant = new Date(issue.start_at);
      if (!Number.isNaN(instant.getTime())) {
        payload.start_at = new Date(
          instant.getTime() + offset * MS_PER_DAY,
        ).toISOString();
      }
    } else if (issue.start_date) {
      const d = dateOnlyToUTCDate(issue.start_date);
      if (d) payload.start_date = dayKey(addDays(d, offset));
    }
    const conflict = findRescheduleConflict(issues, issue, nextStart, nextStart);
    if (conflict) {
      const free = suggestFreeWindow(issues, issue, 0);
      toast.error(
        t(($) => $.calendar.reschedule_rejected, {
          n: conflict.number,
          title: conflict.title,
          start: free ? dayKey(free.start) : "—",
          end: free ? dayKey(free.end) : "—",
        }),
      );
      setDraggingId(null);
      return;
    }
    const previous = {
      id,
      start_at: issue.start_at ?? undefined,
      start_date: issue.start_date ?? undefined,
      due_date: issue.due_date ?? undefined,
    };
    updateIssue.mutate(payload);
    toast.success(t(($) => $.calendar.rescheduled), {
      duration: 5000,
      action: {
        label: t(($) => $.calendar.reschedule_undo),
        onClick: () => updateIssue.mutate(previous),
      },
    });
    setDraggingId(null);
  };

  const dragPreview = useMemo(() => {
    if (!draggingId || !dragOverKey) return null;
    const span = spans.find((s) => s.issue.id === draggingId);
    if (!span) return null;
    return `${dayKey(span.start)} → ${dragOverKey}`;
  }, [draggingId, dragOverKey, spans]);

  const dropConflict = useMemo(() => {
    if (!draggingId || !dragOverKey) return null;
    const span = spans.find((s) => s.issue.id === draggingId);
    if (!span) return null;
    const [y, m, d] = dragOverKey.split("-").map(Number);
    if (!y || !m || !d) return null;
    const day = new Date(Date.UTC(y, m - 1, d));
    const offset = Math.round(
      (startOfDayUTC(day).getTime() - span.start.getTime()) / MS_PER_DAY,
    );
    return findRescheduleConflict(
      issues,
      span.issue,
      addDays(span.start, offset),
      addDays(span.end, offset),
    );
  }, [draggingId, dragOverKey, spans, issues]);

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view">
      {/* Toolbar: prev / next / today + period title + zoom switch. */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t(($) => $.calendar.prev_aria)}
          onClick={() => shiftAnchor(-1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t(($) => $.calendar.next_aria)}
          onClick={() => shiftAnchor(1)}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAnchor(today)}>
          {t(($) => $.calendar.today)}
        </Button>
        <h2 className="ml-1 text-body font-medium">{title}</h2>
        {dragPreview && (
          <span
            data-testid="calendar-drag-preview"
            className="ml-2 rounded bg-popover px-1.5 py-0.5 text-caption text-muted-foreground shadow-sm"
          >
            {dragPreview}
          </span>
        )}
        <div className="ml-auto flex items-center rounded-md border border-border p-0.5">
          {(["week", "month"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              data-testid={`calendar-zoom-${mode}`}
              aria-pressed={zoom === mode}
              onClick={() => act.setCalendarZoom(mode)}
              className={cn(
                "rounded px-2 py-0.5 text-caption",
                zoom === mode
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {t(($) => $.calendar[mode])}
            </button>
          ))}
        </div>
      </div>

      {/* Weekday header (Monday-first). */}
      <div className="grid grid-cols-7 border-y border-border px-0 text-center">
        {dowLabels.map((label, i) => (
          <div
            key={label}
            className={cn(
              "py-1 text-caption text-muted-foreground",
              i >= 5 && "text-muted-foreground",
            )}
          >
            {label}
          </div>
        ))}
      </div>

      {/* Day grid. */}
      <div className="grid flex-1 auto-rows-fr grid-cols-7 overflow-y-auto">
        {days.map((day) => {
          const key = dayKey(day);
          const outOfMonth =
            zoom === "month" && day.getUTCMonth() !== anchor.getUTCMonth();
          return (
            <div
              key={key}
              data-testid={`cal-cell-${key}`}
              data-weekend={isWeekendUTC(day) ? "true" : "false"}
              data-out={outOfMonth ? "true" : "false"}
              data-today={sameDayUTC(day, today) ? "true" : "false"}
                  data-drag-over={dragOverKey === key ? "true" : "false"}
                  data-drag-conflict={
                    dragOverKey === key && dropConflict ? "true" : "false"
                  }
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverKey !== key) setDragOverKey(key);
              }}
              onDragLeave={() =>
                setDragOverKey((current) => (current === key ? null : current))
              }
              onDrop={(e) => handleDrop(day, e)}
              className={cn(
                "relative flex min-h-[72px] flex-col gap-0.5 border-b border-r border-border/60 px-1 pb-1 pt-0.5",
                isWeekendUTC(day) && "bg-muted/40",
                outOfMonth && "bg-muted/20",
                sameDayUTC(day, today) && "bg-primary/5",
                dragOverKey === key &&
                  (dropConflict
                    ? "ring-2 ring-inset ring-destructive"
                    : "ring-2 ring-inset ring-primary/50"),
              )}
            >
              <span
                className={cn(
                  "self-start text-caption",
                  outOfMonth
                    ? "text-faint-foreground"
                    : "text-muted-foreground",
                  sameDayUTC(day, today) &&
                    "flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground",
                )}
              >
                {day.getUTCDate()}
              </span>
              {(blocksByDay.get(key) ?? []).map(({ span, segment }) => (
                <RequirementBlock
                  key={span.issue.id}
                  span={span}
                  day={day}
                  segment={segment}
                  color={
                    (span.issue.module_id &&
                      moduleColorById?.get?.(span.issue.module_id)) ||
                    undefined
                  }
                  href={paths.issueDetail(span.issue.id)}
                  onOpen={onOpenRequirement}
                  holder={findModuleHolder(issues, span.issue)}
                  week={zoom === "week"}
                  dimmed={
                    draggingId === span.issue.id ||
                    span.issue.requirement_status === "等待模块释放"
                  }
                  onDragBegin={() => setDraggingId(span.issue.id)}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverKey(null);
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div
        data-testid="calendar-legend"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[10.5px] text-muted-foreground"
      >
        <span>{tc(($) => $.page.legend_label)}</span>
        {PIPELINE_STATUS_LEGEND.map((status) => (
          <span key={status}>
            {STATUS_ICON[status] ?? "·"} {status}
          </span>
        ))}
        <span className="ml-auto">{tc(($) => $.page.click_hint)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requirement block (one day segment of a span)
// ---------------------------------------------------------------------------

function RequirementBlock({
  span,
  day,
  segment,
  color,
  href,
  onOpen,
  holder,
  week,
  dimmed,
  onDragBegin,
  onDragEnd,
}: {
  span: RequirementSpan;
  day: Date;
  segment: Segment;
  color?: string;
  href: string;
  /** 提供时拦截点击（preventDefault）走回调；href 保留供右键新标签打开。 */
  onOpen?: (issueId: string) => void;
  holder: Issue | null;
  week: boolean;
  dimmed: boolean;
  onDragBegin: () => void;
  onDragEnd: () => void;
}) {
  const { t } = useT("issues");
  const { issue } = span;
  const status = issue.requirement_status ?? "";
  const icon = STATUS_ICON[status] ?? "";
  const tone = STATUS_TONE[status] ?? "";
  const progress = issue.stage_progress || "";
  const parsedProgress = parseStageProgress(progress);
  const rescheduleLocked = RESCHEDULE_LOCKED_STATUSES.has(status);
  const triggerLabel =
    segment === "start" && showsTriggerLabel(issue)
      ? formatTriggerLabel(issue.start_at)
      : "";
  const heldBy =
    status === "等待模块释放" && holder
      ? t(($) => $.calendar.held_by, { n: holder.number, title: holder.title })
      : "";

  const startMinute = formatMinuteUTC(issue.start_at ?? issue.start_date);
  const endMinute = formatMinuteUTC(issue.due_date);
  const tooltipRange =
    startMinute || endMinute
      ? `${dayKey(span.start)}${startMinute ? ` ${startMinute}` : ""} → ${dayKey(span.end)}${endMinute ? ` ${endMinute}` : ""}`
      : `${dayKey(span.start)} → ${dayKey(span.end)}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <AppLink
            href={href}
            className="block min-w-0"
            onClick={
              onOpen
                ? (e) => {
                    // cmd/ctrl/shift 交回 AppLink（新标签/新窗口）；alt 同样
                    // 放行（AppLink 原地 push，与未提供 onOpen 时一致）。
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    onOpen(issue.id);
                  }
                : undefined
            }
          >
            <div
              data-testid={`req-block-${issue.id}-${dayKey(day)}`}
              data-segment={segment}
              draggable={!rescheduleLocked}
              title={
                rescheduleLocked
                  ? t(($) => $.calendar.reschedule_locked)
                  : undefined
              }
              onDragStart={
                rescheduleLocked
                  ? undefined
                  : (e) => {
                      e.dataTransfer.setData("text/plain", issue.id);
                      e.dataTransfer.effectAllowed = "move";
                      onDragBegin();
                    }
              }
              onDragEnd={onDragEnd}
              className={cn(
                "relative flex min-w-0 gap-1 border-l-2 px-1 text-2xs",
                week && segment === "start"
                  ? "h-auto min-h-10 flex-col items-stretch py-1"
                  : "h-5 items-center",
                segment === "start" && "rounded-l-sm",
                segment === "end" && "rounded-r-sm",
                segment === "mid" && "border-l-0",
                dimmed && "opacity-40",
                color ? "" : "border-primary/45 bg-primary/10",
              )}
              style={
                color
                  ? { backgroundColor: `${color}26`, borderLeftColor: color }
                  : undefined
              }
            >
              {segment === "start" ? (
                week ? (
                  <>
                    <div className="flex min-w-0 items-center gap-1">
                      <span className={cn("shrink-0", tone)}>{icon}</span>
                      <span className="min-w-0 truncate font-medium">
                        {issue.identifier} {issue.title}
                      </span>
                      {issue.assignee_id && issue.assignee_type && (
                        <span data-testid={`req-role-${issue.id}`} className="ml-auto shrink-0">
                          <ActorAvatar
                            actorType={issue.assignee_type}
                            actorId={issue.assignee_id}
                            size="xs"
                          />
                        </span>
                      )}
                    </div>
                    <div className={cn("flex items-center gap-1 text-muted-foreground", tone)}>
                      <span>
                        {status}
                      </span>
                      {triggerLabel ? (
                        <span data-testid={`req-trigger-${issue.id}`}>{triggerLabel}</span>
                      ) : null}
                      {parsedProgress && (
                        <span className="ml-auto">{progress}</span>
                      )}
                    </div>
                    {parsedProgress && (
                      <div className="h-1 overflow-hidden rounded-full bg-black/10">
                        <div
                          className="h-full bg-current opacity-60"
                          style={{
                            width: `${Math.round((parsedProgress.done / parsedProgress.total) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                <>
                  {issue.assignee_id && issue.assignee_type && (
                    <span data-testid={`req-role-${issue.id}`} className="shrink-0">
                      <ActorAvatar
                        actorType={issue.assignee_type}
                        actorId={issue.assignee_id}
                        size="xs"
                      />
                    </span>
                  )}
                  <span className={cn("shrink-0", tone)}>{icon}</span>
                  <span className="min-w-0 truncate font-medium">
                    {issue.identifier} {issue.title}
                  </span>
                  <span
                    className={cn(
                      "ml-auto flex shrink-0 items-center gap-0.5 text-muted-foreground",
                      tone,
                    )}
                  >
                    {parsedProgress && (
                      <ProgressRing
                        done={parsedProgress.done}
                        total={parsedProgress.total}
                      />
                    )}
                    {status}
                    {progress ? ` ${progress}` : ""}
                    {triggerLabel ? (
                      <span data-testid={`req-trigger-${issue.id}`}> {triggerLabel}</span>
                    ) : null}
                  </span>
                </>
                )
              ) : (
                <span className={cn("shrink-0", tone)}>{icon}</span>
              )}
            </div>
          </AppLink>
        }
      />
      <TooltipContent>
        {issue.identifier} · {tooltipRange}
        {heldBy ? ` · ${heldBy}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}
