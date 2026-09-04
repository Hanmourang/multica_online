"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { Issue } from "@multica/core/types";
import { statusCategoryOfKey } from "@multica/core/issues";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  issueDependenciesOptions,
  usePutIssueDependencies,
} from "@multica/core/modules";
import { AppLink } from "../../navigation";
import { StatusIcon } from ".";
import { DependencyPicker } from "./pickers/dependency-picker";
import { useT } from "../../i18n";

/**
 * "Blocked by" sidebar section (spec §4): lists the issue's same-module
 * dependencies with their live status, adds via the DependencyPicker and
 * removes via a per-row button — both fan out as a full-replace PUT.
 *
 * Hidden entirely on project-less issues (no project → no module → no
 * dependencies). A module-less issue in a project renders the section with
 * the picker's needs-module hint, so the dependency concept stays
 * discoverable instead of silently absent.
 */
export function IssueDependenciesSection({ issue }: { issue: Issue }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true);

  const { data: deps = [] } = useQuery(
    issueDependenciesOptions(wsId, issue.id),
  );
  const putDeps = usePutIssueDependencies(issue.id);

  if (!issue.project_id) return null;

  const depIds = deps.map((d) => d.issue_id);
  const hasModule = Boolean(issue.module_id);
  // "Unfinished" = anything not done/cancelled. statusCategoryOfKey floors
  // unknown keys at todo, which is the conservative read for a gate.
  const hasUnfinished = deps.some((d) => {
    const category = statusCategoryOfKey(d.status);
    return category !== "done" && category !== "cancelled";
  });

  const replaceDeps = (ids: string[]) => {
    putDeps.mutate(ids, {
      onError: () => toast.error(t(($) => $.detail.update_failed)),
    });
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.module.dep_label)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="pl-2 space-y-1.5">
          {!hasModule && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.module.dep_needs_module)}
            </p>
          )}
          {hasModule && deps.length === 0 && (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.module.dep_empty_detail)}
            </p>
          )}
          {deps.map((dep) => (
            <div
              key={dep.issue_id}
              className="flex items-center gap-0.5 rounded-md px-2 -mx-2 hover:bg-accent/50 transition-colors group"
            >
              <AppLink
                href={paths.issueDetail(dep.issue_id)}
                className="flex flex-1 min-w-0 items-center gap-1.5 py-1.5 text-caption"
              >
                <StatusIcon
                  status={dep.status}
                  category={statusCategoryOfKey(dep.status)}
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="truncate group-hover:text-foreground">
                  {dep.title}
                </span>
              </AppLink>
              <button
                type="button"
                aria-label={t(($) => $.module.dep_remove_aria, {
                  title: dep.title,
                })}
                title={t(($) => $.module.dep_remove_aria, {
                  title: dep.title,
                })}
                onClick={() =>
                  replaceDeps(depIds.filter((id) => id !== dep.issue_id))
                }
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {hasModule && (
            <DependencyPicker
              issueId={issue.id}
              projectId={issue.project_id}
              moduleId={issue.module_id ?? null}
              selectedIds={depIds}
              onChange={replaceDeps}
              align="start"
              triggerRender={
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 -mx-2 text-caption text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
                >
                  <Plus className="size-3" />
                  {t(($) => $.module.dep_add)}
                </button>
              }
            />
          )}
          {hasModule && hasUnfinished && (
            <p className="rounded-md bg-muted/60 px-2 py-1.5 text-micro text-muted-foreground">
              {t(($) => $.module.detail_hint)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
