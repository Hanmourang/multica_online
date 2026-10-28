package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 看板的批量操作：UI 上勾选多行后「改状态 / 改优先级 / 改负责人 / 删除」，对应
// 的是 POST /api/issues/batch-update 与 POST /api/issues/batch-delete。单条
// `issue update` 也能做到，但 N 条就是 N 次往返，中途失败只会改掉一半。
var issueBatchCmd = &cobra.Command{
	Use:   "batch",
	Short: "Apply one change to many issues at once",
}

var issueBatchUpdateCmd = &cobra.Command{
	Use:   "update <issue>...",
	Short: "Apply one set of field changes to every listed issue",
	Long: `Applies one update document to every issue in a single request — the board's
multi-select toolbar.

  multica issue batch update MUL-12 MUL-18 --status in_review --assignee @peer
  multica issue batch update MUL-12 MUL-18 --priority low --project <id>

Every issue is resolved first; an identifier or prefix that does not resolve
aborts the batch before anything is sent. At least one field flag is required —
an empty update is refused instead of reporting a no-op as success.`,
	Args: cobra.MinimumNArgs(1),
	RunE: runIssueBatchUpdate,
}

var issueBatchDeleteCmd = &cobra.Command{
	Use:   "delete <issue>... --yes",
	Short: "Delete several issues in one request",
	Long: `Hard-deletes every listed issue and cancels any task still running on them.
This is the board's multi-select Delete; there is no undo and no restore path.

Print the command with the resolved issue list for a person to approve instead of
running it on your own initiative.`,
	Args: cobra.MinimumNArgs(1),
	RunE: runIssueBatchDelete,
}

func init() {
	issueBatchUpdateCmd.Flags().String("status", "", "New status key for every issue")
	issueBatchUpdateCmd.Flags().String("priority", "", "New priority: none, low, medium, high, urgent")
	issueBatchUpdateCmd.Flags().String("assignee", "", "New assignee by name (member, agent or squad)")
	issueBatchUpdateCmd.Flags().String("assignee-id", "", "New assignee by UUID (mutually exclusive with --assignee)")
	issueBatchUpdateCmd.Flags().String("project", "", "Move every issue to this project (empty string clears it)")
	issueBatchUpdateCmd.Flags().String("start-date", "", "New start date (YYYY-MM-DD)")
	issueBatchUpdateCmd.Flags().String("due-date", "", "New due date (YYYY-MM-DD)")
	issueBatchUpdateCmd.Flags().Bool("no-start", false, "Apply the change without starting agent runs")
	issueBatchUpdateCmd.Flags().String("output", "json", "Output format: json or table")
	addDestructiveFlags(issueBatchDeleteCmd)

	issueBatchCmd.AddCommand(issueBatchUpdateCmd)
	issueBatchCmd.AddCommand(issueBatchDeleteCmd)
	issueCmd.AddCommand(issueBatchCmd)
}

// resolveIssueIDs resolves every argument up front and drops duplicates, so a
// bad ref cannot leave half the batch applied.
func resolveIssueIDs(ctx context.Context, client *cli.APIClient, args []string) ([]string, error) {
	ids := make([]string, 0, len(args))
	seen := make(map[string]struct{}, len(args))
	for _, arg := range args {
		ref, err := resolveIssueRef(ctx, client, arg)
		if err != nil {
			return nil, fmt.Errorf("resolve issue %s: %w", arg, err)
		}
		if _, dup := seen[ref.ID]; dup {
			continue
		}
		seen[ref.ID] = struct{}{}
		ids = append(ids, ref.ID)
	}
	return ids, nil
}

func runIssueBatchUpdate(cmd *cobra.Command, args []string) error {
	fieldFlags := []string{"status", "priority", "assignee", "assignee-id", "project", "start-date", "due-date"}
	changed := false
	for _, name := range fieldFlags {
		if cmd.Flags().Changed(name) {
			changed = true
			break
		}
	}
	if !changed {
		return fmt.Errorf("nothing to update: pass at least one of --status, --priority, --assignee, --project, --start-date, --due-date")
	}
	if cmd.Flags().Changed("status") {
		status, _ := cmd.Flags().GetString("status")
		if err := validateIssueStatus(status); err != nil {
			return err
		}
	}
	if cmd.Flags().Changed("priority") {
		priority, _ := cmd.Flags().GetString("priority")
		if err := validateIssuePriority(priority); err != nil {
			return err
		}
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ids, err := resolveIssueIDs(ctx, client, args)
	if err != nil {
		return err
	}

	updates := map[string]any{}
	if cmd.Flags().Changed("status") {
		status, _ := cmd.Flags().GetString("status")
		updates["status"] = strings.ToLower(strings.TrimSpace(status))
	}
	if cmd.Flags().Changed("priority") {
		priority, _ := cmd.Flags().GetString("priority")
		updates["priority"] = priority
	}
	if cmd.Flags().Changed("project") {
		project, _ := cmd.Flags().GetString("project")
		if strings.TrimSpace(project) == "" {
			updates["project_id"] = nil
		} else {
			ref, err := resolveProjectID(ctx, client, project)
			if err != nil {
				return fmt.Errorf("resolve project: %w", err)
			}
			updates["project_id"] = ref.ID
		}
	}
	for flag, key := range map[string]string{"start-date": "start_date", "due-date": "due_date"} {
		if !cmd.Flags().Changed(flag) {
			continue
		}
		value, _ := cmd.Flags().GetString(flag)
		updates[key] = value
	}
	if cmd.Flags().Changed("assignee") || cmd.Flags().Changed("assignee-id") {
		aType, aID, hasAssignee, resolveErr := pickAssigneeFromFlags(ctx, client, cmd, "assignee", "assignee-id", issueAssigneeKinds)
		if resolveErr != nil {
			return fmt.Errorf("resolve assignee: %w", resolveErr)
		}
		if hasAssignee {
			updates["assignee_type"] = aType
			updates["assignee_id"] = aID
		}
	}
	if noStart, _ := cmd.Flags().GetBool("no-start"); noStart {
		updates["suppress_run"] = true
	}

	body := map[string]any{"issue_ids": ids, "updates": updates}
	return doJSONWrite(cmd, "POST", "/api/issues/batch-update", body, fmt.Sprintf("batch update %d issue(s)", len(ids)))
}

func runIssueBatchDelete(cmd *cobra.Command, args []string) error {
	hint := fmt.Sprintf("Delete %d issue(s): %s. This cancels any running task and cannot be undone.", len(args), strings.Join(args, ", "))
	if err := confirmDestructive(cmd, hint); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ids, err := resolveIssueIDs(ctx, client, args)
	if err != nil {
		return err
	}
	body := map[string]any{"issue_ids": ids}
	return doJSONWrite(cmd, "POST", "/api/issues/batch-delete", body, fmt.Sprintf("batch delete %d issue(s)", len(ids)))
}
