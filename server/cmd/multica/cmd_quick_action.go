package main

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 快捷动作（quick actions）是 issue 详情页上的「一键派活」按钮：它把一段预先
// 写好的 prompt 交给某个 agent 或 squad。定义是工作区级配置（本文件的写面），
// 真正触发一次运行是 `multica issue quick-action run`（见 cmd_issue.go 那侧）。
var quickActionCmd = &cobra.Command{
	Use:   "quick-action",
	Short: "Define the one-click actions that dispatch an issue to an agent or squad",
	Long: `A quick action is a named prompt bound to an assignee (agent or squad). Running
one is a separate, issue-scoped command:

  multica issue quick-action run <issue> <quick-action>

  multica quick-action list [--include-archived]
  multica quick-action create --name "Triage" --assignee-type agent --assignee <id> \
      --prompt "Read the report and file sub-issues" [--visibility private|public]
  multica quick-action update <id> [--name ...] [--prompt ...] [--status active|archived]
  multica quick-action delete <id> --yes

"public" makes the action usable by every workspace member; it requires the
workspace owner/admin role and a target agent that everyone may invoke.`,
}

var quickActionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List quick actions",
	Args:  cobra.NoArgs,
	RunE:  runQuickActionList,
}

var quickActionCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a quick action",
	Args:  cobra.NoArgs,
	RunE:  runQuickActionCreate,
}

var quickActionUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Change a quick action",
	Args:  exactArgs(1),
	RunE:  runQuickActionUpdate,
}

var quickActionDeleteCmd = &cobra.Command{
	Use:   "delete <id> --yes",
	Short: "Delete a quick action",
	Args:  exactArgs(1),
	RunE:  runQuickActionDelete,
}

// 以下两条是 issue 侧的触发面：它们挂在 `multica issue quick-action` 下，
// 因为「跑一次」总是针对一个具体 issue 的。
var issueQuickActionCmd = &cobra.Command{
	Use:   "quick-action",
	Short: "Run a quick action against one issue",
	Long: `Running is a real dispatch: it posts the action's prompt as a comment on the
issue and starts a task for the bound agent or squad.

  multica issue quick-action run <issue> <quick-action>
  multica issue quick-action render <issue> <quick-action>   (preview the prompt only)

<quick-action> takes the full id or a unique prefix (copy one with
"multica quick-action list --full-id").`,
}

var issueQuickActionRunCmd = &cobra.Command{
	Use:   "run <issue> <quick-action>",
	Short: "Run a quick action on an issue (starts a task)",
	Args:  exactArgs(2),
	RunE:  issueQuickActionAction("run", "run quick action"),
}

var issueQuickActionRenderCmd = &cobra.Command{
	Use:   "render <issue> <quick-action>",
	Short: "Render the prompt a quick action would post, without dispatching",
	Args:  exactArgs(2),
	RunE:  issueQuickActionAction("render", "render quick action"),
}

func init() {
	quickActionListCmd.Flags().Bool("include-archived", false, "Also list archived actions")
	quickActionListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	quickActionListCmd.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
	quickActionListCmd.Flags().String("output", "table", "Output format: table or json")

	quickActionCreateCmd.Flags().String("name", "", "Action name (required)")
	quickActionCreateCmd.Flags().String("description", "", "Short description shown under the button")
	quickActionCreateCmd.Flags().String("assignee-type", "agent", "agent | squad")
	quickActionCreateCmd.Flags().String("assignee", "", "Agent or squad id (required)")
	quickActionCreateCmd.Flags().String("prompt", "", "Prompt handed to the assignee (required)")
	quickActionCreateCmd.Flags().Bool("prompt-stdin", false, "Read the prompt from stdin")
	quickActionCreateCmd.Flags().String("prompt-file", "", "Read --prompt from a UTF-8 file inside the working directory")
	quickActionCreateCmd.Flags().Bool("allow-external-file", false, "Allow --prompt-file outside the working directory")
	quickActionCreateCmd.Flags().String("visibility", "private", "private | public")
	quickActionCreateCmd.Flags().String("output", "json", "Output format: json or table")

	quickActionUpdateCmd.Flags().String("name", "", "New name")
	quickActionUpdateCmd.Flags().String("description", "", "New description")
	quickActionUpdateCmd.Flags().String("assignee-type", "", "New type: agent | squad")
	quickActionUpdateCmd.Flags().String("assignee", "", "New agent or squad id")
	quickActionUpdateCmd.Flags().String("prompt", "", "New prompt")
	quickActionUpdateCmd.Flags().Bool("prompt-stdin", false, "Read the new prompt from stdin")
	quickActionUpdateCmd.Flags().String("prompt-file", "", "Read --prompt from a UTF-8 file inside the working directory")
	quickActionUpdateCmd.Flags().Bool("allow-external-file", false, "Allow --prompt-file outside the working directory")
	quickActionUpdateCmd.Flags().String("visibility", "", "private | public")
	quickActionUpdateCmd.Flags().String("status", "", "active | archived")
	quickActionUpdateCmd.Flags().String("output", "json", "Output format: json or table")
	addDestructiveFlags(quickActionDeleteCmd)

	for _, c := range []*cobra.Command{issueQuickActionRunCmd, issueQuickActionRenderCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	quickActionCmd.AddCommand(quickActionListCmd)
	quickActionCmd.AddCommand(quickActionCreateCmd)
	quickActionCmd.AddCommand(quickActionUpdateCmd)
	quickActionCmd.AddCommand(quickActionDeleteCmd)

	issueCmd.AddCommand(issueQuickActionCmd)
	issueQuickActionCmd.AddCommand(issueQuickActionRunCmd)
	issueQuickActionCmd.AddCommand(issueQuickActionRenderCmd)
}

// issueQuickActionAction POSTs to the issue-scoped run or render endpoint.
func issueQuickActionAction(action, verb string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()

		issueRef, err := resolveIssueRef(ctx, client, args[0])
		if err != nil {
			return fmt.Errorf("resolve issue: %w", err)
		}
		path := "/api/issues/" + url.PathEscape(issueRef.ID) + "/quick-actions/" + url.PathEscape(strings.TrimSpace(args[1])) + "/" + action
		var resp map[string]any
		if err := client.PostJSON(ctx, path, nil, &resp); err != nil {
			return fmt.Errorf("%s: %w", verb, err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), resp)
	}
}

