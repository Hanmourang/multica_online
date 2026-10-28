package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

// requirement 命令覆盖需求的非删除操作。顶层 issue 带 start_at（或绑定仓库、
// 完成拆解、被触发）后才是需求；任务仍走 multica issue。本命令不提供删除。

var requirementCmd = &cobra.Command{
	Use:   "requirement",
	Short: "Create and operate requirements (no delete)",
	Long: `Requirements are top-level issues with a planned start time, a bound repo,
or a decomposition/trigger record. Tasks stay on "multica issue".

This command exposes the non-delete requirement workflow: create, read, update,
roster, decomposition, trigger, acceptance, and prototypes.`,
}

var requirementCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a requirement",
	RunE:  runRequirementCreate,
}

var requirementGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get a requirement",
	Args:  exactArgs(1),
	RunE:  runRequirementGet,
}

var requirementListCmd = &cobra.Command{
	Use:   "list",
	Short: "List requirements",
	RunE:  runRequirementList,
}

var requirementUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Update a requirement",
	Args:  exactArgs(1),
	RunE:  runRequirementUpdate,
}

var requirementRolesCmd = &cobra.Command{
	Use:   "roles",
	Short: "Read or replace a requirement roster",
}

var requirementRolesListCmd = &cobra.Command{
	Use:   "list <id>",
	Short: "List the requirement roster",
	Args:  exactArgs(1),
	RunE:  runRequirementRolesList,
}

var requirementRolesSetCmd = &cobra.Command{
	Use:   "set <id>",
	Short: "Replace the requirement roster from a JSON file",
	Args:  exactArgs(1),
	RunE:  runRequirementRolesSet,
}

var requirementDecomposeCmd = &cobra.Command{
	Use:   "decompose <id>",
	Short: "Start requirement decomposition",
	Args:  exactArgs(1),
	RunE:  runRequirementDecompose,
}

var requirementDecompositionCmd = &cobra.Command{
	Use:   "decomposition <id>",
	Short: "Read the current decomposition",
	Args:  exactArgs(1),
	RunE:  runRequirementDecomposition,
}

var requirementConfirmCmd = &cobra.Command{
	Use:   "confirm <id>",
	Short: "Confirm a decomposition draft file",
	Args:  exactArgs(1),
	RunE:  runRequirementConfirm,
}

var requirementTriggerCmd = &cobra.Command{
	Use:   "trigger <id>",
	Short: "Trigger a confirmed requirement now",
	Args:  exactArgs(1),
	RunE:  runRequirementTrigger,
}

var requirementAcceptanceCmd = &cobra.Command{
	Use:   "acceptance",
	Short: "Record acceptance verdict or checked criteria",
}

var requirementAcceptanceVerdictCmd = &cobra.Command{
	Use:   "verdict <id>",
	Short: "Record pass or fail for a requirement",
	Args:  exactArgs(1),
	RunE:  runRequirementAcceptanceVerdict,
}

var requirementAcceptanceCriteriaCmd = &cobra.Command{
	Use:   "criteria <id>",
	Short: "Save checked acceptance criteria",
	Args:  exactArgs(1),
	RunE:  runRequirementAcceptanceCriteria,
}

var requirementPrototypeCmd = &cobra.Command{
	Use:   "prototype",
	Short: "List, generate, register, or confirm prototypes",
}

var requirementPrototypeListCmd = &cobra.Command{
	Use:   "list <id>",
	Short: "List prototype versions",
	Args:  exactArgs(1),
	RunE:  runRequirementPrototypeList,
}

var requirementPrototypeGenerateCmd = &cobra.Command{
	Use:   "generate <id>",
	Short: "Generate a prototype version",
	Args:  exactArgs(1),
	RunE:  runRequirementPrototypeGenerate,
}

var requirementPrototypeRegisterCmd = &cobra.Command{
	Use:   "register <id>",
	Short: "Register an existing HTML prototype",
	Args:  exactArgs(1),
	RunE:  runRequirementPrototypeRegister,
}

var requirementPrototypeConfirmCmd = &cobra.Command{
	Use:   "confirm <id> <version>",
	Short: "Confirm a prototype version",
	Args:  exactArgs(2),
	RunE:  runRequirementPrototypeConfirm,
}

var projectRolesCmd = &cobra.Command{
	Use:   "roles",
	Short: "Read or replace a project's default requirement roster",
}

