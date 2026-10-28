package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 工作流在 UI 里是「模板 → 实例 → 阶段运行 → 门禁」四层。CLI 过去只能通过
// `project tab get <p> workflows` 看到实例列表，模板的读写与阶段的门禁动作
// 全在 UI。这些命令把四层都开出来；写模板时节点图结构复杂，所以允许直接喂
// JSON 文件，而不是让 agent 拼 20 个 flag。
//
// 整块端点受 FF_WORKFLOW_MODULE 门控：flag 关闭时服务端返回 404，命令会把
// 这句提示透出来，避免 agent 反复重试。
var workflowCmd = &cobra.Command{
	Use:   "workflow",
	Short: "Read and drive workflow templates, instances, stages and gates",
	Long: `Four layers, four command groups:

  workflow template list [--project <p>]        workspace + project templates
  workflow template create <project> --name <n> [--nodes-file graph.json] [--definition-file d.json]
  workflow template definition <tid> --definition-file d.json [--name <n>]
  workflow template enforce <tid> [--off]      set/clear the project's gate template
  workflow template publish|archive|duplicate|share <project> <tid>
  workflow instance list <project>
  workflow instance get <iid>                  {instance, stages[], gates[]}
  workflow instance diagnosis <iid>            why it is stuck + suggested action
  workflow instance create <project> --template <tid> [--issue <id>]
  workflow instance pause|resume|cancel|succeed|recover <iid>
  workflow stage approve|loop-back|skip|rerun|interrupt|recheck <sid>
  workflow stage transcript|messages <sid>      what the stage's agent did / said
  workflow gate decide <gid> --decision loop|exit

Stage and gate ids come from ` + "`workflow instance get`" + `: stages[].id and gates[].id.
These endpoints require FF_WORKFLOW_MODULE; a 404 means the flag is off.`,
}

var workflowTemplateCmd = &cobra.Command{
	Use:   "template",
	Short: "Workflow templates (the reusable graph)",
}

var workflowInstanceCmd = &cobra.Command{
	Use:   "instance",
	Short: "Workflow instances (one run of a template)",
}

var workflowStageCmd = &cobra.Command{
	Use:   "stage",
	Short: "Act on one stage run",
}

var workflowGateCmd = &cobra.Command{
	Use:   "gate",
	Short: "Decide a gate run",
}

