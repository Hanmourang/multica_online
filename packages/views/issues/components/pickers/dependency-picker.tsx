"use client";

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link2, Ban } from "lucide-react";
import type { Issue } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueListOptions } from "@multica/core/issues/queries";
import { issueDependenciesOptions } from "@multica/core/modules";
import {
  PropertyPicker,
  PickerItem,
} from "./property-picker";
import { useT } from "../../../i18n";

/**
 * Cap for the client-side cycle pre-check. The check needs every same-module
 * issue's dependency list (one small GET each, cached); past this size we skip
 * the pre-check and let the server's 409 be the guard, so a giant module can't
 * fan out into a request storm when the picker opens.
 */
const CYCLE_PRECHECK_MAX_CANDIDATES = 30;

/**
 * Ids whose selection would close a dependency cycle. `edges` maps an issue id
 * to the ids it depends on; `selfId`'s entry must be the *pending* selection
 * so the check sees the graph as it would look after the toggle.
 *
 * Adding the edge self→candidate creates a cycle exactly when the candidate
 * can already reach self by walking depends_on edges.
 */
export function collectCycleCandidates(
  selfId: string | undefined,
  candidateIds: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const cyclic = new Set<string>();
  if (!selfId) return cyclic;
  const reaches = (from: string, target: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of edges.get(cur) ?? []) stack.push(next);
    }
    return false;
  };
  for (const id of candidateIds) {
    if (reaches(id, selfId)) cyclic.add(id);
  }
  return cyclic;
}

interface DependencyPickerProps {
  /** The issue being edited; undefined in draft mode (create dialog). */
  issueId?: string;
  /** Owning project — candidates are scoped to it. */
  projectId: string | null;
  /** Selected module. null disables the list with a hint: dependencies only
   *  exist inside a module (spec §4 same-module rule). */
  moduleId: string | null;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  align?: "start" | "center" | "end";
  /** Custom trigger element (e.g. a `PillButton` for the create toolbar). */
  triggerRender?: React.ReactElement;
}

/**
 * Multi-select dependency picker (spec §4): lists only same-module issues —
 * a dependency edge is the serialization mechanism *within* a module, so
 * cross-module options simply don't exist here (the server 409s them anyway).
 * Options that would close a cycle are disabled with a "would cycle" marker,
 * pre-checked client-side via DFS with the server's 409 as the backstop.
 */
export function DependencyPicker({
  issueId,
  projectId,
  moduleId,
  selectedIds,
  onChange,
  align = "start",
  triggerRender,
}: DependencyPickerProps) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const wsId = useWorkspaceId();

  const { data: allIssues = [] } = useQuery(issueListOptions(wsId));

  // Same-module candidates, minus self. The selected ids stay resolvable even
  // if a selected issue left the module meanwhile (it renders as a removable
  // chip rather than vanishing silently).
  const candidates = useMemo(() => {
    if (!projectId || !moduleId) return [];
    return allIssues.filter(
      (i: Issue) =>
        i.project_id === projectId &&
        i.module_id === moduleId &&
        i.id !== issueId,
    );
  }, [allIssues, projectId, moduleId, issueId]);

  const candidateIds = useMemo(() => candidates.map((i) => i.id), [candidates]);

  // Dependency lists of every candidate, for the cycle pre-check. Bounded by
  // CYCLE_PRECHECK_MAX_CANDIDATES; past that the server-side 409 is the guard.
  const precheckEnabled =
    candidateIds.length > 0 &&
    candidateIds.length <= CYCLE_PRECHECK_MAX_CANDIDATES;
  const depQueries = useQueries({
    queries: candidateIds.map((id) => ({
      ...issueDependenciesOptions(wsId, id),
      enabled: precheckEnabled,
    })),
  });

  const cycleSet = useMemo(() => {
    const edges = new Map<string, readonly string[]>();
    if (issueId) edges.set(issueId, selectedIds);
    candidateIds.forEach((id, idx) => {
      const data = depQueries[idx]?.data;
      if (data) edges.set(id, data.map((d) => d.issue_id));
    });
    return collectCycleCandidates(issueId, candidateIds, edges);
  }, [issueId, selectedIds, candidateIds, depQueries]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedIssues = useMemo(
    () =>
      selectedIds
        .map((id) => allIssues.find((i) => i.id === id))
        .filter((i): i is Issue => Boolean(i)),
    [selectedIds, allIssues],
  );

  const query = filter.trim().toLowerCase();
  const filtered = candidates.filter(
    (i) =>
      i.title.toLowerCase().includes(query) ||
      i.identifier.toLowerCase().includes(query),
  );

  const toggle = (id: string) => {
    onChange(
      selectedSet.has(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id],
    );
  };

  const noModule = !moduleId;
  const noCandidates = !noModule && candidates.length === 0;

  return (
    <PropertyPicker
      open={open}
      onOpenChange={(v: boolean) => {
        setOpen(v);
        if (!v) setFilter("");
      }}
      width="w-80"
      align={align}
      searchable={!noModule}
      searchPlaceholder={t(($) => $.module.dep_search)}
      onSearchChange={setFilter}
      triggerRender={triggerRender}
      trigger={
        selectedIssues.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {selectedIssues.map((i) => i.identifier).join(", ")}
            </span>
          </span>
        ) : (
          <>
            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              {t(($) => $.module.dep_label)}
            </span>
          </>
        )
      }
    >
      {noModule && (
        <div className="px-2 py-3 text-center text-body text-muted-foreground">
          {t(($) => $.module.dep_needs_module)}
        </div>
      )}
      {noCandidates && (
        <div className="px-2 py-3 text-center text-body text-muted-foreground">
          {t(($) => $.module.dep_empty)}
        </div>
      )}
      {filtered.map((issue) => {
        const cyclic = cycleSet.has(issue.id);
        return (
          <PickerItem
            key={issue.id}
            selected={selectedSet.has(issue.id)}
            disabled={cyclic && !selectedSet.has(issue.id)}
            onClick={() => toggle(issue.id)}
            tooltip={cyclic ? t(($) => $.module.dep_cycle) : undefined}
          >
            <span className="shrink-0 text-muted-foreground">
              {issue.identifier}
            </span>
            <span className="truncate">{issue.title}</span>
            {cyclic && !selectedSet.has(issue.id) && (
              <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-micro text-muted-foreground">
                <Ban className="h-3 w-3" />
                {t(($) => $.module.dep_cycle)}
              </span>
            )}
          </PickerItem>
        );
      })}
    </PropertyPicker>
  );
}
