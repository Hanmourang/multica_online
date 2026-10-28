package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 项目工作流（issue-workflows）与 `multica workflow` 不是一回事：后者是流程引擎
// 的模板/实例；这里描述的是「看板的列 + 每条列上自动交接给谁」。UI 的项目设置
// 页与工作流编辑器全部落在这组端点上。
var issueWorkflowCmd = &cobra.Command{
	Use:   "issue-workflow",
	Short: "Manage board workflows: which statuses exist and who handles each column",
	Long: `A workflow is an ordered list of statuses, each carrying a handoff: who gets the
issue when it lands there, what instructions their run receives, and which column
it moves to next. "todo", "done" and "cancelled" are added when missing; backlog
and blocked appear only when you list them.

  multica issue-workflow list
  multica issue-workflow get <id>
  multica issue-workflow create --name "Design review" --order todo,in_review,done
  multica issue-workflow update <id> --order todo,in_review,done --dry-run
  multica issue-workflow update <id> --steps-file ./steps.json --mapping in_review=done
  multica issue-workflow handoff <id> in_review --handler-type agent --handler <agent> \
      --instructions "Check the mock against the spec" --next done
  multica issue-workflow brief <id> --status-key in_review --handler-type agent --handler <agent>
  multica issue-workflow delete <id> --yes

--steps takes the raw step array (status_key | new_status, handler, instructions,
next_status_key, back_status_key); --order is the shorthand when you only want to
choose which columns exist and in what order. Every edit runs --dry-run first
when you ask for it, returning the status-mapping plan without writing.`,
}

var issueWorkflowListCmd = &cobra.Command{
	Use:   "list",
	Short: "List workflows (the default first)",
	Args:  cobra.NoArgs,
	RunE:  runIssueWorkflowList,
}

var issueWorkflowGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Show one workflow with its steps and handoffs",
	Args:  exactArgs(1),
	RunE:  runIssueWorkflowGet,
}

var issueWorkflowCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a workflow",
	Args:  cobra.NoArgs,
	RunE:  runIssueWorkflowCreate,
}

var issueWorkflowUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Change a workflow's name, description or steps",
	Args:  exactArgs(1),
	RunE:  runIssueWorkflowUpdate,
}

var issueWorkflowDeleteCmd = &cobra.Command{
	Use:   "delete <id> --yes",
	Short: "Delete a workflow",
	Args:  exactArgs(1),
	RunE:  runIssueWorkflowDelete,
}

var issueWorkflowHandoffCmd = &cobra.Command{
	Use:   "handoff <id> <status-key>",
	Short: "Set who handles one column and what happens next",
	Args:  exactArgs(2),
	RunE:  runIssueWorkflowHandoff,
}

var issueWorkflowBriefCmd = &cobra.Command{
	Use:   "brief <id>",
	Short: "Preview the brief a column's handler would receive",
	Args:  exactArgs(1),
	RunE:  runIssueWorkflowBrief,
}

