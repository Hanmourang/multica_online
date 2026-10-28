package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// Group-chat checkout prewarming.
//
// A group turn deliberately never resumes a provider session — its input is the
// server's immutable per-turn snapshot — but the *checkout* it runs in is
// reusable, and a worktree-mode project pays for one on the first turn of every
// (conversation, agent) pair: `git worktree add` measured ~19s on a 52k-file
// repository, spent while the user waits for the first token.
//
// The rows here are that cost moved earlier. The moment the conversation is
// known — the group is created, an agent is added to it — the server drops a
// hint per (agent × local_directory-on-this-machine), and the daemon (the only
// process that can touch the user's repository) prepares the tree on its next
// ordinary claim poll, i.e. while the user is still typing the first message.
//
// It is a hint, not a task: nothing is user-visible, no agent runs, and losing
// a row costs the optimisation and nothing else. The daemon derives the
// destination path from (workspace, agent, conversation), so delivery needs no
// reply, no acknowledgement and no result column — a duplicate hint for a tree
// that is already warm is a no-op on the daemon side.
const (
	// localEnvPrewarmTTL bounds how long a hint stays live. Long enough to
	// cover "opened the group, got distracted, came back"; short enough that a
	// group nobody ever posts in does not hold a checkout on disk for a day.
	localEnvPrewarmTTL = 20 * time.Minute
	// localEnvPrewarmRetry is the redelivery window for a hint the daemon
	// claimed but never acted on (crash, restart, shutdown mid-prepare). It
	// also keeps two polls from preparing the same tree at once.
	localEnvPrewarmRetry = 2 * time.Minute
	// claimBatchMaxPrewarms caps how many hints ride one claim response. The
	// daemon prewarms one at a time anyway; the cap is what stops a burst of
	// group creations from turning a single claim payload into a work queue.
	claimBatchMaxPrewarms = 2
	// localEnvPrewarmSweepInterval throttles the expired-row sweep, which is
	// otherwise pure overhead on the claim path.
	localEnvPrewarmSweepInterval = 10 * time.Minute
)

// localEnvPrewarmSweep is the last time the expired-hint sweep ran, in unix
// nanoseconds. Process-wide on purpose: the sweep is a housekeeping task whose
// only requirement is that it happens, not that each handler runs it.
var localEnvPrewarmSweep atomic.Int64

// localEnvPrewarmTarget is one hint as the daemon receives it.
type localEnvPrewarmTarget struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	AgentID     string `json:"agent_id"`
	// AgentName names the branch the warm checkout will create. It has to
	// match what the real turn would use, because this tree's branch IS that
	// turn's branch — it is adopted, not recreated.
	AgentName     string `json:"agent_name,omitempty"`
	ChatSessionID string `json:"chat_session_id"`
	// LocalPath is the user's configured directory for the project resource.
	LocalPath string `json:"local_path"`
}

// requestGroupPrewarms asks every machine that owns a worktree-mode
// local_directory resource of the group's project to prepare the checkout for
// each of these agents.
//
// Best-effort by construction: it logs and returns on any failure, because a
// missing warm tree only means the first turn pays the checkout it used to pay
// anyway. Callers invoke it AFTER their own transaction commits, so a hint can
// never outlive a conversation that failed to be created.
func (h *Handler) requestGroupPrewarms(ctx context.Context, workspaceID string, projectID pgtype.UUID, sessionID pgtype.UUID, agentIDs []pgtype.UUID) {
	if h.DB == nil || !projectID.Valid || !sessionID.Valid || len(agentIDs) == 0 {
		return
	}
	resources, err := h.Queries.ListProjectResources(ctx, projectID)
	if err != nil {
		slog.Warn("group chat: load project resources for checkout prewarming failed",
			"project_id", uuidToString(projectID), "error", err)
		return
	}
	type prewarmTarget struct {
		daemonID  string
		localPath string
	}
	var targets []prewarmTarget
	for _, res := range resources {
		if res.ResourceType != "local_directory" {
			continue
		}
		var ref localDirectoryRef
		if err := json.Unmarshal(res.ResourceRef, &ref); err != nil {
			continue
		}
		// In-place resources need no checkout: the turn runs in the user's own
		// directory. Only worktree mode pays for a tree, and only a resource
		// pinned to a machine can be checked out on one.
		if ref.ExecutionMode != localDirectoryModeWorktree || ref.DaemonID == "" || ref.LocalPath == "" {
			continue
		}
		targets = append(targets, prewarmTarget{daemonID: ref.DaemonID, localPath: ref.LocalPath})
	}
	if len(targets) == 0 {
		return
	}

	workspaceUUID, err := parseUUIDGuarded(workspaceID)
	if err != nil {
		return
	}

	for _, target := range targets {
		for _, agentID := range agentIDs {
			// The agent's name is joined in at delivery time (takePrewarms)
			// rather than read here: only then does it matter, and a renamed
			// agent should get the branch name its next turn will use.
			if _, err := h.DB.Exec(ctx, `
				INSERT INTO local_env_prewarm
					(id, daemon_id, workspace_id, agent_id, chat_session_id, local_path, expires_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (daemon_id, agent_id, chat_session_id) DO NOTHING`,
				dbid.NewV7(), target.daemonID, workspaceUUID, agentID, sessionID, target.localPath,
				pgtype.Timestamptz{Time: time.Now().Add(localEnvPrewarmTTL), Valid: true},
			); err != nil {
				slog.Warn("group chat: enqueue checkout prewarming failed",
					"daemon_id", target.daemonID,
					"chat_session_id", uuidToString(sessionID),
					"agent_id", uuidToString(agentID),
					"error", err)
				return
			}
		}
	}
}

