package main

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 迭代（sprint）是项目详情里的一个 TAB，但它的写入面（建/改/启停/纳管任务）
// 过去只在 UI 里存在，agent 只能通过 `project tab get ... sprints` 读。
// 状态机是 planned → active → completed，reopen 把 completed 打回 active：
// start/complete/reopen 走专用端点，不要用 update 假装改状态。
var sprintCmd = &cobra.Command{
	Use:   "sprint",
	Short: "Read and manage project sprints (time boxes over issues)",
	Long: `Sprints are per project. Status machine: planned → active → completed, and
reopen takes completed back to active. Use the dedicated start/complete/reopen
commands — update does not change status.

  multica sprint list <project> [--status planned|active|completed]
  multica sprint get <project> <sprint>
  multica sprint create <project> --name <n> [--goal g] [--start 2026-11-01] [--end 2026-11-14] [--capacity 20]
  multica sprint update <project> <sprint> [--name|--goal|--start|--end|--capacity]
  multica sprint start|complete|reopen <project> <sprint>
  multica sprint assign <project> <sprint> <issue-id>...   (moves issues into the sprint)
  multica sprint remove <project> <sprint> <issue-id>...   (back to the backlog)
  multica sprint progress <project> <sprint>
  multica sprint delete <project> <sprint> --yes           (issues are not deleted)`,
}

// ---------------------------------------------------------------------------
// sprint list / get
// ---------------------------------------------------------------------------

var sprintListCmd = &cobra.Command{
	Use:   "list <project>",
	Short: "List a project's sprints",
	Args:  exactArgs(1),
	RunE:  runSprintList,
}

var sprintGetCmd = &cobra.Command{
	Use:   "get <project> <sprint>",
	Short: "Show one sprint",
	Args:  exactArgs(2),
	RunE:  runSprintGet,
}

func init() {
	sprintListCmd.Flags().String("status", "", "Filter by status: planned | active | completed")
	sprintListCmd.Flags().String("output", "table", "Output format: table or json")
	sprintCmd.AddCommand(sprintListCmd)

	sprintGetCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintGetCmd)

	sprintCreateCmd.Flags().String("name", "", "Sprint name (required, max 80 chars)")
	sprintCreateCmd.Flags().String("goal", "", "Sprint goal")
	sprintCreateCmd.Flags().String("start", "", "Start date, YYYY-MM-DD")
	sprintCreateCmd.Flags().String("end", "", "End date, YYYY-MM-DD")
	sprintCreateCmd.Flags().Int("capacity", 0, "Capacity in issues (omit for unlimited)")
	sprintCreateCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintCreateCmd)

	sprintUpdateCmd.Flags().String("name", "", "New name")
	sprintUpdateCmd.Flags().String("goal", "", "New goal (empty string clears it)")
	sprintUpdateCmd.Flags().String("start", "", "New start date, YYYY-MM-DD")
	sprintUpdateCmd.Flags().String("end", "", "New end date, YYYY-MM-DD")
	sprintUpdateCmd.Flags().Int("capacity", 0, "New capacity")
	sprintUpdateCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintUpdateCmd)

	sprintStartCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintStartCmd)
	sprintCompleteCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintCompleteCmd)
	sprintReopenCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintReopenCmd)

	sprintAssignCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintAssignCmd)
	sprintRemoveCmd.Flags().String("output", "json", "Output format: table or json")
	sprintCmd.AddCommand(sprintRemoveCmd)

	sprintProgressCmd.Flags().String("output", "table", "Output format: table or json")
	sprintCmd.AddCommand(sprintProgressCmd)

	sprintDeleteCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(sprintDeleteCmd)
	sprintCmd.AddCommand(sprintDeleteCmd)
}

