package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

const (
	projectIndexIssueCap         = 24
	projectIndexGoalRunes        = 80
	projectIndexDescriptionRunes = 400
)

type projectChatIssue struct {
	Number        int32
	Title         string
	Status        string
	Goal          string
	IsRequirement bool
}

// attachProjectChatIndex prepends a bounded snapshot of the session's project
// onto the agent prompt. The brief already carries the owner description; this
// block is the open-work list the agent can answer from without a shell.
// A lookup failure leaves the claim intact — the description and resources
// still travel on the existing project fields.
func (h *Handler) attachProjectChatIndex(ctx context.Context, resp *AgentTaskResponse, workspaceID pgtype.UUID, project claimProjectContext) {
	if resp == nil || strings.TrimSpace(resp.ChatMessage) == "" || project.ProjectID == "" || h.DB == nil {
		return
	}
	index, err := h.buildProjectChatIndex(ctx, workspaceID, project)
	if err != nil {
		slog.Warn("chat claim: project index unavailable; continuing without it",
			"project_id", project.ProjectID, "error", err)
		return
	}
	if index == "" {
		return
	}
	resp.ProjectIndex = index
	resp.ChatMessage = index + "\n\n" + resp.ChatMessage
}

func (h *Handler) buildProjectChatIndex(ctx context.Context, workspaceID pgtype.UUID, project claimProjectContext) (string, error) {
	projectID, err := parseUUIDLoose(project.ProjectID)
	if err != nil {
		return "", err
	}
	terminal := h.projectTerminalIssueStatusKeys(ctx, workspaceID)
	if terminal == nil {
		terminal = []string{}
	}
	open, openCount, closedCount, err := h.listProjectChatIssues(ctx, workspaceID, projectID, terminal)
	if err != nil {
		return "", err
	}
	return formatProjectChatIndex(project.Title, project.Description, project.Resources, open, openCount, closedCount), nil
}

func (h *Handler) listProjectChatIssues(ctx context.Context, workspaceID, projectID pgtype.UUID, terminal []string) ([]projectChatIssue, int, int, error) {
	var openCount, closedCount int
	if err := h.DB.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE NOT (status = ANY($3::text[])))::int,
			count(*) FILTER (WHERE status = ANY($3::text[]))::int
		FROM issue
		WHERE workspace_id = $1 AND project_id = $2
	`, workspaceID, projectID, terminal).Scan(&openCount, &closedCount); err != nil {
		return nil, 0, 0, fmt.Errorf("count project issues: %w", err)
	}

	rows, err := h.DB.Query(ctx, `
		SELECT i.number, i.title, i.status, LEFT(COALESCE(i.goal, ''), 200),
			(i.parent_issue_id IS NULL AND (
				i.start_at IS NOT NULL
				OR i.decomposition_confirmed_at IS NOT NULL
				OR i.triggered_at IS NOT NULL
				OR i.repo_resource_id IS NOT NULL
			))
		FROM issue i
		WHERE i.workspace_id = $1
		  AND i.project_id = $2
		  AND NOT (i.status = ANY($3::text[]))
		ORDER BY i.last_activity_at DESC NULLS LAST, i.number DESC
		LIMIT $4
	`, workspaceID, projectID, terminal, projectIndexIssueCap)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("list open project issues: %w", err)
	}
	defer rows.Close()

	open := make([]projectChatIssue, 0, projectIndexIssueCap)
	for rows.Next() {
		var item projectChatIssue
		if err := rows.Scan(&item.Number, &item.Title, &item.Status, &item.Goal, &item.IsRequirement); err != nil {
			return nil, 0, 0, fmt.Errorf("scan open project issue: %w", err)
		}
		open = append(open, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, 0, fmt.Errorf("read open project issues: %w", err)
	}
	return open, openCount, closedCount, nil
}

func formatProjectChatIndex(title, description string, resources []ProjectResourceData, open []projectChatIssue, openCount, closedCount int) string {
	var b strings.Builder
	b.WriteString("Project index")
	if name := strings.TrimSpace(title); name != "" {
		fmt.Fprintf(&b, " for %q", name)
	}
	b.WriteString(":\n")
	b.WriteString("This index is the authorized snapshot for questions about the active project. ")
	b.WriteString("Answer status and progress questions from the open work below, and use the description and resource list as project context. ")
	fmt.Fprintf(&b, "The same text is in `%s` when this runtime writes it. ", execenv.ProjectIndexRelPath)
	b.WriteString("Do not run `multica issue list` to rediscover these rows. A rejected shell command is not missing data. ")
	b.WriteString("Use `multica issue get <id>` only for an item that is not listed here, and only when the shell actually runs. ")
	b.WriteString("Do not check out a repository unless the user asked for code.\n\n")

	if desc := trimRunes(description, projectIndexDescriptionRunes); desc != "" {
		b.WriteString("Description:\n")
		b.WriteString(desc)
		b.WriteString("\n\n")
	}

	b.WriteString("Resources:\n")
	if len(resources) == 0 {
		b.WriteString("- none\n")
	} else {
		for _, resource := range resources {
			fmt.Fprintf(&b, "- %s\n", formatProjectIndexResource(resource))
		}
	}
	b.WriteString("\n")

	shown := len(open)
	fmt.Fprintf(&b, "Open work (%d open, %d closed", openCount, closedCount)
	if openCount > shown {
		fmt.Fprintf(&b, ", showing %d newest", shown)
	}
	b.WriteString("):\n")
	if shown == 0 {
		b.WriteString("- none\n")
	} else {
		for _, item := range open {
			id := formatKindIdentifier(item.IsRequirement, item.Number)
			fmt.Fprintf(&b, "- %s · %s · %s", id, strings.TrimSpace(item.Status), trimRunes(item.Title, 120))
			if goal := trimRunes(item.Goal, projectIndexGoalRunes); goal != "" {
				fmt.Fprintf(&b, " — %s", goal)
			}
			b.WriteString("\n")
		}
	}
	return strings.TrimSpace(b.String())
}

func formatProjectIndexResource(resource ProjectResourceData) string {
	label := strings.TrimSpace(resource.Label)
	switch resource.ResourceType {
	case "github_repo":
		var payload struct {
			URL string `json:"url"`
		}
		_ = json.Unmarshal(resource.ResourceRef, &payload)
		line := "github_repo"
		if payload.URL != "" {
			line += " " + payload.URL
		}
		if label != "" {
			line += " — " + label
		}
		return line
	default:
		if label != "" {
			return resource.ResourceType + " — " + label
		}
		return resource.ResourceType
	}
}

func trimRunes(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if limit <= 0 || len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
