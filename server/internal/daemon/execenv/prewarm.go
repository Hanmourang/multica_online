package execenv

import (
	"path/filepath"
	"strings"
)

// prewarmDirPrefix marks an env root the daemon prepared ahead of a group
// conversation's first message, rather than for a task that already exists.
//
// The prefix is the only thing that distinguishes the two on disk, and it
// matters for exactly one decision: the env-root GC classifies a root with no
// GC meta as an orphan, so an unused prewarm is reclaimed by age on its own
// (see gcActionOrphan) while an adopted one picks up ordinary chat meta the
// moment its first turn completes.
const prewarmDirPrefix = "pwarm-"

// ChatWorktreeConversationKey is the conversation key a chat turn's worktree
// branch is named from.
//
// Exported because a prewarmed checkout and the turn that eventually adopts it
// must agree on it: the prewarm creates the branch, and the turn continues it.
// Deriving the key twice from two copies of the format is precisely how they
// would drift apart, so both call this.
func ChatWorktreeConversationKey(chatSessionID string) string {
	if strings.TrimSpace(chatSessionID) == "" {
		return ""
	}
	return "chat-" + taskKey(chatSessionID)
}

// PrewarmEnvRoot is the env root a group conversation's warm checkout lives in.
//
// Deterministic on purpose. It is the whole protocol between the two sides: the
// daemon prepares the tree here while the user is still typing, and the turn
// that follows derives the same path from its own task fields, with no state
// stored in between — no index file, no server round trip, and nothing to lose
// on a restart. A target whose tree is absent simply falls back to the ordinary
// full checkout.
//
// The result has to keep the shape shouldReusePriorWorkdir validates — a
// worktree dir directly under an env root directly under the workspace dir —
// and it does: <workspaces>/<workspace>/pwarm-<agent>-<conversation>/worktree.
//
// Keyed on the (agent, conversation) pair rather than the conversation alone
// because one group turn fans out to several agents, and each agent's tree is
// its own branch and its own workdir.
//
// Returns "" for anything it cannot turn into a safe path segment. The ids
// arrive from the server (and, through it, from rows a caller could once have
// influenced), so they are validated here rather than trusted: every segment
// below has to be drawn from an id that is uuid-shaped, which is what keeps
// this from composing a path outside the workspaces root.
func PrewarmEnvRoot(workspacesRoot, workspaceID, agentID, chatSessionID string) string {
	if workspacesRoot == "" {
		return ""
	}
	workspaceID, agentID, chatSessionID = prewarmID(workspaceID), prewarmID(agentID), prewarmID(chatSessionID)
	if workspaceID == "" || agentID == "" || chatSessionID == "" {
		return ""
	}
	// Both ids contribute their random tails: a hex tail is what makes the
	// segment collision-safe, and taking it from only one of the two would
	// collapse every agent of a conversation onto one directory.
	key := prewarmDirPrefix + taskKey(agentID) + "-" + taskKey(chatSessionID)
	return filepath.Join(workspacesRoot, readablePathSegment("", "workspace", workspaceID), key)
}

// prewarmID returns id when it is safe to use as a path segment source, and ""
// otherwise. Only hex digits and separators survive; anything else means the
// caller is not handing us an id we can build a path from.
func prewarmID(id string) string {
	if id == "" {
		return ""
	}
	for _, r := range id {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F', r == '-':
			continue
		default:
			return ""
		}
	}
	return id
}