func init() {
	workflowCmd.AddCommand(workflowTemplateCmd, workflowInstanceCmd, workflowStageCmd, workflowGateCmd)

	workflowTemplateListCmd.Flags().String("project", "", "Project id or name (omit for the workspace gallery)")
	workflowTemplateListCmd.Flags().String("output", "table", "Output format: table or json")
	workflowTemplateCmd.AddCommand(workflowTemplateListCmd)

	workflowTemplateCreateCmd.Flags().String("name", "", "Template name (required, max 120 chars)")
	workflowTemplateCreateCmd.Flags().String("description", "", "Description")
	workflowTemplateCreateCmd.Flags().String("nodes-file", "", "JSON array of nodes, or an object with a nodes key")
	workflowTemplateCreateCmd.Flags().String("definition-file", "", "CoCo nested definition JSON")
	workflowTemplateCreateCmd.Flags().Bool("enforce", false, "Mark as the project's enforced gate template")
	workflowTemplateCreateCmd.Flags().String("output", "json", "Output format: table or json")
	workflowTemplateCmd.AddCommand(workflowTemplateCreateCmd)

	workflowTemplateUpdateCmd.Flags().String("name", "", "Template name (required)")
	workflowTemplateUpdateCmd.Flags().String("description", "", "Description")
	workflowTemplateUpdateCmd.Flags().String("nodes-file", "", "JSON array of nodes")
	workflowTemplateUpdateCmd.Flags().String("output", "json", "Output format: table or json")
	workflowTemplateCmd.AddCommand(workflowTemplateUpdateCmd)

	workflowTemplateDefinitionCmd.Flags().String("definition-file", "", "CoCo nested definition JSON (required)")
	workflowTemplateDefinitionCmd.Flags().String("name", "", "Keep or change the name")
	workflowTemplateDefinitionCmd.Flags().String("description", "", "Keep or change the description")
	workflowTemplateDefinitionCmd.Flags().String("output", "json", "Output format: table or json")
	workflowTemplateCmd.AddCommand(workflowTemplateDefinitionCmd)

	workflowTemplateEnforceCmd.Flags().Bool("off", false, "Clear the enforce flag instead of setting it")
	workflowTemplateEnforceCmd.Flags().String("output", "json", "Output format: table or json")
	workflowTemplateCmd.AddCommand(workflowTemplateEnforceCmd)

	for _, child := range []*cobra.Command{
		workflowTemplatePublishCmd,
		workflowTemplateArchiveCmd,
		workflowTemplateDuplicateCmd,
		workflowTemplateShareCmd,
		workflowTemplateDryRunCmd,
	} {
		child.Flags().String("output", "json", "Output format: table or json")
		workflowTemplateCmd.AddCommand(child)
	}

	workflowInstanceListCmd.Flags().String("output", "table", "Output format: table or json")
	workflowInstanceCmd.AddCommand(workflowInstanceListCmd)

	workflowInstanceGetCmd.Flags().String("output", "json", "Output format: table or json")
	workflowInstanceCmd.AddCommand(workflowInstanceGetCmd)

	workflowInstanceCreateCmd.Flags().String("template", "", "Template id (required)")
	workflowInstanceCreateCmd.Flags().String("issue", "", "Issue id to run the instance for")
	workflowInstanceCreateCmd.Flags().String("snapshot-file", "", "Workitem snapshot JSON")
	workflowInstanceCreateCmd.Flags().String("output", "json", "Output format: table or json")
	workflowInstanceCmd.AddCommand(workflowInstanceCreateCmd)

	workflowInstanceDiagnosisCmd.Flags().String("output", "json", "Output format: table or json")
	workflowInstanceCmd.AddCommand(workflowInstanceDiagnosisCmd)

	for _, child := range []*cobra.Command{
		workflowInstancePauseCmd,
		workflowInstanceResumeCmd,
		workflowInstanceSucceedCmd,
		workflowInstanceRecoverCmd,
	} {
		child.Flags().String("output", "json", "Output format: table or json")
		workflowInstanceCmd.AddCommand(child)
	}
	workflowInstanceCancelCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(workflowInstanceCancelCmd)
	workflowInstanceCmd.AddCommand(workflowInstanceCancelCmd)

	for _, child := range []*cobra.Command{
		workflowStageApproveCmd,
		workflowStageLoopBackCmd,
		workflowStageSkipCmd,
		workflowStageRerunCmd,
		workflowStageInterruptCmd,
		workflowStageRecheckCmd,
		workflowStageTranscriptCmd,
		workflowStageMessagesCmd,
	} {
		child.Flags().String("output", "json", "Output format: table or json")
		workflowStageCmd.AddCommand(child)
	}

	workflowGateDecideCmd.Flags().String("decision", "", "loop | exit (required)")
	workflowGateDecideCmd.Flags().String("output", "json", "Output format: table or json")
	workflowGateCmd.AddCommand(workflowGateDecideCmd)
}

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

var workflowTemplateListCmd = &cobra.Command{
	Use:   "list",
	Short: "List workspace and project templates",
	Args:  exactArgs(0),
	RunE:  runWorkflowTemplateList,
}

