import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import type { AgentTask } from "@multica/core/types";

export interface LabeledTask {
  task: AgentTask;
  sourceIssueId: string;
  sourceTitle?: string;
}

/** 本任务 + 子任务的运行列表，供 A3 与子任务「查看此次执行」共用。 */
export function useIssueExecutionTasks(
  issueId: string,
  children: { id: string; title: string }[],
) {
  const parentQuery = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const childQueries = useQueries({
    queries: children.map((child) => ({
      queryKey: issueKeys.tasks(child.id),
      queryFn: () => api.listTasksByIssue(child.id),
      staleTime: 30_000,
    })),
  });

  const childKey = children.map((child) => child.id).join(",");
  const childData = childQueries.map((query) => query.data);
  const tasks = useMemo<LabeledTask[]>(() => {
    const labeled: LabeledTask[] = [];
    for (const task of parentQuery.data ?? []) {
      labeled.push({ task, sourceIssueId: issueId });
    }
    children.forEach((child, index) => {
      for (const task of childData[index] ?? []) {
        labeled.push({ task, sourceIssueId: child.id, sourceTitle: child.title });
      }
    });
    return labeled.toSorted((a, b) => {
      const at = new Date(a.task.completed_at ?? a.task.created_at).getTime();
      const bt = new Date(b.task.completed_at ?? b.task.created_at).getTime();
      return bt - at;
    });
    // childKey stands in for children identity so a new array of the same ids
    // does not rebuild the labeled list every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentQuery.data, childData, childKey, issueId]);

  return {
    tasks,
    agentTasks: tasks.map((item) => item.task),
    isPending: parentQuery.isPending,
  };
}