func init() {
	issueWorkflowListCmd.Flags().Int("limit", 0, "Cap the rows printed (0 = all)")
	issueWorkflowListCmd.Flags().Bool("full-id", false, "Print full ids instead of 8-character prefixes")
	issueWorkflowListCmd.Flags().String("output", "table", "Output format: table or json")

	for _, c := range []*cobra.Command{issueWorkflowGetCmd} {
		c.Flags().String("output", "json", "Output format: json or table")
	}

	for _, c := range []*cobra.Command{issueWorkflowCreateCmd, issueWorkflowUpdateCmd} {
		c.Flags().String("name", "", "Workflow name (required on create)")
		c.Flags().String("description", "", "Workflow description")
		c.Flags().String("steps", "", `Raw step array, e.g. '[{"status_key":"todo"},{"status_key":"in_review"}]'`)
		c.Flags().String("steps-file", "", "Read --steps from a JSON file inside the working directory")
		c.Flags().String("order", "", "Comma-separated status keys, e.g. todo,backlog,done (shorthand for --steps)")
		c.Flags().String("mapping", "", "Status mapping for removed statuses, e.g. in_review=done,triage=todo")
		c.Flags().Bool("dry-run", false, "Validate and return the mapping plan without writing")
		c.Flags().Bool("allow-external-file", false, "Allow --steps-file outside the working directory")
		c.Flags().String("output", "json", "Output format: json or table")
	}
	addDestructiveFlags(issueWorkflowDeleteCmd)

	issueWorkflowHandoffCmd.Flags().String("handler-type", "", "none | agent | squad | member | project_lead | creator")
	issueWorkflowHandoffCmd.Flags().String("handler", "", "Agent / squad / member id the handoff targets")
	issueWorkflowHandoffCmd.Flags().String("instructions", "", "Instructions the handler's run receives")
	issueWorkflowHandoffCmd.Flags().String("instructions-file", "", "Read --instructions from a UTF-8 file inside the working directory")
	issueWorkflowHandoffCmd.Flags().Bool("instructions-stdin", false, "Read --instructions from stdin")
	issueWorkflowHandoffCmd.Flags().String("next", "", "Status the handler moves the issue to next")
	issueWorkflowHandoffCmd.Flags().String("back", "", "Status the handler may send the issue back to")
	issueWorkflowHandoffCmd.Flags().String("copy-for-project", "", "Save on a copy used only by this project")
	issueWorkflowHandoffCmd.Flags().Bool("allow-external-file", false, "Allow --instructions-file outside the working directory")
	issueWorkflowHandoffCmd.Flags().String("output", "json", "Output format: json or table")

	issueWorkflowBriefCmd.Flags().String("status-key", "", "Column to render the brief for (required)")
	issueWorkflowBriefCmd.Flags().String("handler-type", "none", "none | agent | squad | member | project_lead | creator")
	issueWorkflowBriefCmd.Flags().String("handler", "", "Agent / squad / member id the handoff targets")
	issueWorkflowBriefCmd.Flags().String("instructions", "", "Instructions the handler's run receives")
	issueWorkflowBriefCmd.Flags().String("instructions-file", "", "Read --instructions from a UTF-8 file inside the working directory")
	issueWorkflowBriefCmd.Flags().Bool("instructions-stdin", false, "Read --instructions from stdin")
	issueWorkflowBriefCmd.Flags().String("next", "", "Status the handler moves the issue to next")
	issueWorkflowBriefCmd.Flags().String("back", "", "Status the handler may send the issue back to")
	issueWorkflowBriefCmd.Flags().String("project", "", "Render the brief as if delivered inside this project")
	issueWorkflowBriefCmd.Flags().Bool("allow-external-file", false, "Allow --instructions-file outside the working directory")
	issueWorkflowBriefCmd.Flags().String("output", "json", "Output format: json or table")

	issueWorkflowCmd.AddCommand(issueWorkflowListCmd)
	issueWorkflowCmd.AddCommand(issueWorkflowGetCmd)
	issueWorkflowCmd.AddCommand(issueWorkflowCreateCmd)
	issueWorkflowCmd.AddCommand(issueWorkflowUpdateCmd)
	issueWorkflowCmd.AddCommand(issueWorkflowDeleteCmd)
	issueWorkflowCmd.AddCommand(issueWorkflowHandoffCmd)
	issueWorkflowCmd.AddCommand(issueWorkflowBriefCmd)
}

// resolveIssueWorkflowID accepts a full UUID or a unique prefix.
func resolveIssueWorkflowID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "issue workflow", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var workflows []map[string]any
		if err := client.GetJSON(ctx, "/api/issue-workflows", &workflows); err != nil {
			return nil, err
		}
		out := make([]idCandidate, 0, len(workflows))
		for _, w := range workflows {
			out = append(out, idCandidate{
				ID:      strVal(w, "id"),
				Display: strVal(w, "name"),
				Detail:  workflowStepKeys(w),
			})
		}
		return out, nil
	})
}