var projectRolesListCmd = &cobra.Command{
	Use:   "list <project-id>",
	Short: "List project role defaults",
	Args:  exactArgs(1),
	RunE:  runProjectRolesList,
}

var projectRolesSetCmd = &cobra.Command{
	Use:   "set <project-id>",
	Short: "Replace project role defaults from a JSON file",
	Args:  exactArgs(1),
	RunE:  runProjectRolesSet,
}

func init() {
	requirementCmd.AddCommand(requirementCreateCmd)
	requirementCmd.AddCommand(requirementGetCmd)
	requirementCmd.AddCommand(requirementListCmd)
	requirementCmd.AddCommand(requirementUpdateCmd)
	requirementCmd.AddCommand(requirementRolesCmd)
	requirementCmd.AddCommand(requirementDecomposeCmd)
	requirementCmd.AddCommand(requirementDecompositionCmd)
	requirementCmd.AddCommand(requirementConfirmCmd)
	requirementCmd.AddCommand(requirementTriggerCmd)
	requirementCmd.AddCommand(requirementAcceptanceCmd)
	requirementCmd.AddCommand(requirementPrototypeCmd)

	requirementRolesCmd.AddCommand(requirementRolesListCmd)
	requirementRolesCmd.AddCommand(requirementRolesSetCmd)
	requirementAcceptanceCmd.AddCommand(requirementAcceptanceVerdictCmd)
	requirementAcceptanceCmd.AddCommand(requirementAcceptanceCriteriaCmd)
	requirementPrototypeCmd.AddCommand(requirementPrototypeListCmd)
	requirementPrototypeCmd.AddCommand(requirementPrototypeGenerateCmd)
	requirementPrototypeCmd.AddCommand(requirementPrototypeRegisterCmd)
	requirementPrototypeCmd.AddCommand(requirementPrototypeConfirmCmd)

	projectCmd.AddCommand(projectRolesCmd)
	projectRolesCmd.AddCommand(projectRolesListCmd)
	projectRolesCmd.AddCommand(projectRolesSetCmd)

	requirementCreateCmd.Flags().String("title", "", "Requirement title (required)")
	requirementCreateCmd.Flags().String("description", "", "Requirement description")
	requirementCreateCmd.Flags().String("project", "", "Project id or title")
	requirementCreateCmd.Flags().String("goal", "", "Requirement goal")
	requirementCreateCmd.Flags().String("start-at", "", "Planned start time, RFC3339 (required unless --start-date/--due-date is given; this marks the issue as a requirement)")
	requirementCreateCmd.Flags().String("start-date", "", "Planned start day, YYYY-MM-DD — derived into start_at at 09:00 local")
	requirementCreateCmd.Flags().String("due-date", "", "Due day, YYYY-MM-DD")
	requirementCreateCmd.Flags().String("repo-resource", "", "Project resource id of the git repo")
	requirementCreateCmd.Flags().String("decompose-mode", "confirm", "auto, confirm, or manual")
	requirementCreateCmd.Flags().Bool("auto-trigger", false, "Trigger automatically when start-at is reached")
	requirementCreateCmd.Flags().String("priority", "", "Priority")
	requirementCreateCmd.Flags().String("output", "json", "Output format: table or json")

	requirementGetCmd.Flags().String("output", "json", "Output format: table or json")
	requirementListCmd.Flags().String("project", "", "Filter by project id or title")
	requirementListCmd.Flags().Int("limit", 50, "Page size")
	requirementListCmd.Flags().String("output", "json", "Output format: table or json")

	requirementUpdateCmd.Flags().String("title", "", "New title")
	requirementUpdateCmd.Flags().String("description", "", "New description")
	requirementUpdateCmd.Flags().String("goal", "", "New goal")
	requirementUpdateCmd.Flags().String("start-at", "", "New planned start time, RFC3339")
	requirementUpdateCmd.Flags().String("repo-resource", "", "Project resource id of the git repo")
	requirementUpdateCmd.Flags().String("decompose-mode", "", "auto, confirm, or manual")
	requirementUpdateCmd.Flags().Bool("auto-trigger", false, "Trigger automatically when start-at is reached")
	requirementUpdateCmd.Flags().String("priority", "", "New priority")
	requirementUpdateCmd.Flags().String("status", "", "New status key")
	requirementUpdateCmd.Flags().String("output", "json", "Output format: table or json")

	requirementRolesListCmd.Flags().String("output", "json", "Output format: table or json")
	requirementRolesSetCmd.Flags().String("file", "", "JSON file with {\"entries\":[{\"role\",\"assignee_type\",\"assignee_id\",\"enabled\"}]}")
	requirementRolesSetCmd.Flags().String("output", "json", "Output format: table or json")

	requirementDecomposeCmd.Flags().String("output", "json", "Output format: table or json")
	requirementDecompositionCmd.Flags().String("output", "json", "Output format: table or json")
	requirementConfirmCmd.Flags().String("file", "", "JSON file with {\"drafts\":[...]} produced by the PM")
	requirementConfirmCmd.Flags().String("output", "json", "Output format: table or json")
	requirementTriggerCmd.Flags().String("output", "json", "Output format: table or json")

	requirementAcceptanceVerdictCmd.Flags().String("verdict", "", "pass or fail (required)")
	requirementAcceptanceVerdictCmd.Flags().String("evidence", "", "Why the verdict was reached")
	requirementAcceptanceVerdictCmd.Flags().String("output", "json", "Output format: table or json")
	requirementAcceptanceCriteriaCmd.Flags().StringSlice("checked", nil, "Checked criterion ids (repeatable)")
	requirementAcceptanceCriteriaCmd.Flags().String("output", "json", "Output format: table or json")

	requirementPrototypeListCmd.Flags().String("output", "json", "Output format: table or json")
	requirementPrototypeGenerateCmd.Flags().String("prompt", "", "Extra prompt appended to the prototype brief")
	requirementPrototypeGenerateCmd.Flags().String("output", "json", "Output format: table or json")
	requirementPrototypeRegisterCmd.Flags().String("html-path", "", "Path of the HTML prototype (required)")
	requirementPrototypeRegisterCmd.Flags().String("prompt", "", "Note stored with the version")
	requirementPrototypeRegisterCmd.Flags().String("output", "json", "Output format: table or json")
	requirementPrototypeConfirmCmd.Flags().String("output", "json", "Output format: table or json")

	projectRolesListCmd.Flags().String("output", "json", "Output format: table or json")
	projectRolesSetCmd.Flags().String("file", "", "JSON file with {\"entries\":[...]}")
	projectRolesSetCmd.Flags().String("output", "json", "Output format: table or json")
}

