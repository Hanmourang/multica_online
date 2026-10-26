"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  type CreateSprintRequest,
  type Sprint,
  type SprintStatus,
  type UpdateSprintRequest,
} from "@multica/core/types";
import { projectSprintsOptions } from "@multica/core/sprints/queries";
import {
  useCompleteSprint,
  useCreateSprint,
  useDeleteSprint,
  useReopenSprint,
  useStartSprint,
  useUpdateSprint,
} from "@multica/core/sprints/mutations";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useT } from "../../../i18n";
import { QueryLoading } from "../archive/query-states";
import { formatRange, sprintErrorText, statusStyles } from "./sprint-shared";
import { SprintSidebar } from "./sprint-sidebar";
import {
  SprintDetail,
  SprintDetailPlaceholder,
  type SprintTransitionKind,
} from "./sprint-detail";

/**
 * 迭代管理 TAB（对标 CoCo workflows/迭代资产，spec 02_迭代模块.md §E3 +
 * CoCo 迭代页 URL 的双栏形态）。
 *
 * 编排层：左侧 SprintSidebar（搜索 + 状态过滤 + 迭代卡片流）+ 右侧时间盒泳道
 * 与 SprintDetail（迁移、进度、成员与待办池）。选中项可由父容器用 `?sprint=`
 * 深链受控带入，点击卡片时回调出去写回 URL；无深链时本地持有并默认落在第一条
 * （与 CoCo 进页面即选中首个迭代一致）。状态迁移全部走后端 CAS，409 映射到
 * errors.*。Feature-flag 门控在容器侧完成（flag off 时本 TAB 不渲染）。
 */
