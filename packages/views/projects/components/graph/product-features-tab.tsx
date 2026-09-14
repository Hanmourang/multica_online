"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, LayoutGrid, List, Plus, RefreshCw, Share2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useRebridgeGraphSnapshot } from "@multica/core/graph/mutations";
import {
  graphModulesOptions,
  projectIssuesForModulesOptions,
} from "@multica/core/graph/queries";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../../i18n";
import { useGraphData } from "./graph-data-provider";
import { ScanStatusBar } from "./scan-status-bar";
import { ModuleListPanel } from "./module-list-panel";
import { ModuleDetailPanel } from "./module-detail-panel";
import { ModuleGraphView } from "./module-graph-view";
import { ModuleTableView } from "./module-table-view";
import {
  EMPTY_FEATURE_FILTERS,
  resolveFeatureFilters,
  type FeatureModuleFilters,
  type FeatureViewMode,
} from "./feature-modules-model";
import {
  communityLabel,
  issuesForModule,
  moduleRequirements,
  moduleTasks,
  rollupTasks,
  summaryForModule,
} from "./module-feature-stats";

/**
 * 画面 11 / C3：工具栏 + 三种视图。模块列表是左右分栏（左 296px 卡片，右四/五子 TAB）。
 */
export function ProductFeaturesTab() {
  const [viewMode, setViewMode] = useState<FeatureViewMode>("modules");
  const [filters, setFilters] = useState<FeatureModuleFilters>(EMPTY_FEATURE_FILTERS);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-surface-border bg-surface">
      <ProductFeaturesToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filters={filters}
        onFiltersChange={setFilters}
        creating={creating}
        onCreate={() => {
          setViewMode("modules");
          setCreating(true);
        }}
      />
      {viewMode === "modules" ? (
        <div className="flex min-h-0 flex-1 items-stretch">
          <aside className="flex w-[clamp(200px,22vw,340px)] shrink-0 flex-col overflow-hidden border-r border-surface-border bg-surface px-3 py-3">
            <ModuleListPanel
              filters={filters}
              creating={creating}
              onCreatingChange={setCreating}
            />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/15 px-4 py-3">
            <ModuleDetailPanel />
          </main>
        </div>
      ) : viewMode === "graph" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/15 p-4">
          <ModuleGraphView filters={filters} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/15 p-4">
          <ModuleTableView filters={filters} />
        </div>
      )}
    </div>
  );
}