// resolveQuickActionID accepts a full UUID or a unique prefix.
func resolveQuickActionID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "quick action", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var resp struct {
			QuickActions []map[string]any `json:"quick_actions"`
		}
		if err := client.GetJSON(ctx, "/api/quick-actions?include_archived=true", &resp); err != nil {
			return nil, err
		}
		out := make([]idCandidate, 0, len(resp.QuickActions))
		for _, qa := range resp.QuickActions {
			out = append(out, idCandidate{
				ID:      strVal(qa, "id"),
				Display: strVal(qa, "name"),
				Detail:  strVal(qa, "assignee_type"),
			})
		}
		return out, nil
	})
}

func runQuickActionList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	path := "/api/quick-actions"
	if include, _ := cmd.Flags().GetBool("include-archived"); include {
		path += "?include_archived=true"
	}
	var resp struct {
		QuickActions []map[string]any `json:"quick_actions"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("list quick actions: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(resp.QuickActions, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"quick_actions": rows, "total": len(resp.QuickActions)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, qa := range rows {
		id := strVal(qa, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			truncateCell(blankDash(strVal(qa, "name")), 32),
			blankDash(strVal(qa, "assignee_type")),
			shortID(strVal(qa, "assignee_id")),
			blankDash(strVal(qa, "visibility")),
			blankDash(strVal(qa, "status")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "TYPE", "ASSIGNEE", "VISIBILITY", "STATUS"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d quick action(s). Run one with `multica issue quick-action run <issue> <id>`.\n", len(rows))
	return nil
}

func runQuickActionCreate(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}
	assigneeType, _ := cmd.Flags().GetString("assignee-type")
	assigneeType = strings.ToLower(strings.TrimSpace(assigneeType))
	if assigneeType != "agent" && assigneeType != "squad" {
		return fmt.Errorf("--assignee-type must be agent or squad")
	}
	assignee, _ := cmd.Flags().GetString("assignee")
	if strings.TrimSpace(assignee) == "" {
		return fmt.Errorf("--assignee is required (list with `multica agent list` or `multica squad list`)")
	}
	prompt, _, err := resolveTextFlag(cmd, "prompt")
	if err != nil {
		return err
	}
	if strings.TrimSpace(prompt) == "" {
		return fmt.Errorf("--prompt (or --prompt-file / --prompt-stdin) is required")
	}
	visibility, _ := cmd.Flags().GetString("visibility")
	visibility = strings.ToLower(strings.TrimSpace(visibility))
	if visibility != "private" && visibility != "public" {
		return fmt.Errorf("--visibility must be private or public")
	}

	body := map[string]any{
		"name":          strings.TrimSpace(name),
		"assignee_type": assigneeType,
		"assignee_id":   strings.TrimSpace(assignee),
		"prompt":        prompt,
		"visibility":    visibility,
	}
	if description, _ := cmd.Flags().GetString("description"); strings.TrimSpace(description) != "" {
		body["description"] = description
	}
	return doJSONWrite(cmd, "POST", "/api/quick-actions", body, "create quick action")
}

func runQuickActionUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveQuickActionID(ctx, client, args[0])
	if err != nil {
		return err
	}

	body := map[string]any{}
	for _, flag := range []string{"name", "description", "assignee-type", "assignee", "visibility", "status"} {
		if !cmd.Flags().Changed(flag) {
			continue
		}
		value, _ := cmd.Flags().GetString(flag)
		key := map[string]string{
			"assignee-type": "assignee_type",
			"assignee":      "assignee_id",
		}[flag]
		if key == "" {
			key = flag
		}
		body[key] = value
	}
	prompt, promptSet, err := resolveTextFlag(cmd, "prompt")
	if err != nil {
		return err
	}
	if promptSet {
		body["prompt"] = prompt
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --description, --assignee-type, --assignee, --prompt, --visibility or --status")
	}
	// assignee_type and assignee_id move together server-side; refuse a
	// half-swap locally instead of letting the request 400.
	_, typeSet := body["assignee_type"]
	_, idSet := body["assignee_id"]
	if typeSet != idSet {
		return fmt.Errorf("--assignee-type and --assignee must be changed together")
	}

	path := "/api/quick-actions/" + url.PathEscape(ref.ID)
	return doJSONWrite(cmd, "PATCH", path, body, "update quick action")
}

func runQuickActionDelete(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf("Delete quick action %s. Any automation pointing at it stops working.", args[0])); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveQuickActionID(ctx, client, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, "/api/quick-actions/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("delete quick action: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted quick action %s\n", ref.ID)
	return nil
}