export function SprintTab({
  projectId,
  selectedSprintId = null,
  onSelectSprint,
}: {
  projectId: string;
  /** `?sprint=` 深链带入的选中项；与上次不同即覆盖本地选择。 */
  selectedSprintId?: string | null;
  /** 选中变化回调，父容器用它把 `?sprint=` replace 进 URL。 */
  onSelectSprint?: (sprintId: string) => void;
}) {
  const { t } = useT("sprints");
  const wsId = useWorkspaceId();

  const [statusFilter, setStatusFilter] = useState<SprintStatus | null>(null);
  const [formTarget, setFormTarget] = useState<{ mode: "create" } | { mode: "edit"; sprint: Sprint } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Sprint | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedSprintId);
  const [seededFrom, setSeededFrom] = useState(selectedSprintId);

  const listQuery = useQuery(
    projectSprintsOptions(wsId, projectId, statusFilter ?? undefined),
  );
  const sprints = useMemo(() => listQuery.data?.sprints ?? [], [listQuery.data]);

  // 渲染期同步 state（避免 useEffect 多闪一帧）：深链变化覆盖本地选择。
  if (selectedSprintId !== seededFrom) {
    setSeededFrom(selectedSprintId);
    setSelectedId(selectedSprintId);
  }

  // 选中项因状态过滤/删除不在结果集时退回第一条（对齐 CoCo 进页面即选中首个
  // 迭代），而不是在右侧留一片空白。
  const activeSprint =
    sprints.find((sprint) => sprint.id === selectedId) ?? sprints[0] ?? null;
  const selectedIdForView = activeSprint?.id ?? null;

  const handleSelect = (sprintId: string) => {
    setSelectedId(sprintId);
    onSelectSprint?.(sprintId);
  };

  const startMutation = useStartSprint(projectId);
  const completeMutation = useCompleteSprint(projectId);
  const reopenMutation = useReopenSprint(projectId);
  const deleteMutation = useDeleteSprint(projectId);

  const runTransition = async (kind: SprintTransitionKind, sprint: Sprint) => {
    const mutation = { start: startMutation, complete: completeMutation, reopen: reopenMutation }[kind];
    try {
      await mutation.mutateAsync(sprint.id);
      toast.success({ start: t(($) => $.toast.started), complete: t(($) => $.toast.completed), reopen: t(($) => $.toast.reopened) }[kind]);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const invalidState = {
        start: t(($) => $.errors.not_planned),
        complete: t(($) => $.errors.not_active),
        reopen: t(($) => $.errors.not_completed),
      }[kind];
      const fallback = {
        start: t(($) => $.errors.start_failed),
        complete: t(($) => $.errors.complete_failed),
        reopen: t(($) => $.errors.reopen_failed),
      }[kind];
      toast.error(sprintErrorText(code, { fallback, invalidState }));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success(t(($) => $.toast.deleted));
    } catch {
      toast.error(t(($) => $.errors.delete_failed));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row" data-testid="sprint-tab">
      <SprintSidebar
        sprints={sprints}
        total={listQuery.data?.total ?? 0}
        selectedId={selectedIdForView}
        onSelect={handleSelect}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        isPending={listQuery.isPending}
        isError={listQuery.isError}
        onRetry={() => void listQuery.refetch()}
        onCreate={() => setFormTarget({ mode: "create" })}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <SprintTimeline
          sprints={sprints}
          selectedId={selectedIdForView}
          onSelect={handleSelect}
        />

        {listQuery.isPending ? (
          <QueryLoading rows={3} />
        ) : listQuery.isError ? null : activeSprint ? (
          <SprintDetail
            projectId={projectId}
            sprint={activeSprint}
            busy={
              (startMutation.isPending && startMutation.variables === activeSprint.id) ||
              (completeMutation.isPending && completeMutation.variables === activeSprint.id) ||
              (reopenMutation.isPending && reopenMutation.variables === activeSprint.id)
            }
            onEdit={() => setFormTarget({ mode: "edit", sprint: activeSprint })}
            onDelete={() => setDeleteTarget(activeSprint)}
            onTransition={(kind) => void runTransition(kind, activeSprint)}
          />
        ) : (
          <SprintDetailPlaceholder />
        )}
      </div>

      <SprintFormDialog
        projectId={projectId}
        target={formTarget}
        onOpenChange={(open) => !open && setFormTarget(null)}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.delete_confirm.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.delete_confirm.desc)}
              {deleteTarget ? (
                <span className="mt-1 block font-medium text-foreground">{deleteTarget.name}</span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.delete_confirm.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {t(($) => $.delete_confirm.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * 时间盒泳道：每迭代一行，按 start/end 在全局时间窗内画条（对标 CoCo 迭代
 * 甘特视图的最小实现；未排期或单端日期的迭代只画可得区间）。行本身可点，
 * 与侧边栏共享同一选中态——泳道当概览、侧栏当导航，两者互相同步。
 */
function SprintTimeline({
  sprints,
  selectedId,
  onSelect,
}: {
  sprints: Sprint[];
  selectedId: string | null;
  onSelect: (sprintId: string) => void;
}) {
  const { t } = useT("sprints");
  const scheduled = sprints.filter((s) => s.start_date || s.end_date);
  if (scheduled.length === 0) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const min = Math.min(...scheduled.map((s) => parse(s.start_date ?? s.end_date!)));
  const max = Math.max(...scheduled.map((s) => parse(s.end_date ?? s.start_date!)));
  const span = Math.max(max - min, dayMs);

  return (
    <div className="rounded-lg border border-surface-border p-3" data-testid="sprint-timeline">
      <div className="mb-2 text-caption font-medium">{t(($) => $.columns.dates)}</div>
      <div className="flex flex-col gap-1">
        {scheduled.map((sprint) => {
          const start = parse(sprint.start_date ?? sprint.end_date!);
          const end = parse(sprint.end_date ?? sprint.start_date!);
          const left = ((start - min) / span) * 100;
          const width = Math.max(((end - start + dayMs) / span) * 100, 2);
          const active = sprint.id === selectedId;
          return (
            <button
              key={sprint.id}
              type="button"
              onClick={() => onSelect(sprint.id)}
              aria-current={active ? "true" : undefined}
              data-testid={`sprint-timeline-${sprint.id}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors",
                active ? "bg-surface-selected" : "hover:bg-surface-hover",
              )}
            >
              <span className="w-36 shrink-0 truncate text-micro" title={sprint.name}>
                {sprint.name}
              </span>
              <div className="relative h-3 min-w-0 flex-1 rounded bg-muted/50">
                <div
                  className={`absolute top-0 h-full rounded ${statusStyles[sprint.status]}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={formatRange(sprint.start_date, sprint.end_date) ?? undefined}
                />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 新建 / 编辑迭代对话框。日期为 "YYYY-MM-DD"；capacity 空 = 不设容量。 */
function SprintFormDialog({
  projectId,
  target,
  onOpenChange,
}: {
  projectId: string;
  target: { mode: "create" } | { mode: "edit"; sprint: Sprint } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("sprints");
  const sprint = target?.mode === "edit" ? target.sprint : null;

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [capacity, setCapacity] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const createMutation = useCreateSprint(projectId);
  const updateMutation = useUpdateSprint(projectId);

  // 打开时回填/重置（渲染期同步 state，避免 useEffect 闪一帧旧值）。
  const seedKey = target ? `${target.mode}-${sprint?.id ?? "new"}` : null;
  if (target && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setName(sprint?.name ?? "");
    setGoal(sprint?.goal ?? "");
    setStartDate(sprint?.start_date ?? "");
    setEndDate(sprint?.end_date ?? "");
    setCapacity(sprint?.capacity != null ? String(sprint.capacity) : "");
  }

  const nameError =
    name.trim().length === 0 || name.trim().length > 80 ? t(($) => $.errors.name_required) : null;
  const dateError =
    startDate && endDate && endDate < startDate ? t(($) => $.errors.date_order) : null;
  const capacityValue = capacity.trim() ? Number(capacity.trim()) : null;
  const capacityError =
    capacity.trim() && (!Number.isFinite(capacityValue) || (capacityValue as number) <= 0)
      ? t(($) => $.form.capacity_label)
      : null;
  const canSubmit = !nameError && !dateError && !capacityError;

  const submit = async () => {
    if (!target || !canSubmit) return;
    const shared = {
      name: name.trim(),
      goal: goal.trim(),
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      capacity: capacityValue,
    } satisfies CreateSprintRequest & UpdateSprintRequest;
    try {
      if (target.mode === "create") {
        await createMutation.mutateAsync(shared);
        toast.success(t(($) => $.toast.created));
      } else {
        await updateMutation.mutateAsync({ ...shared, sprintId: target.sprint.id });
        toast.success(t(($) => $.toast.updated));
      }
      onOpenChange(false);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const fallback =
        target.mode === "create" ? t(($) => $.errors.create_failed) : t(($) => $.errors.update_failed);
      toast.error(
        sprintErrorText(code, {
          fallback,
          invalidState: fallback,
          nameExists: t(($) => $.errors.name_exists),
        }),
      );
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "edit" ? t(($) => $.form.edit_title) : t(($) => $.form.create_title)}
          </DialogTitle>
          <DialogDescription>{t(($) => $.subtitle)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">{t(($) => $.form.name_label)}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t(($) => $.form.name_placeholder)}
              maxLength={80}
            />
            {nameError && target ? (
              <span className="text-micro text-destructive">{nameError}</span>
            ) : null}
          </label>
          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">{t(($) => $.form.goal_label)}</span>
            <Input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder={t(($) => $.form.goal_placeholder)}
            />
          </label>
          <div className="flex gap-3">
            <label className="block min-w-0 flex-1 space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.form.start_date_label)}</span>
              <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label className="block min-w-0 flex-1 space-y-1">
              <span className="text-caption text-muted-foreground">{t(($) => $.form.end_date_label)}</span>
              <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
          </div>
          {dateError ? <span className="block text-micro text-destructive">{dateError}</span> : null}
          <label className="block space-y-1">
            <span className="text-caption text-muted-foreground">{t(($) => $.form.capacity_label)}</span>
            <Input
              type="number"
              min={1}
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
              placeholder={t(($) => $.form.capacity_placeholder)}
            />
          </label>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.actions.cancel)}
          </Button>
          <Button type="button" disabled={!canSubmit || createMutation.isPending || updateMutation.isPending} onClick={() => void submit()}>
            {target?.mode === "edit" ? t(($) => $.actions.save) : t(($) => $.actions.create_submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
