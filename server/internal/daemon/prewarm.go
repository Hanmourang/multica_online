package daemon

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// Checkout prewarming for group conversations.
//
// A group turn cannot resume a provider session -- its input is the server's
// immutable per-turn snapshot -- but the checkout it runs in is reusable. The
// first turn of every (conversation, agent) pair therefore paid for one
// `git worktree add` while the user watched: 19s on a 52k-file repository.
//
// The fix is to pay it earlier. When the group is created the server drops a
// hint per (agent, local_directory) and hands it over on the next claim poll;
// this file turns the hint into a finished, adoptable checkout -- the same tree
// a previous turn would have left behind, reuse record and all -- while the user
// is still typing the first message. The turn itself then takes the reuse path
// it already takes from turn two onwards.
//
// A hint is not a task. Nothing is user-visible, no agent runs, no slot is
// consumed, and losing one costs only the optimisation: the first turn simply
// checks out as it used to.
//
// Path safety: the destination is derived from d.cfg.WorkspacesRoot plus the
// (workspace, agent, conversation) ids through execenv.PrewarmEnvRoot, which
// rejects any id that is not plain hex-and-dash. The repository path comes from
// the project resource -- the same value a real turn hands to
// PrepareLocalWorktree, which refuses anything outside its own repository.

// prewarmedWorkdir names the checkout creating this group may have prewarmed
// for this agent, in the shape a previous turn's work_dir has:
// <env root>/worktree/<the project resource's depth inside the user's repo>.
//
// It is the mirror image of prewarmCheckout: that writes the tree, this names it
// for the turn that adopts it. It answers "" unless every input is present,
// which is the common case -- a prewarm exists only for a group in worktree mode
// whose resource is pinned to a machine. The depth needs the repository root,
// which the prewarm's own reuse record supplies, so this reads one small file
// and runs no git command.
func prewarmedWorkdir(task Task, assignment *localDirectoryAssignment, workspacesRoot string) string {
	if assignment == nil || !assignment.UsesWorktree() || task.ChatSessionKind != "group" {
		return ""
	}
	envRoot := execenv.PrewarmEnvRoot(workspacesRoot, task.WorkspaceID, task.AgentID, task.ChatSessionID)
	if envRoot == "" {
		return ""
	}
	gitRoot := execenv.ReuseProbeGitRoot(envRoot)
	if gitRoot == "" {
		return ""
	}
	// Both sides of the subtraction have to be physical: the resource path is
	// resolved below, and a git root recorded through a symlinked parent
	// (/var on macOS, /tmp on many hosts) would otherwise look like a different
	// tree and the depth would come out as a string of "..".
	if resolved, err := filepath.EvalSymlinks(gitRoot); err == nil {
		gitRoot = resolved
	}
	localPath := assignment.AbsPath
	if resolved, err := filepath.EvalSymlinks(localPath); err == nil {
		localPath = resolved
	}
	rel, err := filepath.Rel(gitRoot, localPath)
	if err != nil || !filepath.IsLocal(rel) {
		return ""
	}
	worktreePath := filepath.Join(envRoot, execenv.LocalWorktreeDirName)
	if rel == "." {
		return worktreePath
	}
	return filepath.Join(worktreePath, rel)
}

// prewarmQueueDepth bounds how many hints wait behind the one being built. Deep
// enough for a burst of group creations; a hint that does not fit is dropped and
// simply costs that conversation its warm start.
const prewarmQueueDepth = 16