func runSprintList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	sprints, err := listSprints(ctx, client, projectRef.ID)
	if err != nil {
		return err
	}

	status, _ := cmd.Flags().GetString("status")
	status = strings.ToLower(strings.TrimSpace(status))
	filtered := make([]map[string]any, 0, len(sprints))
	for _, sprint := range sprints {
		if status != "" && strVal(sprint, "status") != status {
			continue
		}
		filtered = append(filtered, sprint)
	}

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"sprints": filtered, "total": len(filtered)})
	}
	headers := []string{"ID", "NAME", "STATUS", "START", "END", "CAPACITY"}
	rows := make([][]string, 0, len(filtered))
	for _, sprint := range filtered {
		rows = append(rows, []string{
			shortID(strVal(sprint, "id")),
			truncateCell(strVal(sprint, "name"), 40),
			strVal(sprint, "status"),
			blankDash(strVal(sprint, "start_date")),
			blankDash(strVal(sprint, "end_date")),
			blankDash(strVal(sprint, "capacity")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d sprint(s).\n", len(filtered))
	return nil
}

func runSprintGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	sprint, err := resolveSprint(ctx, client, projectRef.ID, args[1])
	if err != nil {
		return err
	}
	return printSprintResult(cmd, sprint)
}

// ---------------------------------------------------------------------------
// create / update / delete
// ---------------------------------------------------------------------------

var sprintCreateCmd = &cobra.Command{
	Use:   "create <project>",
	Short: "Create a sprint",
	Args:  exactArgs(1),
	RunE:  runSprintCreate,
}

func runSprintCreate(cmd *cobra.Command, args []string) error {
	name := flagOr(cmd, "name", "")
	if name == "" {
		return fmt.Errorf("--name is required")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	body := map[string]any{"name": name}
	if v := flagOr(cmd, "goal", ""); v != "" {
		body["goal"] = v
	}
	if v := flagOr(cmd, "start", ""); v != "" {
		body["start_date"] = v
	}
	if v := flagOr(cmd, "end", ""); v != "" {
		body["end_date"] = v
	}
	if cmd.Flags().Changed("capacity") {
		capacity, _ := cmd.Flags().GetInt("capacity")
		body["capacity"] = capacity
	}

	var created map[string]any
	if err := client.PostJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/sprints", body, &created); err != nil {
		return fmt.Errorf("create sprint: %w", err)
	}
	return printSprintResult(cmd, created)
}

var sprintUpdateCmd = &cobra.Command{
	Use:   "update <project> <sprint>",
	Short: "Update a sprint's name, goal, dates or capacity",
	Args:  exactArgs(2),
	RunE:  runSprintUpdate,
}

func runSprintUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	sprint, err := resolveSprint(ctx, client, projectRef.ID, args[1])
	if err != nil {
		return err
	}

	body := map[string]any{}
	for _, flag := range []string{"name", "goal", "start", "end"} {
		if !cmd.Flags().Changed(flag) {
			continue
		}
		value := flagOr(cmd, flag, "")
		switch flag {
		case "start":
			body["start_date"] = value
		case "end":
			body["end_date"] = value
		default:
			body[flag] = value
		}
	}
	if cmd.Flags().Changed("capacity") {
		capacity, _ := cmd.Flags().GetInt("capacity")
		body["capacity"] = capacity
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass at least one of --name, --goal, --start, --end, --capacity")
	}

	var updated map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/sprints/" + url.PathEscape(strVal(sprint, "id"))
	if err := client.PatchJSON(ctx, path, body, &updated); err != nil {
		return fmt.Errorf("update sprint: %w", err)
	}
	return printSprintResult(cmd, updated)
}

var sprintDeleteCmd = &cobra.Command{
	Use:   "delete <project> <sprint>",
	Short: "Delete a sprint (needs --yes; issues survive and fall back to the backlog)",
	Args:  exactArgs(2),
	RunE:  runSprintDelete,
}

func runSprintDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	sprint, err := resolveSprint(ctx, client, projectRef.ID, args[1])
	if err != nil {
		return err
	}
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Delete sprint %q (%s). The time box and its membership go away; the issues themselves are not deleted.",
		strVal(sprint, "name"), strVal(sprint, "id"))); err != nil {
		return err
	}

	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/sprints/" + url.PathEscape(strVal(sprint, "id"))
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("delete sprint: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Deleted sprint %s\n", strVal(sprint, "id"))
	return nil
}

// ---------------------------------------------------------------------------
// start / complete / reopen
// ---------------------------------------------------------------------------

var sprintStartCmd = &cobra.Command{
	Use:   "start <project> <sprint>",
	Short: "Start a planned sprint (needs --yes: it opens the time box)",
	Args:  exactArgs(2),
	RunE:  sprintAction("start", "starting"),
}

var sprintCompleteCmd = &cobra.Command{
	Use:   "complete <project> <sprint>",
	Short: "Complete an active sprint (needs --yes: it closes the time box)",
	Args:  exactArgs(2),
	RunE:  sprintAction("complete", "completing"),
}

var sprintReopenCmd = &cobra.Command{
	Use:   "reopen <project> <sprint>",
	Short: "Reopen a completed sprint (needs --yes: it reopens the time box)",
	Args:  exactArgs(2),
	RunE:  sprintAction("reopen", "reopening"),
}

// sprintAction is shared by start/complete/reopen. All three move a whole time
// box for everyone on the project, so they take the same confirmation gate as a
// delete: a person has to approve, an agent cannot flip the state alone.
func sprintAction(action, gerund string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		projectRef, err := resolveProjectID(ctx, client, args[0])
		if err != nil {
			return fmt.Errorf("resolve project: %w", err)
		}
		sprint, err := resolveSprint(ctx, client, projectRef.ID, args[1])
		if err != nil {
			return err
		}
		if err := confirmDestructive(cmd, fmt.Sprintf(
			"%s sprint %q (status now: %s, %d issue(s)). This affects everyone on the project.",
			strings.ToUpper(gerund[:1])+gerund[1:], strVal(sprint, "name"), strVal(sprint, "status"), sprintIssueCount(sprint))); err != nil {
			return err
		}

		var updated map[string]any
		path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/sprints/" + url.PathEscape(strVal(sprint, "id")) + "/" + action
		if err := client.PostJSON(ctx, path, nil, &updated); err != nil {
			return fmt.Errorf("%s sprint: %w", action, err)
		}
		return printSprintResult(cmd, updated)
	}
}

