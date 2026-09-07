"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, Pencil, Plus, Puzzle, Search, Unlink } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { graphModulesOptions, graphSnapshotDetailOptions } from "@multica/core/graph/queries";
import {
  useCreateProjectModule,
  useDeleteProjectModule,
  useUpdateProjectModule,
} from "@multica/core/modules";
import type { GraphModuleItem, ModuleGraphSummary } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
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
  ArchiveEmpty,
  QueryError,
  QueryLoading,
} from "../archive/query-states";

/**
 * C3 左栏：功能模块列表 + 人工管理（新建 / 重命名 / 改色 / 绑定 / 解绑 / 删除）。
 * 图谱投影字段（对象数 / 策略数）只读；人工字段走 PATCH /modules。
 */
export function ModuleListPanel() {
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot, selectedNodeId, setSelectedNodeId } =
    useGraphData();

  const [search, setSearch] = useState("");
  const [unboundOnly, setUnboundOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);

  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const detailQuery = useQuery({
    ...graphSnapshotDetailOptions(wsId, projectId),
    enabled: Boolean(bindingId),
  });
  const createModule = useCreateProjectModule(projectId);
  const updateModule = useUpdateProjectModule(projectId);
  const deleteModule = useDeleteProjectModule(projectId);

  const summaryByNodeId = useMemo(() => {
    const map = new Map<string, ModuleGraphSummary>();
    for (const row of snapshot?.module_summary ?? []) {
      map.set(row.node_id, row);
    }
    return map;
  }, [snapshot]);

  const communities = detailQuery.data?.communities ?? [];

  const rows = useMemo(() => {
    const modules = modulesQuery.data?.modules ?? [];
    const query = search.trim().toLowerCase();
    const filtered = modules.filter((module) => {
      if (unboundOnly && module.graph_node_id) return false;
      if (query && !module.name.toLowerCase().includes(query)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      const aBound = a.graph_node_id ? 0 : 1;
      const bBound = b.graph_node_id ? 0 : 1;
      return aBound - bBound;
    });
  }, [modulesQuery.data, search, unboundOnly]);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || createModule.isPending) return;
    try {
      await createModule.mutateAsync({
        name: trimmed,
        color: pickInlineColor(trimmed),
      });
      setNewName("");
      setCreating(false);
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
      setSelectedNodeId(nodeId);
      toast.success(t(($) => $.features.bind_ok));
    } catch {
      toast.error(t(($) => $.features.update_failed));
    }
  };

  const handleUnbind = async (module: GraphModuleItem) => {
    try {
      await updateModule.mutateAsync({ moduleId: module.id, graph_node_id: "" });
      if (selectedNodeId === module.graph_node_id) setSelectedNodeId(null);
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-caption font-medium text-foreground">
          {t(($) => $.features.module_list)}
        </h3>
        <span className="text-caption tabular-nums text-muted-foreground">
          {total}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-3.5" />
          {t(($) => $.features.create)}
        </Button>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(($) => $.features.module_search)}
            className="h-8 pl-8 text-caption"
            aria-label={t(($) => $.features.module_search)}
          />
        </div>
        <button
          type="button"
          aria-pressed={unboundOnly}
          onClick={() => setUnboundOnly((value) => !value)}
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-1 text-micro font-medium transition-colors",
            unboundOnly
              ? "border-primary/40 bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {t(($) => $.features.unbound_only)}
        </button>
      </div>

      {creating && (
        <form
          className="flex gap-1.5"
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
          />
          <Button size="xs" type="submit" disabled={!newName.trim()}>
            {t(($) => $.features.create)}
          </Button>
          <Button size="xs" type="button" variant="ghost" onClick={() => setCreating(false)}>
            {t(($) => $.common.close)}
          </Button>
        </form>
      )}

      {total === 0 && !creating ? (
        <ArchiveEmpty
          icon={<Puzzle className="size-5" />}
          title={t(($) => $.features.no_modules)}
          description={t(($) => $.features.no_modules_hint)}
        />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-surface-border px-3 py-6 text-center text-caption text-muted-foreground">
          {t(($) => $.common.empty)}
        </div>
      ) : (
        <ul className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
          {rows.map((module) => {
            const summary = module.graph_node_id
              ? summaryByNodeId.get(module.graph_node_id)
              : undefined;
            const selected =
              Boolean(module.graph_node_id) && selectedNodeId === module.graph_node_id;
            return (
              <li key={module.id} className="group">
                <div
                  className={cn(
                    "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                    !module.graph_node_id && "border-dashed opacity-90",
                    module.graph_node_id && !selected && "hover:bg-accent/60",
                    selected && "border-primary/50 bg-primary/5",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: module.color || "transparent" }}
                      title={t(($) => $.features.recolor)}
                      onClick={() => {
                        const idx = INLINE_COLORS.findIndex((color) => color === module.color);
                        const next =
                          INLINE_COLORS[(idx + 1) % INLINE_COLORS.length] ??
                          pickInlineColor(module.name);
                        void handleRecolor(module, next);
                      }}
                    />
                    {editingId === module.id ? (
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-caption"
                        autoFocus
                        onBlur={() => void handleRename(module)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(module);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        disabled={!module.graph_node_id}
                        aria-pressed={selected}
                        onClick={() => setSelectedNodeId(module.graph_node_id ?? null)}
                        className="min-w-0 flex-1 truncate text-left text-body font-medium"
                      >
                        {module.name}
                      </button>
                    )}
                    {!module.graph_node_id && (
                      <Badge variant="outline" className="shrink-0">
                        {t(($) => $.features.unbound_badge)}
                      </Badge>
                    )}
                    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                        title={t(($) => $.features.rename)}
                        onClick={() => {
                          setEditingId(module.id);
                          setEditName(module.name);
                        }}
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                        title={t(($) => $.features.bind)}
                        onClick={() => setBindingId(module.id)}
                      >
                        <Link2 className="size-3" />
                      </button>
                      {module.graph_node_id && (
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                          title={t(($) => $.features.unbind)}
                          onClick={() => void handleUnbind(module)}
                        >
                          <Unlink className="size-3" />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-muted-foreground">
                    {summary && (
                      <span className="tabular-nums">
                        {t(($) => $.features.obj_strategy, {
                          objects: summary.obj_count,
                          strategies: summary.strategy_count,
                        })}
                      </span>
                    )}
                    <span className="tabular-nums">
                      {t(($) => $.features.issues_count, {
                        count: module.issue_count,
                      })}
                    </span>
                    {module.graph_node_id && (
                      <span className="font-mono">
                        {module.graph_node_id.slice(0, 8)}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ml-auto text-micro text-destructive/70 hover:text-destructive"
                      onClick={() => {
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
                    <div className="mt-2 space-y-1 rounded-md border border-surface-border bg-surface p-2">
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
    </div>
  );
}