// startPrewarms hands the checkout prewarm hints a claim response carried to the
// single prewarm worker.
//
// One worker, one hint at a time. A prewarm holds the same per-repository git
// lock a real turn needs, so two at once would serialise into one long block,
// and starting one beside a saturated batch would make a running turn wait for
// an optimisation. Callers only offer hints from a poll that left capacity
// unused.
//
// The hints queue rather than replace each other: a group with three agents (or
// two groups created back to back) delivers its hints across several polls, and
// dropping the later ones would delay exactly the agents the user is about to
// @. Dropping is still safe when the queue is full — the server re-offers a hint
// it never saw acted on, and a redelivered hint for a tree that is already warm
// is a no-op.
func (d *Daemon) startPrewarms(ctx context.Context, targets []PrewarmTarget) {
	if len(targets) == 0 {
		return
	}
	d.prewarmOnce.Do(func() {
		d.prewarmQueue = make(chan PrewarmTarget, prewarmQueueDepth)
		go d.runPrewarms(ctx, d.prewarmQueue)
	})
	for _, target := range targets {
		select {
		case d.prewarmQueue <- target:
		default:
			d.logger.Debug("checkout prewarm: queue full; the server will re-offer this hint",
				"prewarm", target.ID, "chat_session_id", target.ChatSessionID)
		}
	}
}

// runPrewarms drains the queue for the lifetime of the daemon's root context.
func (d *Daemon) runPrewarms(ctx context.Context, queue <-chan PrewarmTarget) {
	for {
		select {
		case <-ctx.Done():
			return
		case target := <-queue:
			d.prewarmCheckout(ctx, target)
		}
	}
}

// prewarmCheckout builds the checkout for one conversation/agent pair and leaves
// it kept, so the first turn claims it instead of checking the repository out.
func (d *Daemon) prewarmCheckout(ctx context.Context, target PrewarmTarget) {
	if target.LocalPath == "" || target.WorkspaceID == "" || target.AgentID == "" || target.ChatSessionID == "" {
		return
	}
	envRoot := execenv.PrewarmEnvRoot(d.cfg.WorkspacesRoot, target.WorkspaceID, target.AgentID, target.ChatSessionID)
	if envRoot == "" {
		return
	}
	logger := d.logger.With(
		"prewarm", target.ID,
		"agent_id", target.AgentID,
		"chat_session_id", target.ChatSessionID,
	)
	workDir := filepath.Join(envRoot, execenv.LocalWorktreeDirName)
	if execenv.KeptLocalWorktreeRef(workDir, target.WorkspaceID, target.AgentID, target.ChatSessionID) {
		// Redelivered, or the turn this was meant for already ran and left its
		// tree here. Either way there is nothing to build.
		return
	}
	if err := os.MkdirAll(envRoot, 0o755); err != nil {
		logger.Warn("checkout prewarm: create env root failed; the first turn will check out instead",
			"env_root", envRoot, "error", err)
		return
	}

	started := time.Now()
	wt, err := execenv.PrepareLocalWorktree(execenv.LocalWorktreeParams{
		LocalPath: target.LocalPath,
		EnvRoot:   envRoot,
		AgentName: target.AgentName,
		// No task exists yet; the branch comes from the conversation key below.
		TaskID:          target.ID,
		ConversationKey: execenv.ChatWorktreeConversationKey(target.ChatSessionID),
		WorkspaceID:     target.WorkspaceID,
		AgentID:         target.AgentID,
		ConversationID:  target.ChatSessionID,
		// Kept for the turn that follows, exactly as a group turn keeps its own
		// tree for the next message.
		Keep: true,
	}, logger)
	if err != nil {
		if ctx.Err() == nil {
			logger.Warn("checkout prewarm failed; the first turn will check out instead",
				"local_path", target.LocalPath, "error", err)
		}
		return
	}
	// Finalize is what writes the reuse record the first turn's adoption proves
	// itself against. It expects to find nothing to commit -- the tree is exactly
	// the baseline Prepare just made -- so the "produced no work" outcome is the
	// normal one here.
	if _, err := wt.Finalize(logger); err != nil {
		logger.Warn("checkout prewarm could not be finalised; the first turn will check out instead",
			"branch", wt.Branch, "error", err)
		return
	}
	logger.Info("checkout prewarmed for this conversation's first turn",
		"branch", wt.Branch, "git_root", wt.GitRoot, "elapsed", time.Since(started).Round(time.Millisecond))
}
