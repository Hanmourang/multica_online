"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectModulesOptions } from "@multica/core/modules/queries";
import type { ProjectModule } from "@multica/core/types";
import { DropdownMenuItem, DropdownMenuSeparator } from "@multica/ui/components/ui/dropdown-menu";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";

const EMPTY_MODULES: ProjectModule[] = [];

/**
 * Body of the「+」menu's module group. Deliberately mounted INSIDE the submenu
 * content: the module list is fetched only once the user expands the group, so
 * an ordinary composer render (and the composer's own tests) never issues it.
 */
export function ChatModuleMenu({
  projectId,
  onSelect,
}: {
  projectId: string;
  onSelect: (module: ProjectModule) => void;
}) {
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const modulesQuery = useQuery(projectModulesOptions(wsId, projectId));
  const modules = modulesQuery.data ?? EMPTY_MODULES;
  const visibleModules = modules.filter(
    (module) =>
      !needle ||
      module.name.toLowerCase().includes(needle) ||
      matchesPinyin(module.name, needle),
  );
  return (
    <>
      {modules.length > 0 && (
        <div className="px-1 pb-1">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder={t(($) => $.input.module_search)}
            aria-label={t(($) => $.input.module_search)}
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-caption outline-none focus:border-ring"
          />
        </div>
      )}
      {visibleModules.map((module) => (
        <DropdownMenuItem key={module.id} className="items-start" onClick={() => onSelect(module)}>
          <span
            className="mt-1 size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: module.color || "var(--brand)" }}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{module.name}</span>
            {module.description && (
              <span className="block truncate text-caption text-muted-foreground">{module.description}</span>
            )}
          </span>
        </DropdownMenuItem>
      ))}
      {modulesQuery.isPending && (
        <div className="px-2 py-1.5 text-caption text-muted-foreground">
          {t(($) => $.input.projects_loading)}
        </div>
      )}
      {!modulesQuery.isPending && modulesQuery.isError && (
        <div className="px-2 py-1.5 text-caption text-muted-foreground">
          {t(($) => $.input.projects_error)}
        </div>
      )}
      {!modulesQuery.isPending && !modulesQuery.isError && modules.length === 0 && (
        <div className="px-2 py-1.5 text-caption text-muted-foreground">
          {t(($) => $.input.module_empty)}
        </div>
      )}
      {!modulesQuery.isPending && modules.length > 0 && visibleModules.length === 0 && (
        <div className="px-2 py-1.5 text-caption text-muted-foreground">
          {t(($) => $.input.module_no_match)}
        </div>
      )}
      <DropdownMenuSeparator />
      <div className="max-w-64 px-2 py-1.5 text-caption text-muted-foreground">
        {t(($) => $.input.module_group_hint)}
      </div>
    </>
  );
}