func runIssueWorkflowList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var workflows []map[string]any
	if err := client.GetJSON(ctx, "/api/issue-workflows", &workflows); err != nil {
		return fmt.Errorf("list issue workflows: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(workflows, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"workflows": rows, "total": len(workflows)})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	out := make([][]string, 0, len(rows))
	for _, w := range rows {
		id := strVal(w, "id")
		if !fullID {
			id = shortID(id)
		}
		out = append(out, []string{
			id,
			truncateCell(blankDash(strVal(w, "name")), 32),
			yesNo(isTrue(w["is_default"])),
			workflowStepKeys(w),
			compactCount(w, "project_count"),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "NAME", "DEFAULT", "STEPS", "PROJECTS"}, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d workflow(s).\n", len(rows))
	return nil
}

// workflowStepKeys renders a workflow's columns as "todo > doing > done".
func workflowStepKeys(w map[string]any) string {
	steps, _ := w["steps"].([]any)
	if len(steps) == 0 {
		return "-"
	}
	keys := make([]string, 0, len(steps))
	for _, raw := range steps {
		step, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		keys = append(keys, strVal(step, "status_key"))
	}
	return truncateCell(strings.Join(keys, " > "), 54)
}

func runIssueWorkflowGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	var workflow map[string]any
	if err := client.GetJSON(ctx, "/api/issue-workflows/"+url.PathEscape(ref.ID), &workflow); err != nil {
		return fmt.Errorf("get issue workflow: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), workflow)
}

// workflowWriteBody assembles the shared IssueWorkflowWriteRequest payload.
func workflowWriteBody(cmd *cobra.Command) (map[string]any, error) {
	body := map[string]any{}
	if cmd.Flags().Changed("name") {
		name, _ := cmd.Flags().GetString("name")
		body["name"] = strings.TrimSpace(name)
	}
	if cmd.Flags().Changed("description") {
		description, _ := cmd.Flags().GetString("description")
		body["description"] = description
	}

	order, _ := cmd.Flags().GetString("order")
	rawSteps, _ := cmd.Flags().GetString("steps")
	if strings.TrimSpace(order) != "" && strings.TrimSpace(rawSteps) != "" {
		return nil, fmt.Errorf("--order and --steps are mutually exclusive")
	}
	switch {
	case strings.TrimSpace(order) != "":
		keys := strings.Split(order, ",")
		steps := make([]map[string]any, 0, len(keys))
		seen := map[string]bool{}
		for _, key := range keys {
			key = strings.TrimSpace(key)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			steps = append(steps, map[string]any{"status_key": key})
		}
		if len(steps) == 0 {
			return nil, fmt.Errorf("--order listed no usable status keys")
		}
		body["steps"] = steps
	default:
		if steps, ok, err := jsonFlagArray(cmd, "steps"); err != nil {
			return nil, err
		} else if ok {
			body["steps"] = steps
		}
	}

	if mapping, _ := cmd.Flags().GetString("mapping"); strings.TrimSpace(mapping) != "" {
		parsed := map[string]string{}
		for _, pair := range strings.Split(mapping, ",") {
			parts := strings.SplitN(pair, "=", 2)
			if len(parts) != 2 {
				return nil, fmt.Errorf("--mapping expects from=to pairs, got %q", pair)
			}
			parsed[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
		body["status_mapping"] = parsed
	}
	if dryRun, _ := cmd.Flags().GetBool("dry-run"); dryRun {
		body["dry_run"] = true
	}
	return body, nil
}

func runIssueWorkflowCreate(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("--name is required")
	}
	body, err := workflowWriteBody(cmd)
	if err != nil {
		return err
	}
	return doJSONWrite(cmd, "POST", "/api/issue-workflows", body, "create issue workflow")
}

func runIssueWorkflowUpdate(cmd *cobra.Command, args []string) error {
	body, err := workflowWriteBody(cmd)
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --description, --steps or --order")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	path := "/api/issue-workflows/" + url.PathEscape(ref.ID)
	return doJSONWrite(cmd, "PATCH", path, body, "update issue workflow")
}

func runIssueWorkflowDelete(cmd *cobra.Command, args []string) error {
	hint := fmt.Sprintf("Delete issue workflow %s. Projects using it fall back to the default workflow.", args[0])
	if err := confirmDestructive(cmd, hint); err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	if err := client.DeleteJSON(ctx, "/api/issue-workflows/"+url.PathEscape(ref.ID)); err != nil {
		return fmt.Errorf("delete issue workflow: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "deleted issue workflow %s\n", ref.ID)
	return nil
}

// handoffPayload builds IssueWorkflowStepPayload from the shared handoff flags.
func handoffPayload(cmd *cobra.Command, statusKey string) (map[string]any, error) {
	payload := map[string]any{"status_key": statusKey}
	handlerType, _ := cmd.Flags().GetString("handler-type")
	handlerType = strings.TrimSpace(handlerType)
	handlerID, _ := cmd.Flags().GetString("handler")
	handlerID = strings.TrimSpace(handlerID)
	if handlerType != "" {
		switch handlerType {
		case "none", "project_lead", "creator":
			if handlerID != "" {
				return nil, fmt.Errorf("--handler is not used with --handler-type %s", handlerType)
			}
		case "agent", "squad", "member":
			if handlerID == "" {
				return nil, fmt.Errorf("--handler is required with --handler-type %s", handlerType)
			}
		default:
			return nil, fmt.Errorf("--handler-type must be none, agent, squad, member, project_lead or creator")
		}
		handler := map[string]any{"type": handlerType}
		if handlerID != "" {
			handler["id"] = handlerID
		}
		payload["handler"] = handler
	}

	instructions, set, err := resolveTextFlag(cmd, "instructions")
	if err != nil {
		return nil, err
	}
	if set {
		payload["instructions"] = instructions
	}
	if next, _ := cmd.Flags().GetString("next"); strings.TrimSpace(next) != "" {
		payload["next_status_key"] = strings.TrimSpace(next)
	}
	if back, _ := cmd.Flags().GetString("back"); strings.TrimSpace(back) != "" {
		payload["back_status_key"] = strings.TrimSpace(back)
	}
	return payload, nil
}

func runIssueWorkflowHandoff(cmd *cobra.Command, args []string) error {
	payload, err := handoffPayload(cmd, strings.TrimSpace(args[1]))
	if err != nil {
		return err
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	if copyFor, _ := cmd.Flags().GetString("copy-for-project"); strings.TrimSpace(copyFor) != "" {
		payload["copy_for_project_id"] = strings.TrimSpace(copyFor)
	}
	path := "/api/issue-workflows/" + url.PathEscape(ref.ID) + "/handoffs/" + url.PathEscape(strings.TrimSpace(args[1]))
	return doJSONWrite(cmd, "PUT", path, payload, "set workflow handoff")
}

func runIssueWorkflowBrief(cmd *cobra.Command, args []string) error {
	statusKey, _ := cmd.Flags().GetString("status-key")
	statusKey = strings.TrimSpace(statusKey)
	if statusKey == "" {
		return fmt.Errorf("--status-key is required")
	}
	payload, err := handoffPayload(cmd, statusKey)
	if err != nil {
		return err
	}
	if project, _ := cmd.Flags().GetString("project"); strings.TrimSpace(project) != "" {
		payload["project_id"] = strings.TrimSpace(project)
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	ref, err := resolveIssueWorkflowID(ctx, client, args[0])
	if err != nil {
		return err
	}
	path := "/api/issue-workflows/" + url.PathEscape(ref.ID) + "/brief"
	return doJSONWrite(cmd, "POST", path, payload, "preview workflow brief")
}

// jsonFlagArray reads a JSON array flag, optionally from a file.
func jsonFlagArray(cmd *cobra.Command, flagName string) ([]any, bool, error) {
	raw, _ := cmd.Flags().GetString(flagName)
	if filePath, _ := cmd.Flags().GetString(flagName + "-file"); strings.TrimSpace(filePath) != "" {
		if strings.TrimSpace(raw) != "" {
			return nil, false, fmt.Errorf("--%s and --%s-file are mutually exclusive", flagName, flagName)
		}
		if err := ensureFileFlagWithinWorkdir(cmd, flagName+"-file", flagName, filePath); err != nil {
			return nil, false, err
		}
		data, err := readWorkdirFile(filePath)
		if err != nil {
			return nil, false, err
		}
		raw = string(data)
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, false, nil
	}
	var out []any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, false, fmt.Errorf("--%s must be a JSON array: %w", flagName, err)
	}
	return out, true, nil
}