func runRequirementCreate(cmd *cobra.Command, _ []string) error {
	title, _ := cmd.Flags().GetString("title")
	if strings.TrimSpace(title) == "" {
		return fmt.Errorf("--title is required")
	}
	// Day-granularity callers (and the requirements skill, which speaks in
	// dates) can name the window instead of a timestamp; derive the promoting
	// start_at so the requirement actually lands on the calendar.
	startAt, _ := cmd.Flags().GetString("start-at")
	if strings.TrimSpace(startAt) == "" {
		derived, ok, err := deriveRequirementDayStartAt(cmd)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("--start-at (RFC3339) or --start-date/--due-date (YYYY-MM-DD) is required; it is what makes this issue a requirement")
		}
		startAt = derived
	}
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()

	body := map[string]any{
		"title":          title,
		"start_at":       startAt,
		"decompose_mode": "confirm",
	}
	if v, _ := cmd.Flags().GetString("description"); v != "" {
		body["description"] = v
	}
	if v, _ := cmd.Flags().GetString("goal"); v != "" {
		body["goal"] = v
	}
	if v, _ := cmd.Flags().GetString("priority"); v != "" {
		body["priority"] = v
	}
	if v, _ := cmd.Flags().GetString("decompose-mode"); v != "" {
		if err := setDecomposeMode(body, v); err != nil {
			return err
		}
	}
	if cmd.Flags().Changed("auto-trigger") {
		auto, _ := cmd.Flags().GetBool("auto-trigger")
		body["auto_trigger"] = auto
	}
	if v, _ := cmd.Flags().GetString("project"); v != "" {
		project, err := resolveProjectID(ctx, client, v)
		if err != nil {
			return fmt.Errorf("resolve project: %w", err)
		}
		body["project_id"] = project.ID
	}
	if v, _ := cmd.Flags().GetString("repo-resource"); v != "" {
		body["repo_resource_id"] = v
	}
	if v, _ := cmd.Flags().GetString("start-date"); v != "" {
		body["start_date"] = v
	}
	if v, _ := cmd.Flags().GetString("due-date"); v != "" {
		body["due_date"] = v
	}
	var result map[string]any
	if err := client.PostJSON(ctx, "/api/issues", body, &result); err != nil {
		return fmt.Errorf("create requirement: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runRequirementGet(cmd *cobra.Command, args []string) error {
	return requirementGetJSON(cmd, args[0], func(id string) string { return "/api/issues/" + id })
}

func runRequirementList(cmd *cobra.Command, _ []string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	if client.WorkspaceID == "" {
		if _, err := requireWorkspaceID(cmd); err != nil {
			return err
		}
	}
	params := "workspace_id=" + client.WorkspaceID + "&kind=requirement"
	if v, _ := cmd.Flags().GetInt("limit"); v > 0 {
		params += fmt.Sprintf("&limit=%d", v)
	}
	if v, _ := cmd.Flags().GetString("project"); v != "" {
		project, err := resolveProjectID(ctx, client, v)
		if err != nil {
			return err
		}
		params += "&project_id=" + project.ID
	}
	var result any
	if err := client.GetJSON(ctx, "/api/issues?"+params, &result); err != nil {
		return fmt.Errorf("list requirements: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runRequirementUpdate(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	issue, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return err
	}
	body := map[string]any{}
	if cmd.Flags().Changed("title") {
		body["title"], _ = cmd.Flags().GetString("title")
	}
	if cmd.Flags().Changed("description") {
		body["description"], _ = cmd.Flags().GetString("description")
	}
	if cmd.Flags().Changed("goal") {
		body["goal"], _ = cmd.Flags().GetString("goal")
	}
	if cmd.Flags().Changed("start-at") {
		startAt, _ := cmd.Flags().GetString("start-at")
		if strings.TrimSpace(startAt) == "" {
			return fmt.Errorf("--start-at must be an RFC3339 timestamp")
		}
		body["start_at"] = startAt
	}
	if cmd.Flags().Changed("repo-resource") {
		body["repo_resource_id"], _ = cmd.Flags().GetString("repo-resource")
	}
	if cmd.Flags().Changed("decompose-mode") {
		mode, _ := cmd.Flags().GetString("decompose-mode")
		if err := setDecomposeMode(body, mode); err != nil {
			return err
		}
	}
	if cmd.Flags().Changed("auto-trigger") {
		auto, _ := cmd.Flags().GetBool("auto-trigger")
		body["auto_trigger"] = auto
	}
	if cmd.Flags().Changed("priority") {
		body["priority"], _ = cmd.Flags().GetString("priority")
	}
	if cmd.Flags().Changed("status") {
		body["status"], _ = cmd.Flags().GetString("status")
	}
	if len(body) == 0 {
		return fmt.Errorf("no changes; pass at least one flag")
	}
	var result map[string]any
	if err := client.PutJSON(ctx, "/api/issues/"+issue.ID, body, &result); err != nil {
		return fmt.Errorf("update requirement: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runRequirementRolesList(cmd *cobra.Command, args []string) error {
	return requirementGetJSON(cmd, args[0], func(id string) string { return "/api/issues/" + id + "/roles" })
}

func runRequirementRolesSet(cmd *cobra.Command, args []string) error {
	return requirementPutFile(cmd, args[0], "/roles")
}

func runRequirementDecompose(cmd *cobra.Command, args []string) error {
	return requirementPostJSON(cmd, args[0], "/decompose", map[string]any{})
}

func runRequirementDecomposition(cmd *cobra.Command, args []string) error {
	return requirementGetJSON(cmd, args[0], func(id string) string { return "/api/issues/" + id + "/decomposition" })
}

func runRequirementConfirm(cmd *cobra.Command, args []string) error {
	return requirementPostFile(cmd, args[0], "/decomposition/confirm")
}

func runRequirementTrigger(cmd *cobra.Command, args []string) error {
	return requirementPostJSON(cmd, args[0], "/trigger", map[string]any{})
}

func runRequirementAcceptanceVerdict(cmd *cobra.Command, args []string) error {
	verdict, _ := cmd.Flags().GetString("verdict")
	switch verdict {
	case "pass", "fail":
	default:
		return fmt.Errorf("--verdict must be pass or fail")
	}
	evidence, _ := cmd.Flags().GetString("evidence")
	return requirementPostJSON(cmd, args[0], "/acceptance/verdict", map[string]any{
		"verdict":  verdict,
		"evidence": evidence,
	})
}

func runRequirementAcceptanceCriteria(cmd *cobra.Command, args []string) error {
	checked, _ := cmd.Flags().GetStringSlice("checked")
	if checked == nil {
		checked = []string{}
	}
	return requirementPostJSON(cmd, args[0], "/acceptance/criteria", map[string]any{
		"checked": checked,
	})
}

func runRequirementPrototypeList(cmd *cobra.Command, args []string) error {
	return requirementGetJSON(cmd, args[0], func(id string) string { return "/api/issues/" + id + "/prototypes" })
}

func runRequirementPrototypeGenerate(cmd *cobra.Command, args []string) error {
	body := map[string]any{}
	if prompt, _ := cmd.Flags().GetString("prompt"); prompt != "" {
		body["prompt_append"] = prompt
	}
	return requirementPostJSON(cmd, args[0], "/prototype/generate", body)
}

func runRequirementPrototypeRegister(cmd *cobra.Command, args []string) error {
	htmlPath, _ := cmd.Flags().GetString("html-path")
	if strings.TrimSpace(htmlPath) == "" {
		return fmt.Errorf("--html-path is required")
	}
	body := map[string]any{"html_path": htmlPath}
	if prompt, _ := cmd.Flags().GetString("prompt"); prompt != "" {
		body["prompt"] = prompt
	}
	return requirementPostJSON(cmd, args[0], "/prototypes", body)
}

func runRequirementPrototypeConfirm(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	issue, err := resolveIssueRef(ctx, client, args[0])
	if err != nil {
		return err
	}
	var result any
	path := "/api/issues/" + issue.ID + "/prototypes/" + args[1] + "/confirm"
	if err := client.PostJSON(ctx, path, map[string]any{}, &result); err != nil {
		return fmt.Errorf("confirm prototype: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runProjectRolesList(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	project, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return err
	}
	var result any
	if err := client.GetJSON(ctx, "/api/projects/"+project.ID+"/role-defaults", &result); err != nil {
		return fmt.Errorf("list project roles: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runProjectRolesSet(cmd *cobra.Command, args []string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	project, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return err
	}
	body, err := readJSONFlag(cmd)
	if err != nil {
		return err
	}
	var result any
	if err := client.PutJSON(ctx, "/api/projects/"+project.ID+"/role-defaults", body, &result); err != nil {
		return fmt.Errorf("set project roles: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func requirementClient(cmd *cobra.Command) (*cli.APIClient, context.Context, context.CancelFunc, error) {
	client, err := newAPIClient(cmd)
	if err != nil {
		return nil, nil, nil, err
	}
	ctx, cancel := cli.APIContext(context.Background())
	return client, ctx, cancel, nil
}

func requirementGetJSON(cmd *cobra.Command, ref string, pathFn func(id string) string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	issue, err := resolveIssueRef(ctx, client, ref)
	if err != nil {
		return err
	}
	var result any
	if err := client.GetJSON(ctx, pathFn(issue.ID), &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func requirementPostJSON(cmd *cobra.Command, ref, suffix string, body any) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	issue, err := resolveIssueRef(ctx, client, ref)
	if err != nil {
		return err
	}
	var result any
	if err := client.PostJSON(ctx, "/api/issues/"+issue.ID+suffix, body, &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func requirementPostFile(cmd *cobra.Command, ref, suffix string) error {
	body, err := readJSONFlag(cmd)
	if err != nil {
		return err
	}
	return requirementPostJSON(cmd, ref, suffix, body)
}

func requirementPutFile(cmd *cobra.Command, ref, suffix string) error {
	client, ctx, cancel, err := requirementClient(cmd)
	if err != nil {
		return err
	}
	defer cancel()
	issue, err := resolveIssueRef(ctx, client, ref)
	if err != nil {
		return err
	}
	body, err := readJSONFlag(cmd)
	if err != nil {
		return err
	}
	var result any
	if err := client.PutJSON(ctx, "/api/issues/"+issue.ID+suffix, body, &result); err != nil {
		return err
	}
	return cli.PrintJSON(os.Stdout, result)
}

func readJSONFlag(cmd *cobra.Command) (any, error) {
	path, _ := cmd.Flags().GetString("file")
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("--file is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read --file: %w", err)
	}
	var body any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("--file must be JSON: %w", err)
	}
	return body, nil
}

func setDecomposeMode(body map[string]any, mode string) error {
	switch mode {
	case "auto", "confirm", "manual":
		body["decompose_mode"] = mode
		return nil
	default:
		return fmt.Errorf("invalid --decompose-mode %q; valid values: auto, confirm, manual", mode)
	}
}
