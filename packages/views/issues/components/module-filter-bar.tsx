"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import type { Project, ProjectModule } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { projectModulesOptions } from "@multica/core/modules";
import { useViewStore } from "@multica/core/issues/stores/view-store-context";
import { useT } from "../../i18n";

const EMPTY_MODULES: ProjectModule[] = [];

const CHIP_BASE =
  "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-caption transition-colors";
const CHIP_IDLE = "border-border text-muted-foreground hover:bg-muted/60";
const CHIP_ACTIVE = "border-primary/40 bg-primary/10 text-primary";

/**
 * Module quick-filter chip row under the issues header: "All modules", one
 * chip per module (colored dot + name), and "No module". Selection lives in
 * the view store's client-only `moduleFilters` / `includeNoModule` and is
 * applied after the server-filtered window lands (the table query spec has
 * no module dimension), so the bar is hidden in table view. With no modules
 * in scope the row renders nothing at all — it would be a filter over an
 * empty dimension.
 */
export function ModuleFilterBar({ projectId }: { projectId?: string }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const viewMode = useViewStore((s) => s.viewMode);
  const moduleFilters = useViewStore((s) => s.moduleFilters);
  const includeNoModule = useViewStore((s) => s.includeNoModule);
  const toggleModuleFilter = useViewStore((s) => s.toggleModuleFilter);
  const toggleNoModule = useViewStore((s) => s.toggleNoModule);
  const clearModuleFilters = useViewStore((s) => s.clearModuleFilters);

  // Workspace-scope surfaces (/issues) span every project: aggregate each
  // project's module list so the chip row covers what the cards can show.
  const { data: projects } = useQuery({
    ...projectListOptions(wsId),
    enabled: !projectId,
  });
  const projectIds = useMemo(
    () => (projectId ? [projectId] : (projects ?? []).map((p) => p.id)),
    [projectId, projects],
  );
  // combine dedupes by module id (a workspace scope queries every project)
  // and its result is structurally shared, so downstream memos keying on
  // `modules` only re-run when an actual module list changes.
  const modules = useQueries({
    queries: projectIds.map((id) => projectModulesOptions(wsId, id)),
    combine: (results) => {
      const byId = new Map<string, ProjectModule>();
      for (const query of results) {
        for (const module of query.data ?? EMPTY_MODULES) {
          if (!byId.has(module.id)) byId.set(module.id, module);
        }
      }
      return Array.from(byId.values());
    },
  });

  const projectMap = useMemo(
    () => new Map<string, Project>((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );

  // Two projects can carry the same module name on a workspace-scope surface;
  // disambiguate those chips with the project title instead of showing two
  // indistinguishable filters.
  const labelById = useMemo(() => {
    const nameCounts = new Map<string, number>();
    for (const module of modules) {
      nameCounts.set(module.name, (nameCounts.get(module.name) ?? 0) + 1);
    }
    const labels = new Map<string, string>();
    for (const module of modules) {
      let label = module.name;
      if ((nameCounts.get(module.name) ?? 0) > 1) {
        const title = projectMap.get(module.project_id)?.title;
        if (title) label = `${module.name} · ${title}`;
      }
      labels.set(module.id, label);
    }
    return labels;
  }, [modules, projectMap]);

  // Table is a fully server-windowed surface: a client-side quick filter
  // cannot be expressed there, so the chip row steps aside.
  if (viewMode === "table") return null;
  if (modules.length === 0) return null;

  const allActive = moduleFilters.length === 0 && !includeNoModule;

  return (
    <div className="mx-4 mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-pressed={allActive}
        onClick={clearModuleFilters}
        className={cn(CHIP_BASE, allActive ? CHIP_ACTIVE : CHIP_IDLE)}
      >
        {t(($) => $.module.filter_all)}
      </button>
      {modules.map((module) => {
        const active = moduleFilters.includes(module.id);
        return (
          <button
            key={module.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggleModuleFilter(module.id)}
            className={cn(CHIP_BASE, !active && CHIP_IDLE)}
            style={
              active
                ? {
                    background: `color-mix(in oklch, ${module.color} 10%, transparent)`,
                    borderColor: `color-mix(in oklch, ${module.color} 35%, transparent)`,
                    color: module.color,
                  }
                : undefined
            }
          >
            <i
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: module.color }}
            />
            <span className="max-w-40 truncate">
              {labelById.get(module.id) ?? module.name}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={includeNoModule}
        onClick={toggleNoModule}
        className={cn(CHIP_BASE, includeNoModule ? CHIP_ACTIVE : CHIP_IDLE)}
      >
        {t(($) => $.module.filter_none)}
      </button>
    </div>
  );
}