function ProductFeaturesToolbar({
  viewMode,
  onViewModeChange,
  filters,
  onFiltersChange,
  creating = false,
  onCreate,
}: {
  viewMode: FeatureViewMode;
  onViewModeChange: (mode: FeatureViewMode) => void;
  filters?: FeatureModuleFilters;
  onFiltersChange: (next: FeatureModuleFilters) => void;
  creating?: boolean;
  onCreate: () => void;
}) {
  const resolvedFilters = resolveFeatureFilters(filters);
  const { t } = useT("archive");
  const wsId = useWorkspaceId();
  const { projectId, snapshot } = useGraphData();
  const rebridge = useRebridgeGraphSnapshot(projectId);
  const modulesQuery = useQuery(graphModulesOptions(wsId, projectId));
  const issuesQuery = useQuery(projectIssuesForModulesOptions(wsId, projectId));

  const bizKinds = useMemo(() => {
    return [
      ...new Set(
        (snapshot?.module_summary ?? [])
          .map((row) => row.biz_kind)
          .filter((kind): kind is string => Boolean(kind)),
      ),
    ];
  }, [snapshot]);
  const unboundCount = (modulesQuery.data?.modules ?? []).filter((module) => !module.graph_node_id).length;

  const handleRebridge = () => {
    rebridge.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(
          t(($) => $.features.rescan_result, {
            matched: result.matched_modules,
            updated: result.updated_modules,
          }),
        );
      },
      onError: (error) => toast.error(String(error)),
    });
  };

  const handleExport = () => {
    const modules = modulesQuery.data?.modules ?? [];
    const issues = issuesQuery.data ?? [];
    const summaries = snapshot?.module_summary ?? [];
    const lines = [
      `# ${t(($) => $.features.module_list)}`,
      "",
      `| ${t(($) => $.features.page_badge)} | ${t(($) => $.features.stat_objects)} | ${t(($) => $.features.stat_strategies)} | ${t(($) => $.features.stat_requirements)} | ${t(($) => $.features.table_community)} |`,
      "|---|---:|---:|---:|---|",
      ...modules.map((module) => {
        const summary = summaryForModule(summaries, module.graph_node_id, module.name);
        const moduleIssues = issuesForModule(issues, projectId, module.id);
        const tasks = rollupTasks(moduleTasks(moduleIssues));
        return `| ${module.name} | ${summary?.obj_count ?? 0} | ${summary?.strategy_count ?? 0} | ${moduleRequirements(moduleIssues).length} | ${communityLabel(module.graph_node_id ?? summary?.node_id)} · ${tasks.done}/${tasks.total} |`;
      }),
      "",
      snapshot ? `scan ${snapshot.scan_id} · ${snapshot.created_at}` : "",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "module-report.md";
    link.click();
    URL.revokeObjectURL(url);
  };

  const viewOptions: Array<{ id: FeatureViewMode; label: string; icon: typeof List }> = [
    { id: "modules", label: t(($) => $.features.view_modules), icon: List },
    { id: "graph", label: t(($) => $.features.view_graph), icon: Share2 },
    { id: "table", label: t(($) => $.features.view_table), icon: LayoutGrid },
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-surface-border px-3 py-2"
      data-testid="product-features-toolbar"
    >
      <ScanStatusBar />
      <div role="group" aria-label={t(($) => $.features.view_mode)} className="flex items-center gap-0.5 rounded-lg border border-surface-border bg-muted/40 p-0.5">
        {viewOptions.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={viewMode === option.id}
            className={cn(viewMode === option.id && "bg-surface text-foreground shadow-none")}
            onClick={() => onViewModeChange(option.id)}
          >
            <option.icon aria-hidden />
            {option.label}
          </Button>
        ))}
      </div>
      <Input
        value={resolvedFilters.search}
        onChange={(event) => onFiltersChange({ ...resolvedFilters, search: event.target.value })}
        placeholder={t(($) => $.features.module_search)}
        className="h-7 w-32 text-[11px]"
        aria-label={t(($) => $.features.module_search)}
      />
      {bizKinds.length > 0 && (
        <select
          aria-label={t(($) => $.features.biz_kind)}
          value={resolvedFilters.bizKind}
          onChange={(event) => onFiltersChange({ ...resolvedFilters, bizKind: event.target.value })}
          className="h-7 rounded-full border border-surface-border bg-surface px-2.5 text-[11px]"
        >
          <option value="all">{t(($) => $.features.biz_kind)} · {t(($) => $.features.biz_kind_all)}</option>
          {bizKinds.map((kind) => (
            <option key={kind} value={kind}>{kind}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        aria-pressed={resolvedFilters.unboundOnly}
        onClick={() => onFiltersChange({ ...resolvedFilters, unboundOnly: !resolvedFilters.unboundOnly })}
        className={cn(
          "rounded-full border px-2.5 py-1 text-[11px] font-medium",
          resolvedFilters.unboundOnly
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-surface-border text-muted-foreground hover:bg-accent/60",
        )}
      >
        {t(($) => $.features.unbound_only)}
        {unboundCount > 0 ? ` ${unboundCount}` : ""}
      </button>
      <div className="ml-auto flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          aria-pressed={creating}
          className="font-semibold"
          onClick={onCreate}
        >
          <Plus className="size-3.5" />
          {t(($) => $.features.create)}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleRebridge}
          disabled={!snapshot || rebridge.isPending}
        >
          <RefreshCw className={rebridge.isPending ? "animate-spin" : undefined} />
          {t(($) => $.features.rescan_short)}
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={handleExport}>
          <Download className="size-3.5" />
          {t(($) => $.features.export_report)}
        </Button>
      </div>
    </div>
  );
}