// ---------------------------------------------------------------------------
// assign / remove issues
// ---------------------------------------------------------------------------

var sprintAssignCmd = &cobra.Command{
	Use:   "assign <project> <sprint> <issue-id>...",
	Short: "Move issues into a sprint",
	Args:  cobra.MinimumNArgs(3),
	RunE:  sprintIssueMembership("assign"),
}

var sprintRemoveCmd = &cobra.Command{
	Use:   "remove <project> <sprint> <issue-id>...",
	Short: "Move issues out of a sprint (back to the backlog)",
	Args:  cobra.MinimumNArgs(3),
	RunE:  sprintIssueMembership("remove"),
}

func sprintIssueMembership(action string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		projectRef, err := resolveProjectID(ctx, client, args[0])
		if err != nil {
			return fmt.Errorf("resolve project: %w", err)
		}
		sprint, err := resolveSprint(ctx, client, projectRef.ID, args[1])
		if err != nil {
			return err
		}
		path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/sprints/" + url.PathEscape(strVal(sprint, "id")) + "/issues"
		body := map[string]any{"issue_ids": args[2:]}
		if action == "assign" {
			var result map[string]any
			if err := client.PostJSON(ctx, path, body, &result); err != nil {
				return fmt.Errorf("assign issues: %w", err)
			}
			return printSprintResult(cmd, result)
		}
		if err := client.DeleteJSONWithBody(ctx, path, body); err != nil {
			return fmt.Errorf("remove issues from sprint: %w", err)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed %d issue(s) from sprint %s\n", len(args)-2, strVal(sprint, "id"))
		return nil
	}
}

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

var sprintProgressCmd = &cobra.Command{
	Use:   "progress <project> <sprint>",
	Short: "Done / cancelled / total counts against capacity",
	Args:  exactArgs(2),
	RunE:  runSprintProgress,
}

func runSprintProgress(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	sprint, err := resolveSprint(ctx, client, projectRef.ID, args[1])
	if err != nil {
		return err
	}
	var progress map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/sprints/" + url.PathEscape(strVal(sprint, "id")) + "/progress"
	if err := client.GetJSON(ctx, path, &progress); err != nil {
		return fmt.Errorf("get sprint progress: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), progress)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s  status=%s  done=%s cancelled=%s total=%s capacity=%s\n",
		strVal(sprint, "name"),
		blankDash(strVal(progress, "sprint_status")),
		blankDash(strVal(progress, "done_count")),
		blankDash(strVal(progress, "cancelled_count")),
		blankDash(strVal(progress, "total_count")),
		blankDash(strVal(progress, "capacity")),
	)
	return nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func listSprints(ctx context.Context, client *cli.APIClient, projectID string) ([]map[string]any, error) {
	var payload struct {
		Sprints []map[string]any `json:"sprints"`
	}
	if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectID)+"/sprints", &payload); err != nil {
		return nil, fmt.Errorf("list sprints: %w", err)
	}
	return payload.Sprints, nil
}

// resolveSprint accepts a full id, an id prefix, or an exact (case-insensitive)
// name, matching how the other resolvers behave so agents can stay with names.
func resolveSprint(ctx context.Context, client *cli.APIClient, projectID, ref string) (map[string]any, error) {
	sprints, err := listSprints(ctx, client, projectID)
	if err != nil {
		return nil, err
	}
	ref = strings.TrimSpace(ref)
	var byName map[string]any
	for _, sprint := range sprints {
		id := strVal(sprint, "id")
		if id == ref {
			return sprint, nil
		}
		if strings.HasPrefix(id, ref) {
			return sprint, nil
		}
		if byName == nil && strings.EqualFold(strVal(sprint, "name"), ref) {
			byName = sprint
		}
	}
	if byName != nil {
		return byName, nil
	}
	return nil, fmt.Errorf("sprint %q not found in project %s; run `multica sprint list %s`", ref, projectID, projectID)
}

func printSprintResult(cmd *cobra.Command, sprint map[string]any) error {
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		headers := []string{"ID", "NAME", "STATUS", "START", "END", "CAPACITY"}
		row := []string{
			shortID(strVal(sprint, "id")),
			truncateCell(strVal(sprint, "name"), 40),
			blankDash(strVal(sprint, "status")),
			blankDash(strVal(sprint, "start_date")),
			blankDash(strVal(sprint, "end_date")),
			blankDash(strVal(sprint, "capacity")),
		}
		cli.PrintTable(cmd.OutOrStdout(), headers, [][]string{row})
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), sprint)
}

func sprintIssueCount(sprint map[string]any) int {
	for _, key := range []string{"issue_count", "total_count", "issues"} {
		switch value := sprint[key].(type) {
		case float64:
			return int(value)
		case []any:
			return len(value)
		case string:
			if n, err := strconv.Atoi(value); err == nil {
				return n
			}
		}
	}
	return 0
}
