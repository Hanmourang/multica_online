-- A group turn is offered its own agent's previous workdir on every claim:
--
--   SELECT work_dir FROM agent_task_queue
--    WHERE chat_session_id = $1 AND agent_id = $2
--      AND status = 'completed' AND work_dir IS NOT NULL AND work_dir <> ''
--    ORDER BY completed_at DESC NULLS LAST
--    LIMIT 1
--
-- idx_agent_task_queue_chat_terminal_resume (349) can serve this, but only by
-- indexing (chat_session_id, session_id, completed_at) over ALL three terminal
-- states and then filtering agent_id and status as a recheck. Every group turn
-- pays that scan, and in a busy workspace the recheck is what grows.
--
-- This index puts the three columns the query actually constrains first, and
-- narrows the predicate to the only state that can carry a durable workdir.
-- work_dir <> '' stays out of the predicate on purpose: it is an equality on a
-- nullable text column, so filtering it after the index lookup is free, while
-- including it would widen the index without making the scan any narrower.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_task_queue_group_prior_workdir
ON agent_task_queue (chat_session_id, agent_id, completed_at DESC)
WHERE status = 'completed'
  AND work_dir IS NOT NULL;
