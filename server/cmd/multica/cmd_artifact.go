package main

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 档案（archive）与产出物（deliverables）是同一张 project_artifact 表的两面：
// 带 issue_id 的行就是某个需求/任务的交付物。UI 的档案 TAB 能建、能改分类、能
// 绑需求、能删，但 CLI 过去只有 `project tab get` 的只读通路，agent 因此永远
// 只能"看"产出物。这里补齐写面，并把「正文」讲清楚：服务端一般不存渲染副本，
// 真正的文件在 rel_path 指向的档案仓库目录里。
var artifactCmd = &cobra.Command{
	Use:   "artifact",
	Short: "Read and manage project archive rows (deliverables are rows with an issue)",
	Long: `One artifact row = one document in the project archive. Rows carrying
issue_id are that issue's deliverables.

  multica artifact list <project> [--scope project] [--stage 2] [--doc-type t] [--q text]
  multica artifact get <project> <artifact-id> [--content]
  multica artifact create <project> --scope requirement --doc-type design --rel-path docs/x.md
  multica artifact update <project> <artifact-id> [--stage|--doc-type|--rel-path|--issue|--doc-class|--doc-module|--content]
  multica artifact bind <project> <artifact-id> --issue <issue-id>
  multica artifact unbind <project> <artifact-id> --yes
  multica artifact delete <project> <artifact-id> --yes
  multica artifact matrix <project>
  multica artifact unbound <project>

scope is shared | project | requirement; stage is 1..5. Rows with an issue_id are
that issue's deliverables. delete refuses (409 asset_linked) when the row is
linked to an asset binding — remove it from the asset side instead.`,
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

var artifactListCmd = &cobra.Command{
	Use:   "list <project>",
	Short: "List archive rows (filters mirror the archive tab)",
	Args:  exactArgs(1),
	RunE:  runArtifactList,
}

var artifactGetCmd = &cobra.Command{
	Use:   "get <project> <artifact-id>",
	Short: "Show one archive row, or its content pointer with --content",
	Args:  exactArgs(2),
	RunE:  runArtifactGet,
}

func init() {
	artifactListCmd.Flags().String("scope", "", "shared | project | requirement")
	artifactListCmd.Flags().String("stage", "", "Stage number 1..5")
	artifactListCmd.Flags().String("doc-class", "", "doc_class filter")
	artifactListCmd.Flags().String("doc-type", "", "doc_type filter")
	artifactListCmd.Flags().String("q", "", "Substring filter on path")
	artifactListCmd.Flags().Int("limit", 50, "Maximum rows to print (the endpoint has no server paging)")
	artifactListCmd.Flags().String("output", "table", "Output format: table or json")
	artifactCmd.AddCommand(artifactListCmd)

	artifactGetCmd.Flags().Bool("content", false, "Read /content (pointer + attachment_url) instead of the row")
	artifactGetCmd.Flags().String("output", "json", "Output format: table or json")
	artifactCmd.AddCommand(artifactGetCmd)

	artifactCreateCmd.Flags().String("scope", "", "shared | project | requirement (required)")
	artifactCreateCmd.Flags().String("doc-type", "", "doc_type, e.g. design (required)")
	artifactCreateCmd.Flags().String("rel-path", "", "Path inside the archive repo (required)")
	artifactCreateCmd.Flags().Int("stage", 0, "Stage 1..5 (omitted: unclassified)")
	artifactCreateCmd.Flags().String("issue", "", "Bind to this issue id")
	artifactCreateCmd.Flags().String("requirement-key", "", "requirement_key")
	artifactCreateCmd.Flags().String("doc-class", "", "doc_class")
	artifactCreateCmd.Flags().String("doc-module", "", "doc_module")
	artifactCreateCmd.Flags().String("content", "", "Inline markdown body")
	artifactCreateCmd.Flags().String("attachment", "", "attachment_id to reference")
	artifactCreateCmd.Flags().Int("version", 0, "Document version")
	artifactCreateCmd.Flags().String("output", "json", "Output format: table or json")
	artifactCmd.AddCommand(artifactCreateCmd)

	artifactUpdateCmd.Flags().String("scope", "", "shared | project | requirement")
	artifactUpdateCmd.Flags().Int("stage", 0, "Stage 1..5")
	artifactUpdateCmd.Flags().String("issue", "", "Bind to this issue id; empty string unbinds")
	artifactUpdateCmd.Flags().String("doc-type", "", "doc_type")
	artifactUpdateCmd.Flags().String("rel-path", "", "Path inside the archive repo")
	artifactUpdateCmd.Flags().String("requirement-key", "", "requirement_key")
	artifactUpdateCmd.Flags().String("doc-class", "", "doc_class")
	artifactUpdateCmd.Flags().String("doc-module", "", "doc_module")
	artifactUpdateCmd.Flags().String("content", "", "Inline markdown body")
	artifactUpdateCmd.Flags().String("output", "json", "Output format: table or json")
	artifactCmd.AddCommand(artifactUpdateCmd)

	artifactBindCmd.Flags().String("issue", "", "Issue id to bind (required)")
	artifactBindCmd.Flags().String("output", "json", "Output format: table or json")
	artifactCmd.AddCommand(artifactBindCmd)

	artifactUnbindCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(artifactUnbindCmd)
	artifactCmd.AddCommand(artifactUnbindCmd)

	artifactDeleteCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(artifactDeleteCmd)
	artifactCmd.AddCommand(artifactDeleteCmd)

	artifactMatrixCmd.Flags().String("output", "json", "Output format: table or json")
	artifactCmd.AddCommand(artifactMatrixCmd)

	artifactUnboundCmd.Flags().Int("limit", 50, "Maximum rows to print")
	artifactUnboundCmd.Flags().String("output", "table", "Output format: table or json")
	artifactCmd.AddCommand(artifactUnboundCmd)
}

func runArtifactList(cmd *cobra.Command, args []string) error {
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
	params := url.Values{}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	for _, filter := range []struct{ flag, key string }{
		{"scope", "scope"},
		{"stage", "stage"},
		{"doc-class", "doc_class"},
		{"doc-type", "doc_type"},
		{"q", "q"},
	} {
		if v, _ := cmd.Flags().GetString(filter.flag); strings.TrimSpace(v) != "" {
			params.Set(filter.key, strings.TrimSpace(v))
		}
	}
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/artifacts"
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var resp struct {
		Artifacts []map[string]any `json:"artifacts"`
		Total     int              `json:"total"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("list artifacts: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(resp.Artifacts, limit)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"source":    path,
			"artifacts": rows,
			"total":     resp.Total,
			"next":      "multica artifact get <p> <artifact-id> --content  (content pointer); multica artifact unbound <p>  (rows with no issue)",
		})
	}
	headers := []string{"ID", "SCOPE", "STAGE", "DOC_TYPE", "ISSUE", "PATH"}
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, []string{
			shortID(strVal(row, "id")),
			blankDash(strVal(row, "scope")),
			blankDash(strVal(row, "stage")),
			truncateCell(strVal(row, "doc_type"), 20),
			shortID(strVal(row, "issue_id")),
			truncateCell(strVal(row, "rel_path"), 56),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d artifact(s) (server total %d).\n", len(rows), resp.Total)
	return nil
}

func runArtifactGet(cmd *cobra.Command, args []string) error {
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
	base := "/api/projects/" + url.PathEscape(projectRef.ID) + "/artifacts/" + url.PathEscape(args[1])
	if withContent, _ := cmd.Flags().GetBool("content"); withContent {
		var content map[string]any
		if err := client.GetJSON(ctx, base+"/content", &content); err != nil {
			return fmt.Errorf("get artifact content: %w", err)
		}
		if output, _ := cmd.Flags().GetString("output"); output == "json" {
			return cli.PrintJSON(cmd.OutOrStdout(), content)
		}
		relPath := strVal(content, "rel_path")
		if relPath == "" {
			relPath = strVal(content, "path")
		}
		fmt.Fprintf(cmd.OutOrStdout(), "content_unavailable=%s\nrel_path=%s\nattachment_url=%s\n",
			strVal(content, "content_unavailable"), relPath, strVal(content, "attachment_url"))
		if strVal(content, "content_unavailable") == "true" || strVal(content, "content_unavailable") == "1" {
			fmt.Fprintln(cmd.OutOrStdout(), "The server holds no rendered copy — read the file at rel_path in the archive repo.")
		}
		return nil
	}

	var artifact map[string]any
	if err := client.GetJSON(ctx, base, &artifact); err != nil {
		return fmt.Errorf("get artifact: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), artifact)
}

// ---------------------------------------------------------------------------
// create / update
// ---------------------------------------------------------------------------

var artifactCreateCmd = &cobra.Command{
	Use:   "create <project>",
	Short: "Create an archive row (source=manual, survives sync)",
	Args:  exactArgs(1),
	RunE:  runArtifactCreate,
}

func runArtifactCreate(cmd *cobra.Command, args []string) error {
	scope := flagOr(cmd, "scope", "")
	docType := flagOr(cmd, "doc-type", "")
	relPath := flagOr(cmd, "rel-path", "")
	if scope == "" || docType == "" || relPath == "" {
		return fmt.Errorf("--scope, --doc-type and --rel-path are required (scope: shared|project|requirement)")
	}
	switch scope {
	case "shared", "project", "requirement":
	default:
		return fmt.Errorf("--scope must be shared, project or requirement (got %q)", scope)
	}
	if cmd.Flags().Changed("stage") {
		stage, _ := cmd.Flags().GetInt("stage")
		if stage < 1 || stage > 5 {
			return fmt.Errorf("--stage must be within 1..5 (its absence means unclassified)")
		}
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

	body := map[string]any{
		"scope":    scope,
		"doc_type": docType,
		"rel_path": relPath,
	}
	if cmd.Flags().Changed("stage") {
		stage, _ := cmd.Flags().GetInt("stage")
		body["stage"] = stage
	}
	for _, pair := range []struct{ flag, key string }{
		{"issue", "issue_id"},
		{"requirement-key", "requirement_key"},
		{"doc-class", "doc_class"},
		{"doc-module", "doc_module"},
		{"content", "content"},
		{"attachment", "attachment_id"},
	} {
		if v := flagOr(cmd, pair.flag, ""); v != "" {
			body[pair.key] = v
		}
	}
	if cmd.Flags().Changed("version") {
		version, _ := cmd.Flags().GetInt("version")
		body["version"] = version
	}

	var created map[string]any
	if err := client.PostJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/artifacts", body, &created); err != nil {
		return fmt.Errorf("create artifact: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), created)
}

var artifactUpdateCmd = &cobra.Command{
	Use:   "update <project> <artifact-id>",
	Short: "Reclassify or rebind one archive row",
	Args:  exactArgs(2),
	RunE:  runArtifactUpdate,
}

func runArtifactUpdate(cmd *cobra.Command, args []string) error {
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

	body := map[string]any{}
	if cmd.Flags().Changed("scope") {
		scope := flagOr(cmd, "scope", "")
		switch scope {
		case "shared", "project", "requirement":
		default:
			return fmt.Errorf("--scope must be shared, project or requirement (got %q)", scope)
		}
	}
	if cmd.Flags().Changed("stage") {
		stage, _ := cmd.Flags().GetInt("stage")
		if stage < 1 || stage > 5 {
			return fmt.Errorf("--stage must be within 1..5")
		}
		body["stage"] = stage
	}
	for _, pair := range []struct{ flag, key string }{
		{"scope", "scope"},
		{"issue", "issue_id"},
		{"doc-type", "doc_type"},
		{"rel-path", "rel_path"},
		{"requirement-key", "requirement_key"},
		{"doc-class", "doc_class"},
		{"doc-module", "doc_module"},
		{"content", "content"},
	} {
		if cmd.Flags().Changed(pair.flag) {
			body[pair.key] = flagOr(cmd, pair.flag, "")
		}
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass at least one of --scope, --stage, --issue, --doc-type, --rel-path, --doc-class, --doc-module, --content")
	}

	var updated map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/artifacts/" + url.PathEscape(args[1])
	if err := client.PatchJSON(ctx, path, body, &updated); err != nil {
		return fmt.Errorf("update artifact: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

// ---------------------------------------------------------------------------
// bind / unbind / delete
// ---------------------------------------------------------------------------

var artifactBindCmd = &cobra.Command{
	Use:   "bind <project> <artifact-id>",
	Short: "Attach an archive row to a requirement or task",
	Args:  exactArgs(2),
	RunE:  runArtifactBind,
}

func runArtifactBind(cmd *cobra.Command, args []string) error {
	issueID := flagOr(cmd, "issue", "")
	if issueID == "" {
		return fmt.Errorf("--issue <issue-id> is required (find it with `multica issue list --project <p>`)")
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
	var updated map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/artifacts/" + url.PathEscape(args[1]) + "/bind"
	if err := client.PostJSON(ctx, path, map[string]any{"issue_id": issueID}, &updated); err != nil {
		return fmt.Errorf("bind artifact: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

var artifactUnbindCmd = &cobra.Command{
	Use:   "unbind <project> <artifact-id>",
	Short: "Detach an archive row from its issue (needs --yes; the row and file stay)",
	Args:  exactArgs(2),
	RunE:  runArtifactUnbind,
}

func runArtifactUnbind(cmd *cobra.Command, args []string) error {
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
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Unbind artifact %s from its issue. The row and the file stay; only the issue_id is cleared, so it leaves that issue's deliverables.",
		args[1])); err != nil {
		return err
	}
	var updated map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/artifacts/" + url.PathEscape(args[1])
	if err := client.PatchJSON(ctx, path, map[string]any{"issue_id": ""}, &updated); err != nil {
		return fmt.Errorf("unbind artifact: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

// artifactDeleteCmd removes a row. Rows linked to an asset binding are refused
// by the server (409 asset_linked): deleting one side would leave the other
// dangling, so those go through `multica asset unbind`.
var artifactDeleteCmd = &cobra.Command{
	Use:   "delete <project> <artifact-id>",
	Short: "Delete one archive row (needs --yes; the file on disk is not removed)",
	Args:  exactArgs(2),
	RunE:  runArtifactDelete,
}

func runArtifactDelete(cmd *cobra.Command, args []string) error {
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
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Delete archive row %s. The row disappears from the archive and the deliverables rollup; the file under rel_path on disk is not deleted.",
		args[1])); err != nil {
		return err
	}
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/artifacts/" + url.PathEscape(args[1])
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("delete artifact: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Deleted artifact %s\n", args[1])
	return nil
}

// ---------------------------------------------------------------------------
// matrix / unbound
// ---------------------------------------------------------------------------

var artifactMatrixCmd = &cobra.Command{
	Use:   "matrix <project>",
	Short: "Stage × doc_type coverage matrix",
	Args:  exactArgs(1),
	RunE:  runArtifactMatrix,
}

func runArtifactMatrix(cmd *cobra.Command, args []string) error {
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
	var matrix map[string]any
	if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/artifacts/matrix", &matrix); err != nil {
		return fmt.Errorf("get artifact matrix: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), matrix)
}

var artifactUnboundCmd = &cobra.Command{
	Use:   "unbound <project>",
	Short: "Archive rows not yet attached to any issue",
	Args:  exactArgs(1),
	RunE:  runArtifactUnbound,
}

func runArtifactUnbound(cmd *cobra.Command, args []string) error {
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
	var artifacts []map[string]any
	if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/artifacts/unbound", &artifacts); err != nil {
		return fmt.Errorf("list unbound artifacts: %w", err)
	}
	limit, _ := cmd.Flags().GetInt("limit")
	rows := capRows(artifacts, limit)
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"artifacts": rows, "total": len(artifacts)})
	}
	headers := []string{"ID", "SCOPE", "STAGE", "DOC_TYPE", "PATH"}
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, []string{
			shortID(strVal(row, "id")),
			blankDash(strVal(row, "scope")),
			blankDash(strVal(row, "stage")),
			truncateCell(strVal(row, "doc_type"), 20),
			truncateCell(strVal(row, "rel_path"), 56),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, out)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d unbound row(s) of %d.\n", len(rows), len(artifacts))
	return nil
}