// takePrewarms claims up to limit hints for this daemon.
//
// The NOT EXISTS clause is what keeps a hint from racing the turn it was meant
// to precede: once any live task exists for the same (conversation, agent), the
// checkout either just happened or is happening, and a second `git worktree
// add` into the same directory would be the opposite of a speed-up.
func (h *Handler) takePrewarms(ctx context.Context, daemonID string, limit int) []localEnvPrewarmTarget {
	if h.DB == nil || daemonID == "" || limit <= 0 {
		return nil
	}
	rows, err := h.DB.Query(ctx, `
		WITH picked AS (
			SELECT p.id
			  FROM local_env_prewarm p
			 WHERE p.daemon_id = $1
			   AND p.expires_at > now()
			   AND (p.claimed_at IS NULL OR p.claimed_at < $3)
			   AND NOT EXISTS (
				SELECT 1 FROM agent_task_queue t
				 WHERE t.chat_session_id = p.chat_session_id
				   AND t.agent_id = p.agent_id
				   AND t.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory'))
			 ORDER BY p.created_at ASC
			 LIMIT $2
			 FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE local_env_prewarm p
			   SET claimed_at = now(), attempts = p.attempts + 1
			  FROM picked
			 WHERE p.id = picked.id
			RETURNING p.id, p.workspace_id, p.agent_id, p.chat_session_id, p.local_path
		)
		SELECT c.id::text, c.workspace_id::text, c.agent_id::text, c.chat_session_id::text,
		       c.local_path, COALESCE(a.name, '')
		  FROM claimed c
		  LEFT JOIN agent a ON a.id = c.agent_id`,
		daemonID, limit, pgtype.Timestamptz{Time: time.Now().Add(-localEnvPrewarmRetry), Valid: true},
	)
	if err != nil {
		// Not fatal for the claim: a missing prewarm table (an older schema
		// during a rolling deploy) must not stop tasks from being dispatched.
		slog.Warn("task claim: pick up checkout prewarm hints failed", "daemon_id", daemonID, "error", err)
		return nil
	}
	defer rows.Close()

	out := make([]localEnvPrewarmTarget, 0, limit)
	for rows.Next() {
		var t localEnvPrewarmTarget
		if err := rows.Scan(&t.ID, &t.WorkspaceID, &t.AgentID, &t.ChatSessionID, &t.LocalPath, &t.AgentName); err != nil {
			slog.Warn("task claim: scan checkout prewarm hint failed", "daemon_id", daemonID, "error", err)
			return nil
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		slog.Warn("task claim: read checkout prewarm hints failed", "daemon_id", daemonID, "error", err)
		return nil
	}
	h.sweepExpiredPrewarms(ctx)
	return out
}

// sweepExpiredPrewarms drops hints nobody is going to act on. Throttled
// process-wide, and safe to run concurrently (the throttle uses a CAS), because
// it is housekeeping rather than part of the claim's result.
func (h *Handler) sweepExpiredPrewarms(ctx context.Context) {
	now := time.Now().UnixNano()
	last := localEnvPrewarmSweep.Load()
	if now-last < int64(localEnvPrewarmSweepInterval) {
		return
	}
	if !localEnvPrewarmSweep.CompareAndSwap(last, now) {
		return
	}
	if _, err := h.DB.Exec(ctx, `DELETE FROM local_env_prewarm WHERE expires_at < now()`); err != nil {
		slog.Warn("checkout prewarm: sweep expired hints failed", "error", err)
	}
}

// writeClaimBatch answers a claim poll with the tasks to run plus this machine's
// pending checkout prewarm hints.
//
// The hints ride every successful answer, including the ones that carry no
// tasks: an idle daemon is precisely when a prewarm can be built without making
// a running turn wait for it, and the group that queued the hint has not sent its
// first message yet.
func (h *Handler) writeClaimBatch(w http.ResponseWriter, r *http.Request, daemonID string, tasks []AgentTaskResponse) {
	if tasks == nil {
		tasks = []AgentTaskResponse{}
	}
	writeMeasuredJSON(w, http.StatusOK, map[string]any{
		"tasks":    tasks,
		"prewarms": h.takePrewarms(r.Context(), daemonID, claimBatchMaxPrewarms),
	})
}

// parseUUIDGuarded converts a uuid string. The handler package's parseUUID
// panics on malformed input, which is the wrong shape for a best-effort path.
func parseUUIDGuarded(raw string) (pgtype.UUID, error) {
	return util.ParseUUID(raw)
}
