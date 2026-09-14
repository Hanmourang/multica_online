"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { prototypeVersionsOptions } from "@multica/core/issues/queries";
import type { Issue, PrototypeVersion } from "@multica/core/types";
import { issuesForModule, moduleRequirements } from "./module-feature-stats";

export function useIssuePrototypeVersions(issueIds: string[]) {
  const key = issueIds.join(",");
  const stableIds = useMemo(() => key.split(",").filter(Boolean), [key]);
  const queries = useQueries({
    queries: stableIds.map((id) => ({
      ...prototypeVersionsOptions(id),
    })),
  });
  const pending = queries.some((query) => query.isPending);
  const error = queries.some((query) => query.isError);
  const stamp = queries.map((query) => `${query.dataUpdatedAt}:${query.data?.length ?? 0}`).join("|");
  return useMemo(() => {
    const byIssue = new Map<string, PrototypeVersion[]>();
    stableIds.forEach((id, index) => {
      byIssue.set(id, queries[index]?.data ?? []);
    });
    return {
      byIssue,
      pending,
      error,
      refetch: () => {
        for (const query of queries) void query.refetch();
      },
    };
    // stamp covers data identity without depending on the queries array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableIds, pending, error, stamp]);
}

export function prototypeCountForModule(
  issues: Issue[],
  projectId: string,
  moduleId: string,
  byIssue: Map<string, PrototypeVersion[]>,
): number {
  return moduleRequirements(issuesForModule(issues, projectId, moduleId)).reduce(
    (sum, issue) => sum + (byIssue.get(issue.id)?.length ?? 0),
    0,
  );
}
