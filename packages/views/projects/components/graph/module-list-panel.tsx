"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Link2, Palette, Pencil, Plus, Puzzle, Unlink } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  graphModulesOptions,
  graphSnapshotDetailOptions,
  projectIssuesForModulesOptions,
} from "@multica/core/graph/queries";
import {
  useCreateProjectModule,
  useDeleteProjectModule,
  useUpdateProjectModule,
} from "@multica/core/modules";
import type { GraphModuleItem } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import {
  INLINE_COLORS,
  pickInlineColor,
} from "../../../issues/components/pickers/module-picker";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import {
  communityLabel,
  issuesForModule,
  moduleHealth,
  moduleRequirements,
  moduleTasks,
  rollupTasks,
  summaryForModule,
} from "./module-feature-stats";
import {
  EMPTY_FEATURE_FILTERS,
  resolveFeatureFilters,
  type FeatureModuleFilters,
} from "./feature-modules-model";
import {
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";

/**
 * C3 左栏：功能模块列表 + 人工管理（新建 / 重命名 / 改色 / 绑定 / 解绑 / 删除）。
 * 图谱投影字段（对象数 / 策略数）只读；人工字段走 PATCH /modules。
 *
 * 宽度默认 216px（可经 onCollapse 收成 44px 竖条），行内度量按窄栏收紧。
 */
export function ModuleListPanel({
  filters,
  creating = false,
  onCreatingChange,
  onCollapse,
}: {
  filters?: FeatureModuleFilters;
  creating?: boolean;
  onCreatingChange?: (value: boolean) => void;
  onCollapse?: () => void;
}) {
  const resolvedFilters = resolveFeatureFilters(filters ?? EMPTY_FEATURE_FILTERS);
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot, selectedNodeId, selectedModuleId, setSelectedNodeId, setSelectedModuleId } =
    useGraphData();

  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(INLINE_COLORS[5]!);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);

  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const issuesQuery = useQuery(projectIssuesForModulesOptions(wsId, projectId));
  const detailQuery = useQuery({
    ...graphSnapshotDetailOptions(wsId, projectId),
    enabled: Boolean(bindingId),
  });
  const createModule = useCreateProjectModule(projectId);
  const updateModule = useUpdateProjectModule(projectId);
  const deleteModule = useDeleteProjectModule(projectId);

  const summaries = snapshot?.module_summary ?? [];
  const communities = detailQuery.data?.communities ?? [];

  /** 选中以模块 UUID 为准；node id 只作图谱邻域的附带选择（未绑定传 null）。 */
  const selectModule = useCallback(
    (module: GraphModuleItem) => {
      setSelectedModuleId(module.id);
      setSelectedNodeId(module.graph_node_id ?? null);
    },
    [setSelectedModuleId, setSelectedNodeId],
  );

  useEffect(() => {
    if (selectedModuleId || selectedNodeId) return;
    // 默认选中第一个模块：优先已绑定图谱的，没有就取第一个未绑定的 ——
    // 否则模块全是未绑定时右栏永远是空态，原型与说明都无从入口。
    const modules = modulesQuery.data?.modules ?? [];
    const first = modules.find((module) => module.graph_node_id) ?? modules[0];
    if (first) selectModule(first);
  }, [modulesQuery.data, selectedModuleId, selectedNodeId, selectModule]);

  const rows = useMemo(() => {
    const modules = modulesQuery.data?.modules ?? [];
    const query = resolvedFilters.search.trim().toLowerCase();
    const filtered = modules.filter((module) => {
      if (resolvedFilters.unboundOnly && module.graph_node_id) return false;
      if (query && !module.name.toLowerCase().includes(query)) return false;
      if (resolvedFilters.bizKind !== "all") {
        const summary = summaryForModule(summaries, module.graph_node_id, module.name);
        if ((summary?.biz_kind ?? "") !== resolvedFilters.bizKind) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const aBound = a.graph_node_id ? 0 : 1;
      const bBound = b.graph_node_id ? 0 : 1;
      return aBound - bBound;
    });
  }, [modulesQuery.data, resolvedFilters, summaries]);

  useEffect(() => {
    if (!createdId) return;
    document
      .querySelector(`[data-module-id="${CSS.escape(createdId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [createdId, rows]);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || createModule.isPending) return;
    try {
      const created = await createModule.mutateAsync({
        name: trimmed,
        color: newColor || pickInlineColor(trimmed),
      });
      setNewName("");
      setNewColor(INLINE_COLORS[5]!);
      setCreatedId(created.id);
      onCreatingChange?.(false);
      toast.success(t(($) => $.features.create_ok));
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t(($) => $.features.duplicate_name)
          : t(($) => $.features.create_failed),
      );
    }
  };

  const handleRename = async (module: GraphModuleItem) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === module.name) {
      setEditingId(null);
      return;
    }
    try {
      await updateModule.mutateAsync({ moduleId: module.id, name: trimmed });
      setEditingId(null);
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t(($) => $.features.duplicate_name)
          : t(($) => $.features.update_failed),
      );
    }
  };

  const handleRecolor = async (module: GraphModuleItem, color: string) => {
    if (color === module.color) return;
    try {
      await updateModule.mutateAsync({ moduleId: module.id, color });
    } catch {
      toast.error(t(($) => $.features.update_failed));
    }
  };

  const handleBind = async (module: GraphModuleItem, nodeId: string) => {
    try {
      await updateModule.mutateAsync({
        moduleId: module.id,
        graph_node_id: nodeId,
      });
      setBindingId(null);
      setSelectedModuleId(module.id);
      setSelectedNodeId(nodeId);
      toast.success(t(($) => $.features.bind_ok));
    } catch {
      toast.error(t(($) => $.features.update_failed));
    }
  };

  const handleUnbind = async (module: GraphModuleItem) => {
    try {
      await updateModule.mutateAsync({ moduleId: module.id, graph_node_id: "" });
      // 解绑只丢图谱桥接，不丢选中 —— 模块本身还能写原型与说明。
      setSelectedNodeId(null);
      toast.success(t(($) => $.features.unbind_ok));
    } catch {
      toast.error(t(($) => $.features.update_failed));
    }
  };

  if (modulesQuery.isPending) {
    return <QueryLoading rows={6} />;
  }
  if (modulesQuery.isError) {
    return <QueryError onRetry={() => void modulesQuery.refetch()} />;
  }

  const total = modulesQuery.data.total;
  const projectIssues = issuesQuery.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5 px-0.5">
        <h3 className="text-[9.5px] font-bold tracking-wide text-muted-foreground">
          {t(($) => $.features.module_list)}
        </h3>
        <span className="ml-auto text-[10px] font-semibold tabular-nums text-muted-foreground">
          {total}
        </span>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title={t(($) => $.features.inspector_collapse)}
            aria-label={t(($) => $.features.inspector_collapse)}
            className="-mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      {creating && (
        <form
          className="space-y-2 rounded-[9px] border border-primary/30 bg-primary/5 p-2.5"
          data-testid="module-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t(($) => $.features.create_placeholder)}
            className="h-8 text-caption"
            autoFocus
            aria-label={t(($) => $.features.create)}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {INLINE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={newColor === color}
                onClick={() => setNewColor(color)}
                className={cn(
                  "size-4 rounded-full border border-black/10",
                  newColor === color && "ring-2 ring-primary ring-offset-1",
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <p className="text-micro text-muted-foreground">{t(($) => $.features.create_hint)}</p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              size="xs"
              type="button"
              variant="ghost"
              onClick={() => onCreatingChange?.(false)}
            >
              {t(($) => $.common.close)}
            </Button>
            <Button size="xs" type="submit" disabled={!newName.trim() || createModule.isPending}>
              {t(($) => $.features.create_submit)}
            </Button>
          </div>
        </form>
      )}

      {total === 0 && !creating ? (
        <div className="space-y-2">
          <ArchiveEmpty
            icon={<Puzzle className="size-5" />}
            title={t(($) => $.features.no_modules)}
            description={t(($) => $.features.no_modules_hint)}
          />
          <Button
            type="button"
            size="xs"
            className="w-full"
            onClick={() => onCreatingChange?.(true)}
          >
            {t(($) => $.features.create)}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-border px-3 py-6 text-center text-caption text-muted-foreground">
          {t(($) => $.common.empty)}
        </div>
      ) : (
        <ul
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1"
          role="listbox"
          aria-label={t(($) => $.features.module_list)}
        >
          {rows.map((module) => {
            const summary = summaryForModule(summaries, module.graph_node_id, module.name);
            const selected = selectedModuleId
              ? selectedModuleId === module.id
              : Boolean(module.graph_node_id) && selectedNodeId === module.graph_node_id;
            const moduleIssues = issuesForModule(projectIssues, projectId, module.id);
            const reqCount = moduleRequirements(moduleIssues).length || module.issue_count;
            const tasks = rollupTasks(moduleTasks(moduleIssues));
            const health = moduleHealth(Boolean(module.graph_node_id), moduleIssues);
            const canSelect = editingId !== module.id;
            return (
              <li key={module.id} className="group" data-module-id={module.id}>
                <div
                  role="option"
                  aria-selected={selected}
                  aria-disabled={!canSelect}
                  tabIndex={canSelect ? 0 : -1}
                  onClick={() => {
                    if (!canSelect) return;
                    selectModule(module);
                  }}
                  onKeyDown={(event) => {
                    if (!canSelect) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectModule(module);
                    }
                  }}
                  className={cn(
                    "w-full rounded-lg border bg-surface px-2 py-1.5 text-left transition-colors",
                    !module.graph_node_id && "border-dashed bg-amber-500/[0.04]",
                    canSelect && "cursor-pointer",
                    canSelect && !selected && "hover:border-primary/25 hover:bg-accent/40",
                    selected &&
                      "border-primary/40 bg-surface shadow-[inset_3px_0_0_var(--primary),0_2px_7px_rgb(15_23_42/0.06)]",
                    createdId === module.id && "border-brand shadow-[0_0_0_2px] shadow-brand/20",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-px text-[9px] font-bold",
                        module.graph_node_id
                          ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {module.graph_node_id ? t(($) => $.features.page_badge) : "?"}
                    </span>
                    {editingId === module.id ? (
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-caption"
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onBlur={() => void handleRename(module)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(module);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold">
                        {module.name}
                      </span>
                    )}
                    <span
                      className={cn("ml-auto size-[7px] shrink-0 rounded-full", healthDotClass(health))}
                      title={
                        health === "ok"
                          ? t(($) => $.features.health_ok)
                          : health === "busy"
                            ? t(($) => $.features.health_busy)
                            : health === "warn"
                              ? t(($) => $.features.health_warn)
                              : t(($) => $.features.health_unbound)
                      }
                    />
                    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                        title={t(($) => $.features.rename)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingId(module.id);
                          setEditName(module.name);
                        }}
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                        title={t(($) => $.features.recolor)}
                        onClick={(event) => {
                          event.stopPropagation();
                          const idx = INLINE_COLORS.findIndex((color) => color === module.color);
                          const next =
                            INLINE_COLORS[(idx + 1) % INLINE_COLORS.length] ??
                            pickInlineColor(module.name);
                          void handleRecolor(module, next);
                        }}
                      >
                        <Palette className="size-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                        title={t(($) => $.features.bind)}
                        onClick={(event) => {
                          event.stopPropagation();
                          setBindingId(module.id);
                        }}
                      >
                        <Link2 className="size-3" />
                      </button>
                      {module.graph_node_id && (
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                          title={t(($) => $.features.unbind)}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleUnbind(module);
                          }}
                        >
                          <Unlink className="size-3" />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="mt-1.5 flex gap-2.5 text-[9.5px] text-muted-foreground">
                    <span>
                      {t(($) => $.features.stat_objects)}{" "}
                      <b className="text-[11px] tabular-nums text-foreground">
                        {summary?.obj_count ?? 0}
                      </b>
                    </span>
                    <span>
                      {t(($) => $.features.stat_strategies)}{" "}
                      <b className="text-[11px] tabular-nums text-foreground">
                        {summary?.strategy_count ?? 0}
                      </b>
                    </span>
                    <span>
                      {t(($) => $.features.stat_requirements)}{" "}
                      <b className="text-[11px] tabular-nums text-foreground">{reqCount}</b>
                    </span>
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-[9px] text-muted-foreground",
                      !module.graph_node_id && "text-destructive",
                    )}
                  >
                    {t(($) => $.features.community_ref, {
                      id: communityLabel(module.graph_node_id ?? summary?.node_id) || "—",
                    })}
                    {module.graph_node_id
                      ? tasks.total > 0
                        ? ` · ${t(($) => $.features.task_progress, { done: tasks.done, total: tasks.total })}`
                        : summary
                          ? ` · ${t(($) => $.features.new_this_period)}`
                          : null
                      : ` · ${t(($) => $.features.unbound_hint)}`}
                    <button
                      type="button"
                      className="ml-2 hidden text-micro text-destructive hover:text-destructive group-hover:inline"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (window.confirm(t(($) => $.features.delete_confirm))) {
                          void deleteModule.mutateAsync(module.id).catch(() => {
                            toast.error(t(($) => $.features.delete_failed));
                          });
                        }
                      }}
                    >
                      {t(($) => $.features.delete)}
                    </button>
                  </div>
                  {bindingId === module.id && (
                    <div
                      className="mt-2 space-y-1 rounded-md border border-surface-border bg-surface p-2"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="text-micro text-muted-foreground">
                        {t(($) => $.features.bind_hint)}
                      </div>
                      {communities.length === 0 ? (
                        <p className="text-micro text-muted-foreground">
                          {t(($) => $.features.bind_empty)}
                        </p>
                      ) : (
                        communities.map((community) => (
                          <button
                            key={community.id}
                            type="button"
                            className="block w-full truncate rounded px-1.5 py-1 text-left text-caption hover:bg-accent"
                            onClick={() => void handleBind(module, community.id)}
                          >
                            {community.label ?? community.name}
                            <span className="ml-1 font-mono text-micro text-muted-foreground">
                              {community.id.slice(0, 8)}
                            </span>
                          </button>
                        ))
                      )}
                      <Button size="xs" variant="ghost" onClick={() => setBindingId(null)}>
                        {t(($) => $.common.close)}
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!creating && (
        <button
          type="button"
          onClick={() => onCreatingChange?.(true)}
          className="flex w-full items-start gap-2 rounded-[9px] border border-dashed border-primary/35 bg-primary/5 px-2.5 py-2 text-left hover:border-primary/55 hover:bg-primary/10"
        >
          <Plus className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          <span>
            <span className="block text-[12px] font-semibold text-primary">
              {t(($) => $.features.create)}
            </span>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              {t(($) => $.features.create_hint)}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function healthDotClass(health: ReturnType<typeof moduleHealth>): string {
  switch (health) {
    case "ok":
      return "bg-emerald-500";
    case "busy":
      return "bg-primary";
    case "warn":
      return "bg-amber-500";
    case "unbound":
      return "bg-destructive";
  }
}