func runWorkflowTemplateList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	params := map[string]string{}
	var path string
	if ref := flagOr(cmd, "project", ""); ref != "" {
		projectRef, err := resolveProjectID(ctx, client, ref)
		if err != nil {
			return fmt.Errorf("resolve project: %w", err)
		}
		path = "/api/projects/" + projectRef.ID + "/workflow/templates"
	} else {
		path = "/api/workflow/templates"
		if client.WorkspaceID != "" {
			params["workspace_id"] = client.WorkspaceID
		}
	}
	if encoded := encodeQuery(params); encoded != "" {
		path += "?" + encoded
	}

	var raw map[string]any
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return wrapWorkflowError("list workflow templates", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	templates := anySlice(raw["templates"])
	headers := []string{"ID", "NAME", "STATUS", "VERSION", "ENFORCE", "NODES"}
	rows := make([][]string, 0, len(templates))
	for _, item := range templates {
		tpl, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rows = append(rows, []string{
			shortID(strVal(tpl, "id")),
			truncateCell(strVal(tpl, "name"), 40),
			blankDash(strVal(tpl, "status")),
			blankDash(strVal(tpl, "version")),
			blankDash(strVal(tpl, "enforce")),
			blankDash(strVal(tpl, "node_count")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d template(s).\n", len(templates))
	return nil
}

var workflowTemplateCreateCmd = &cobra.Command{
	Use:   "create <project>",
	Short: "Create a template from a nodes or definition file",
	Args:  exactArgs(1),
	RunE:  runWorkflowTemplateCreate,
}

func runWorkflowTemplateCreate(cmd *cobra.Command, args []string) error {
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
	if v := flagOr(cmd, "description", ""); v != "" {
		body["description"] = v
	}
	if enforce, _ := cmd.Flags().GetBool("enforce"); enforce {
		body["enforce"] = true
	}
	if nodesFile := flagOr(cmd, "nodes-file", ""); nodesFile != "" {
		nodes, err := readJSONDocument(nodesFile)
		if err != nil {
			return fmt.Errorf("read --nodes-file: %w", err)
		}
		body["nodes"] = nodes
	}
	if defFile := flagOr(cmd, "definition-file", ""); defFile != "" {
		definition, err := readJSONDocument(defFile)
		if err != nil {
			return fmt.Errorf("read --definition-file: %w", err)
		}
		body["definition"] = definition
	}
	if _, ok := body["nodes"]; !ok {
		if _, ok := body["definition"]; !ok {
			return fmt.Errorf("one of --nodes-file or --definition-file is required (a template without a graph is unusable)")
		}
	}

	var created map[string]any
	path := "/api/projects/" + projectRef.ID + "/workflow/templates"
	if err := client.PostJSON(ctx, path, body, &created); err != nil {
		return wrapWorkflowError("create workflow template", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), created)
}

var workflowTemplateUpdateCmd = &cobra.Command{
	Use:   "update <project> <tid>",
	Short: "Replace a template's name/description/nodes (PUT is full replace)",
	Args:  exactArgs(2),
	RunE:  runWorkflowTemplateUpdate,
}

func runWorkflowTemplateUpdate(cmd *cobra.Command, args []string) error {
	name := flagOr(cmd, "name", "")
	if name == "" {
		return fmt.Errorf("--name is required (the endpoint replaces the whole template)")
	}
	nodesFile := flagOr(cmd, "nodes-file", "")
	if nodesFile == "" {
		return fmt.Errorf("--nodes-file is required: PUT replaces nodes, so omitting them would empty the graph")
	}
	nodes, err := readJSONDocument(nodesFile)
	if err != nil {
		return fmt.Errorf("read --nodes-file: %w", err)
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
	body := map[string]any{"name": name, "nodes": nodes}
	if v := flagOr(cmd, "description", ""); v != "" {
		body["description"] = v
	}
	var updated map[string]any
	path := "/api/projects/" + projectRef.ID + "/workflow/templates/" + args[1]
	if err := client.PutJSON(ctx, path, body, &updated); err != nil {
		return wrapWorkflowError("update workflow template", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

var workflowTemplateDefinitionCmd = &cobra.Command{
	Use:   "definition <tid>",
	Short: "Save the CoCo nested definition (flattened to nodes server-side)",
	Args:  exactArgs(1),
	RunE:  runWorkflowTemplateDefinition,
}

func runWorkflowTemplateDefinition(cmd *cobra.Command, args []string) error {
	defFile := flagOr(cmd, "definition-file", "")
	if defFile == "" {
		return fmt.Errorf("--definition-file is required")
	}
	definition, err := readJSONDocument(defFile)
	if err != nil {
		return fmt.Errorf("read --definition-file: %w", err)
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	body := map[string]any{"definition": definition}
	if v := flagOr(cmd, "name", ""); v != "" {
		body["name"] = v
	}
	if v := flagOr(cmd, "description", ""); v != "" {
		body["description"] = v
	}
	var updated map[string]any
	path := "/api/workflow/templates/" + args[0] + "/definition"
	if err := client.PutJSON(ctx, path, body, &updated); err != nil {
		return wrapWorkflowError("save workflow definition", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

var (
	workflowTemplatePublishCmd = &cobra.Command{
		Use:   "publish <project> <tid>",
		Short: "Publish a draft template",
		Args:  exactArgs(2),
		RunE:  workflowTemplateAction("publish"),
	}
	workflowTemplateArchiveCmd = &cobra.Command{
		Use:   "archive <project> <tid>",
		Short: "Archive a template",
		Args:  exactArgs(2),
		RunE:  workflowTemplateAction("archive"),
	}
	workflowTemplateDuplicateCmd = &cobra.Command{
		Use:   "duplicate <project> <tid>",
		Short: "Copy a template into a new draft",
		Args:  exactArgs(2),
		RunE:  workflowTemplateAction("duplicate"),
	}
	workflowTemplateShareCmd = &cobra.Command{
		Use:   "share <project> <tid>",
		Short: "Share a template with the workspace",
		Args:  exactArgs(2),
		RunE:  workflowTemplateAction("share"),
	}
	workflowTemplateDryRunCmd = &cobra.Command{
		Use:   "dry-run <tid>",
		Short: "Render a template without side effects",
		Args:  exactArgs(1),
		RunE:  runWorkflowTemplateDryRun,
	}
)

var workflowTemplateEnforceCmd = &cobra.Command{
	Use:   "enforce <tid>",
	Short: "Make this published project template the project's mandatory gate (--off clears)",
	Long: `Only a published, project-scoped template can be enforced, and only one per
project (a second one is rejected with 409). Enforcing changes whether new
work must pass this template's gates, so state the effect before applying it.`,
	Args: exactArgs(1),
	RunE: runWorkflowTemplateEnforce,
}

func runWorkflowTemplateEnforce(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	off, _ := cmd.Flags().GetBool("off")
	path := "/api/workflow/templates/" + args[0] + "/enforce"
	if client.WorkspaceID != "" {
		path += "?workspace_id=" + url.QueryEscape(client.WorkspaceID)
	}
	var updated map[string]any
	if err := client.PutJSON(ctx, path, map[string]any{"enforce": !off}, &updated); err != nil {
		return wrapWorkflowError("set workflow template enforce", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

func workflowTemplateAction(action string) func(*cobra.Command, []string) error {
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
		var result map[string]any
		path := "/api/projects/" + projectRef.ID + "/workflow/templates/" + args[1] + "/" + action
		if err := client.PostJSON(ctx, path, nil, &result); err != nil {
			return wrapWorkflowError(action+" workflow template", err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
}

func runWorkflowTemplateDryRun(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	path := "/api/workflow/templates/" + args[0] + "/dry-run"
	if client.WorkspaceID != "" {
		path += "?workspace_id=" + client.WorkspaceID
	}
	var result map[string]any
	if err := client.PostJSON(ctx, path, nil, &result); err != nil {
		return wrapWorkflowError("dry-run workflow template", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), result)
}

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

var workflowInstanceListCmd = &cobra.Command{
	Use:   "list <project>",
	Short: "List a project's workflow instances",
	Args:  exactArgs(1),
	RunE:  runWorkflowInstanceList,
}

func runWorkflowInstanceList(cmd *cobra.Command, args []string) error {
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
	var raw map[string]any
	path := "/api/projects/" + projectRef.ID + "/workflow-instances"
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return wrapWorkflowError("list workflow instances", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	instances := anySlice(raw["instances"])
	headers := []string{"ID", "TEMPLATE", "STATUS", "ISSUE", "STARTED", "STAGE_RUNS"}
	rows := make([][]string, 0, len(instances))
	for _, item := range instances {
		inst, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rows = append(rows, []string{
			shortID(strVal(inst, "id")),
			truncateCell(strVal(inst, "template_name"), 28),
			blankDash(strVal(inst, "status")),
			shortID(strVal(inst, "issue_id")),
			blankDash(strVal(inst, "started_at")),
			blankDash(strVal(inst, "stage_run_count")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d instance(s).\n", len(instances))
	return nil
}

var workflowInstanceGetCmd = &cobra.Command{
	Use:   "get <iid>",
	Short: "Instance detail: stage runs, gate runs and recovery hints",
	Args:  exactArgs(1),
	RunE:  runWorkflowInstanceGet,
}

func runWorkflowInstanceGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var detail map[string]any
	if err := client.GetJSON(ctx, "/api/workflow-instances/"+args[0], &detail); err != nil {
		return wrapWorkflowError("get workflow instance", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), detail)
}

var workflowInstanceDiagnosisCmd = &cobra.Command{
	Use:   "diagnosis <iid>",
	Short: "Why the instance is stuck, with a suggested next action per stage",
	Args:  exactArgs(1),
	RunE:  runWorkflowInstanceDiagnosis,
}

func runWorkflowInstanceDiagnosis(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var diagnosis map[string]any
	if err := client.GetJSON(ctx, "/api/workflow-instances/"+args[0]+"/recovery-diagnosis", &diagnosis); err != nil {
		return wrapWorkflowError("diagnose workflow instance", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), diagnosis)
}

var workflowInstanceCreateCmd = &cobra.Command{
	Use:   "create <project>",
	Short: "Start an instance from a published template",
	Args:  exactArgs(1),
	RunE:  runWorkflowInstanceCreate,
}

func runWorkflowInstanceCreate(cmd *cobra.Command, args []string) error {
	templateID := flagOr(cmd, "template", "")
	if templateID == "" {
		return fmt.Errorf("--template <tid> is required (find one with `multica workflow template list --project <p>`)")
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
	body := map[string]any{"template_id": templateID}
	if issueID := flagOr(cmd, "issue", ""); issueID != "" {
		body["issue_id"] = issueID
	}
	if snapshotFile := flagOr(cmd, "snapshot-file", ""); snapshotFile != "" {
		snapshot, err := readJSONDocument(snapshotFile)
		if err != nil {
			return fmt.Errorf("read --snapshot-file: %w", err)
		}
		body["workitem_snapshot"] = snapshot
	}
	var created map[string]any
	path := "/api/projects/" + projectRef.ID + "/workflow-instances"
	if err := client.PostJSON(ctx, path, body, &created); err != nil {
		return wrapWorkflowError("create workflow instance", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), created)
}

var (
	workflowInstancePauseCmd = &cobra.Command{
		Use: "pause <iid>", Short: "Pause an instance", Args: exactArgs(1),
		RunE: workflowInstanceAction("pause"),
	}
	workflowInstanceResumeCmd = &cobra.Command{
		Use: "resume <iid>", Short: "Resume a paused instance", Args: exactArgs(1),
		RunE: workflowInstanceAction("resume"),
	}
	workflowInstanceSucceedCmd = &cobra.Command{
		Use: "succeed <iid>", Short: "Mark an instance as succeeded", Args: exactArgs(1),
		RunE: workflowInstanceAction("succeed"),
	}
	workflowInstanceRecoverCmd = &cobra.Command{
		Use: "recover <iid>", Short: "Recover a stuck instance", Args: exactArgs(1),
		RunE: workflowInstanceAction("recover"),
	}
	workflowInstanceCancelCmd = &cobra.Command{
		Use:   "cancel <iid>",
		Short: "Cancel an instance (needs --yes: it stops every stage run)",
		Args:  exactArgs(1),
		RunE:  workflowInstanceCancel,
	}
)

func workflowInstanceAction(action string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()
		var result map[string]any
		path := "/api/workflow-instances/" + args[0] + "/" + action
		if err := client.PostJSON(ctx, path, nil, &result); err != nil {
			return wrapWorkflowError(action+" workflow instance", err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
}

func workflowInstanceCancel(cmd *cobra.Command, args []string) error {
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Cancel workflow instance %s. Every running stage stops and the instance cannot be resumed (recover is a different path).",
		args[0])); err != nil {
		return err
	}
	return workflowInstanceAction("cancel")(cmd, args)
}

// ---------------------------------------------------------------------------
// stages and gates
// ---------------------------------------------------------------------------

var (
	workflowStageApproveCmd = &cobra.Command{
		Use: "approve <sid>", Short: "Approve a stage gate (exit)", Args: exactArgs(1),
		RunE: workflowStageAction("approve"),
	}
	workflowStageLoopBackCmd = &cobra.Command{
		Use: "loop-back <sid>", Short: "Send a stage gate back (loop)", Args: exactArgs(1),
		RunE: workflowStageAction("loop-back"),
	}
	workflowStageSkipCmd = &cobra.Command{
		Use: "skip <sid>", Short: "Skip a stage run", Args: exactArgs(1),
		RunE: workflowStageAction("skip"),
	}
	workflowStageRerunCmd = &cobra.Command{
		Use: "rerun <sid>", Short: "Rerun a stage", Args: exactArgs(1),
		RunE: workflowStageAction("rerun"),
	}
	workflowStageInterruptCmd = &cobra.Command{
		Use: "interrupt <sid>", Short: "Interrupt a running stage", Args: exactArgs(1),
		RunE: workflowStageAction("interrupt"),
	}
	workflowStageRecheckCmd = &cobra.Command{
		Use: "recheck <sid>", Short: "Re-check stage admission", Args: exactArgs(1),
		RunE: workflowStageAction("recheck"),
	}
	workflowStageTranscriptCmd = &cobra.Command{
		Use: "transcript <sid>", Short: "The stage's agent transcript (tool calls and outputs)", Args: exactArgs(1),
		RunE: workflowStageRead("/transcript"),
	}
	workflowStageMessagesCmd = &cobra.Command{
		Use: "messages <sid>", Short: "The human/agent message thread of the stage", Args: exactArgs(1),
		RunE: workflowStageRead("/messages"),
	}
)

// workflowStageAction POSTs one transition. Stage and gate ids come from
// `workflow instance get` (stages[].id / gates[].id) — not from the template.
func workflowStageAction(action string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()
		var result map[string]any
		path := "/api/workflow/stage-runs/" + args[0] + "/" + action
		if err := client.PostJSON(ctx, path, nil, &result); err != nil {
			return wrapWorkflowError(action+" workflow stage", err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
}

func workflowStageRead(suffix string) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, args []string) error {
		client, err := newAPIClient(cmd)
		if err != nil {
			return err
		}
		ctx, cancel := cli.APIContext(context.Background())
		defer cancel()
		var result map[string]any
		path := "/api/workflow/stage-runs/" + args[0] + suffix
		if err := client.GetJSON(ctx, path, &result); err != nil {
			return wrapWorkflowError("read workflow stage "+strings.TrimPrefix(suffix, "/"), err)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
}

var workflowGateDecideCmd = &cobra.Command{
	Use:   "decide <gid>",
	Short: "Decide a gate run: loop or exit",
	Args:  exactArgs(1),
	RunE:  runWorkflowGateDecide,
}

func runWorkflowGateDecide(cmd *cobra.Command, args []string) error {
	decision := flagOr(cmd, "decision", "")
	if decision != "loop" && decision != "exit" {
		return fmt.Errorf("--decision must be loop or exit")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	path := "/api/workflow/gate-runs/" + args[0] + "/decide"
	if err := client.PostJSON(ctx, path, map[string]any{"decision": decision}, &result); err != nil {
		return wrapWorkflowError("decide workflow gate", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), result)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// readJSONDocument loads a JSON document from a file, or from stdin when the
// path is "-". Templates are graphs; making the agent inline them as flags
// invites quoting bugs.
func readJSONDocument(path string) (any, error) {
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		// path comes from the operator who ran the command (a graph file they
		// wrote), not from a request or a database row.
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return doc, nil
}

// wrapWorkflowError turns the flag-off 404 into the answer, instead of letting
// the agent retry the same call four times.
func wrapWorkflowError(action string, err error) error {
	msg := err.Error()
	if strings.Contains(msg, "404") || strings.Contains(msg, "not found") {
		return fmt.Errorf("%s: %w (workflow endpoints are behind FF_WORKFLOW_MODULE; a 404 usually means the flag is off for this workspace)", action, err)
	}
	return fmt.Errorf("%s: %w", action, err)
}

func encodeQuery(params map[string]string) string {
	values := url.Values{}
	for key, value := range params {
		if value != "" {
			values.Set(key, value)
		}
	}
	return values.Encode()
}
