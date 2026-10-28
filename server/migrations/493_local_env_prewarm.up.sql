-- Warm a group conversation's task checkout BEFORE the first message needs it.
--
-- A group turn never resumes a provider session (its input is the server's
-- per-turn snapshot), but it can reuse the checkout the previous turn left
-- behind. That only helps from the SECOND message on: the first turn of a
-- (conversation, agent) pair still pays a full `git worktree add`, which is
-- ~19s on a large repository and is paid while the user is waiting.
--
-- This table carries the "please check this out now" hint from the moment the
-- conversation is known (group create / agent added) to the daemon, which is
-- the only process that can touch the user's local repository. The daemon picks
-- these up on its ordinary batch-claim poll and prepares the tree while the
-- user is still typing, so the first message finds a warm worktree.
--
-- Deliberately a hint, not a task: nothing here is user-visible, no agent runs,
-- and a lost row only costs the optimisation. There is no result column —
-- delivery is idempotent because the daemon derives the destination from
-- (workspace, agent, conversation) and skips a target that is already warm.
CREATE TABLE IF NOT EXISTS local_env_prewarm (
    id              uuid PRIMARY KEY,
    -- The machine that owns the local_directory resource. Prewarming anywhere
    -- else would check the repository out on a host that cannot run the turn.
    daemon_id       text NOT NULL,
    workspace_id    uuid NOT NULL,
    agent_id        uuid NOT NULL,
    chat_session_id uuid NOT NULL,
    -- The user's configured directory, as recorded on the project resource.
    -- Stored rather than re-derived so the daemon needs no project lookup.
    local_path      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Last delivery. The pickup query re-offers a row whose daemon never acted
    -- on it (crash, restart) after a retry window; this also keeps two claims
    -- from preparing the same tree at once.
    claimed_at      timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    expires_at      timestamptz NOT NULL
);

-- One target per machine: re-requesting the same conversation/agent (the user
-- re-opens the group, a participant is re-added) must not stack work.
CREATE UNIQUE INDEX IF NOT EXISTS uq_local_env_prewarm_target
    ON local_env_prewarm (daemon_id, agent_id, chat_session_id);

-- Pickup is always "this daemon, not expired"; the sweep is "everything
-- expired". Both are served by the one index.
CREATE INDEX IF NOT EXISTS idx_local_env_prewarm_pickup
    ON local_env_prewarm (daemon_id, expires_at);
