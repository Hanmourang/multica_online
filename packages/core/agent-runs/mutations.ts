import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentRunEventInput, AgentRunTodoInput } from "../api/client";
import { agentRunKeys, issueArchiveKeys } from "./queries";

/**
 * Agent-run projection writes (migration 459; spec §5.5). The conversation
 * stream (task_message) stays the source of truth — these mutations only push
 * the projector's todo / event rows into the archive tables that f7 (需求动态)
 * and f9 (进度追踪) read back.
 */

/**
 * Batch-upsert a run's todos. `(run_id, todo_key)` is the merge key, so a
 * replayed flush moves status/seq/phase forward instead of duplicating rows.
 *
 * Todo status feeds two aggregates beyond the run itself — f8 交付概览 counts
 * todos by status and f9 进度追踪 rolls up `todos_progress` — so on settle we
 * invalidate the whole issue-archive slice for the workspace alongside the
 * run's todo list.
 */
export function useUpsertAgentRunTodos(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      todos,
    }: {
      runId: string;
      todos: AgentRunTodoInput[];
    }) => api.upsertAgentRunTodos(runId, todos),
    onSettled: (_data, _error, variables) => {
      qc.invalidateQueries({
        queryKey: agentRunKeys.todos(workspaceId, variables.runId),
      });
      qc.invalidateQueries({ queryKey: issueArchiveKeys.all(workspaceId) });
    },
  });
}

/**
 * Append-only batch write of a run's event stream (heartbeats / todo changes /
 * rate limits / net errors / crashes). No merge key — every call appends — so
 * only the run's own event timeline needs refetching.
 */
export function useAppendAgentRunEvents(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      events,
    }: {
      runId: string;
      events: AgentRunEventInput[];
    }) => api.appendAgentRunEvents(runId, events),
    onSettled: (_data, _error, variables) => {
      qc.invalidateQueries({
        queryKey: agentRunKeys.events(workspaceId, variables.runId),
      });
    },
  });
}
