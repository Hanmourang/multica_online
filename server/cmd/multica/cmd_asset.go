package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 资产是侧栏里独立的产品模块。project_asset_binding 有两个作用域：
// issue_id IS NULL = 项目级，非空 = 工作项级；项目详情页只列项目级绑定，所以
// agent 过去既读不全（只看到项目级）也改不动（CLI 只能通过 project tab 读）。
// 这里把「读全量」与「写单条绑定」分开：读默认跨项目，写必须点名 project。
var assetCmd = &cobra.Command{
	Use:   "asset",
	Short: "Read and manage asset bindings (project and work-item scope)",
	Long: `An asset is a binding, not a file: one row per (asset, project-or-issue) pair.

  multica asset list [--project <p>] [--scope all|project|issue] [--issue <i>]
  multica asset matrix --project <p>
  multica asset bind <project> --category <c> --name <n> [--issue <i>] [--stage S2] [--role output]
  multica asset meta <binding-id> --project <p> [--stage S1] [--role input] [--tags a,b]
  multica asset unbind <binding-id> --project <p> --yes
  multica asset sync <project> [--category knowledge_repo] --yes

asset_category: code_repository | application | package | knowledge_repo | knowledge_group | other
lifecycle_stage: S1 | S2 | S3 | S4 | S5 | general      asset_role: input | output
links: depends_on | produces | resolves                  --yes is required for unbind/sync`,
}

// assetQuery is the read shape shared by `asset list` and `project tab get ...
// assets`, so both surfaces always page and filter identically.
type assetQuery struct {
	ProjectID string
	Scope     string
	IssueID   string
	Category  string
	Name      string
	Limit     int
}

type assetPageResult struct {
	Source     string
	Scope      string
	Items      []map[string]any
	Page       int
	PageSize   int
	TotalCount int
	TotalPages int
}

func fetchAssetPage(ctx context.Context, client *cli.APIClient, q assetQuery) (assetPageResult, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	params := url.Values{
		"toPage":   {"1"},
		"pageSize": {strconv.Itoa(limit)},
	}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	if category := strings.TrimSpace(q.Category); category != "" {
		params.Set("category", category)
	}
	if name := strings.TrimSpace(q.Name); name != "" {
		params.Set("name", name)
	}

	scope := strings.ToLower(strings.TrimSpace(q.Scope))
	issueID := strings.TrimSpace(q.IssueID)
	if issueID != "" {
		scope = "issue"
	}
	if scope == "" {
		scope = "all"
	}

	var path string
	switch scope {
	case "issue":
		if issueID == "" {
			return assetPageResult{}, fmt.Errorf("--scope issue needs --issue <issue-id>; find one with `multica issue list --project <p>`, or use --scope all")
		}
		path = "/api/issues/" + url.PathEscape(issueID) + "/assets"
	case "project":
		if q.ProjectID == "" {
			return assetPageResult{}, fmt.Errorf("--scope project needs --project <project-id-or-name>")
		}
		path = "/api/projects/" + url.PathEscape(q.ProjectID) + "/assets/page"
	case "all":
		path = "/api/assets/page"
		if q.ProjectID != "" {
			params.Set("projectId", q.ProjectID)
		}
	default:
		return assetPageResult{}, fmt.Errorf("unknown --scope %q; use all, project or issue", scope)
	}

	var page struct {
		Items      []map[string]any `json:"items"`
		Page       int              `json:"page"`
		PageSize   int              `json:"pageSize"`
		TotalCount int              `json:"totalCount"`
		TotalPages int              `json:"totalPages"`
	}
	source := path + "?" + params.Encode()
	if err := client.GetJSON(ctx, source, &page); err != nil {
		return assetPageResult{}, fmt.Errorf("get assets (%s scope): %w", scope, err)
	}
	return assetPageResult{
		Source:     source,
		Scope:      scope,
		Items:      page.Items,
		Page:       page.Page,
		PageSize:   page.PageSize,
		TotalCount: page.TotalCount,
		TotalPages: page.TotalPages,
	}, nil
}

// fetchAssetOverview reads the stage matrix: bindings carrying stage/role plus
// the issues they can be linked to.
func fetchAssetOverview(ctx context.Context, client *cli.APIClient, projectID string) (map[string]any, error) {
	params := url.Values{"projectId": {projectID}}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	var overview map[string]any
	if err := client.GetJSON(ctx, "/api/assets/overview?"+params.Encode(), &overview); err != nil {
		return nil, fmt.Errorf("get asset matrix: %w", err)
	}
	return overview, nil
}

// ---------------------------------------------------------------------------
// asset list
// ---------------------------------------------------------------------------

var assetListCmd = &cobra.Command{
	Use:   "list",
	Short: "List asset bindings (default: every project in the workspace)",
	Long: `Lists bindings at both scopes. Without --project it returns the whole
workspace (the 资产管理 page); with --project it narrows to one project.

--scope all reads /api/assets/page (both scopes), --scope project reads only
project-level rows, --scope issue reads only that work item's rows.`,
	Args: exactArgs(0),
	RunE: runAssetList,
}

func init() {
	assetListCmd.Flags().String("project", "", "Project id or name (default: every project in the workspace)")
	assetListCmd.Flags().String("scope", "", "all (default) | project | issue")
	assetListCmd.Flags().String("issue", "", "Issue id; implies --scope issue")
	assetListCmd.Flags().String("category", "", "Filter by asset_category")
	assetListCmd.Flags().String("name", "", "Filter by asset_name substring")
	assetListCmd.Flags().Int("limit", 50, "Page size (max 200 — raise it before concluding a list is complete)")
	assetListCmd.Flags().String("output", "table", "Output format: table or json")
	assetCmd.AddCommand(assetListCmd)

	assetMatrixCmd.Flags().String("project", "", "Project id or name")
	assetMatrixCmd.Flags().String("output", "table", "Output format: table or json")
	assetCmd.AddCommand(assetMatrixCmd)

	assetBindCmd.Flags().String("category", "", "asset_category (required)")
	assetBindCmd.Flags().String("name", "", "asset_name (required)")
	assetBindCmd.Flags().String("issue", "", "Bind at work-item scope instead of project scope")
	assetBindCmd.Flags().String("source", "manual", "source tag")
	assetBindCmd.Flags().String("subtype", "", "asset_subtype")
	assetBindCmd.Flags().String("ref", "", "external_ref as JSON, e.g. '{\"path\":\"docs/x.md\"}'")
	assetBindCmd.Flags().String("resource", "", "resource_id from `multica project resource list`")
	assetBindCmd.Flags().String("stage", "", "lifecycle_stage: S1..S5 or general")
	assetBindCmd.Flags().String("role", "", "asset_role: input or output")
	assetBindCmd.Flags().String("tags", "", "Comma-separated tags")
	assetBindCmd.Flags().String("links", "", "Comma-separated issue-id:link_type (depends_on|produces|resolves)")
	assetBindCmd.Flags().String("output", "json", "Output format: table or json")
	assetCmd.AddCommand(assetBindCmd)

	assetMetaCmd.Flags().String("project", "", "Project id or name (required)")
	assetMetaCmd.Flags().String("stage", "", "lifecycle_stage: S1..S5, general, or \"\" to clear")
	assetMetaCmd.Flags().String("role", "", "asset_role: input, output, or \"\" to clear")
	assetMetaCmd.Flags().String("category", "", "asset_category")
	assetMetaCmd.Flags().String("tags", "", "Comma-separated tags (replaces the set)")
	assetMetaCmd.Flags().String("links", "", "Comma-separated issue-id:link_type (replaces the set)")
	assetMetaCmd.Flags().String("output", "json", "Output format: table or json")
	assetCmd.AddCommand(assetMetaCmd)

	assetUnbindCmd.Flags().String("project", "", "Project id or name (required)")
	addDestructiveFlags(assetUnbindCmd)
	assetCmd.AddCommand(assetUnbindCmd)

	assetSyncCmd.Flags().String("category", "knowledge_repo", "asset_category applied to imported rows")
	addDestructiveFlags(assetSyncCmd)
	assetCmd.AddCommand(assetSyncCmd)
}

func runAssetList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveOptionalProject(ctx, client, cmd)
	if err != nil {
		return err
	}
	query := readAssetQueryFlags(cmd)
	if projectRef != nil {
		query.ProjectID = projectRef.ID
	}
	page, err := fetchAssetPage(ctx, client, query)
	if err != nil {
		return err
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"source":      page.Source,
			"scope":       page.Scope,
			"items":       page.Items,
			"total":       page.TotalCount,
			"page":        page.Page,
			"page_size":   page.PageSize,
			"total_pages": page.TotalPages,
			"next": "multica asset matrix --project <p>   (stage matrix + linkable issues); " +
				"multica asset get <binding-id> --project <p> is not a thing — rows already carry every field",
		})
	}

	headers := []string{"BINDING", "CATEGORY", "NAME", "SCOPE", "STAGE", "ROLE", "ISSUE", "PROJECT"}
	rows := make([][]string, 0, len(page.Items))
	for _, item := range page.Items {
		scope := "project"
		if strVal(item, "issue_id") != "" {
			scope = "issue"
		}
		rows = append(rows, []string{
			shortID(strVal(item, "id")),
			strVal(item, "asset_category"),
			truncateCell(strVal(item, "asset_name"), 48),
			scope,
			blankDash(strVal(item, "lifecycle_stage")),
			blankDash(strVal(item, "asset_role")),
			shortID(strVal(item, "issue_id")),
			shortID(strVal(item, "project_id")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d binding(s) — page %d/%d of %d. Increase --limit (max 200) before concluding a list is short.\n",
		page.TotalCount, page.Page, max(page.TotalPages, 1), page.TotalCount)
	return nil
}

// readAssetQueryFlags reads the four read filters shared by `asset list` and
// `project tab get`.
func readAssetQueryFlags(cmd *cobra.Command) assetQuery {
	scope, _ := cmd.Flags().GetString("scope")
	issueID, _ := cmd.Flags().GetString("issue")
	category, _ := cmd.Flags().GetString("category")
	name, _ := cmd.Flags().GetString("name")
	limit, _ := cmd.Flags().GetInt("limit")
	return assetQuery{Scope: scope, IssueID: issueID, Category: category, Name: name, Limit: limit}
}

// resolveOptionalProject returns nil when --project is absent, so workspace-wide
// reads work without inventing a project.
func resolveOptionalProject(ctx context.Context, client *cli.APIClient, cmd *cobra.Command) (*resolvedID, error) {
	ref, _ := cmd.Flags().GetString("project")
	if strings.TrimSpace(ref) == "" {
		return nil, nil
	}
	project, err := resolveProjectID(ctx, client, ref)
	if err != nil {
		return nil, fmt.Errorf("resolve project: %w", err)
	}
	return &project, nil
}

// ---------------------------------------------------------------------------
// asset matrix
// ---------------------------------------------------------------------------

var assetMatrixCmd = &cobra.Command{
	Use:   "matrix",
	Short: "Stage matrix: bindings with their stage/role plus linkable issues",
	Args:  exactArgs(0),
	RunE:  runAssetMatrix,
}

func runAssetMatrix(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveOptionalProject(ctx, client, cmd)
	if err != nil {
		return err
	}
	if projectRef == nil {
		return fmt.Errorf("asset matrix needs --project <project-id-or-name> (the endpoint is per project)")
	}
	overview, err := fetchAssetOverview(ctx, client, projectRef.ID)
	if err != nil {
		return err
	}

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), overview)
	}

	bindings := anySlice(overview["bindings"])
	issues := anySlice(overview["issues"])
	headers := []string{"BINDING", "CATEGORY", "NAME", "STAGE", "ROLE", "TAGS", "LINKS"}
	rows := make([][]string, 0, len(bindings))
	for _, raw := range bindings {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		rows = append(rows, []string{
			shortID(strVal(item, "id")),
			strVal(item, "asset_category"),
			truncateCell(strVal(item, "asset_name"), 40),
			blankDash(strVal(item, "lifecycle_stage")),
			blankDash(strVal(item, "asset_role")),
			blankDash(strings.Join(anyStrings(item["tags"]), ",")),
			blankDash(strings.Join(linkPairs(item["links"]), ",")),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), headers, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "\n%d binding(s), %d linkable issue(s).\n", len(bindings), len(issues))
	return nil
}

// ---------------------------------------------------------------------------
// asset bind
// ---------------------------------------------------------------------------

var assetBindCmd = &cobra.Command{
	Use:   "bind <project>",
	Short: "Bind an asset to a project (or one work item with --issue)",
	Long: `Creates one project_asset_binding row. Binding the same asset twice is not
deduplicated by the server — list first when you are unsure.`,
	Args: exactArgs(1),
	RunE: runAssetBind,
}

func runAssetBind(cmd *cobra.Command, args []string) error {
	category, _ := cmd.Flags().GetString("category")
	name, _ := cmd.Flags().GetString("name")
	if strings.TrimSpace(category) == "" || strings.TrimSpace(name) == "" {
		return fmt.Errorf("--category and --name are required (asset_category: code_repository|application|package|knowledge_repo|knowledge_group|other)")
	}
	refJSON, _ := cmd.Flags().GetString("ref")
	if strings.TrimSpace(refJSON) != "" && !json.Valid([]byte(refJSON)) {
		return fmt.Errorf("--ref must be valid JSON, got %q", refJSON)
	}
	links, err := parseAssetLinks(cmd)
	if err != nil {
		return err
	}
	tags, _ := cmd.Flags().GetString("tags")

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
		"asset_category": strings.TrimSpace(category),
		"asset_name":     strings.TrimSpace(name),
		"source":         flagOr(cmd, "source", "manual"),
	}
	if v := flagOr(cmd, "issue", ""); v != "" {
		body["issue_id"] = v
	}
	if v := flagOr(cmd, "subtype", ""); v != "" {
		body["asset_subtype"] = v
	}
	if v := flagOr(cmd, "resource", ""); v != "" {
		body["resource_id"] = v
	}
	if strings.TrimSpace(refJSON) != "" {
		body["external_ref"] = json.RawMessage(refJSON)
	}
	if v := flagOr(cmd, "stage", ""); v != "" {
		body["lifecycle_stage"] = v
	}
	if v := flagOr(cmd, "role", ""); v != "" {
		body["asset_role"] = v
	}
	if v := splitCSV(tags); len(v) > 0 {
		body["tags"] = v
	}
	if len(links) > 0 {
		body["links"] = links
	}

	var created map[string]any
	if err := client.PostJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/assets", body, &created); err != nil {
		return fmt.Errorf("bind asset: %w", err)
	}
	return printAssetResult(cmd, created, "Bound "+strVal(created, "asset_name")+" ("+strVal(created, "id")+")")
}

// ---------------------------------------------------------------------------
// asset meta
// ---------------------------------------------------------------------------

var assetMetaCmd = &cobra.Command{
	Use:   "meta <binding-id>",
	Short: "Set stage / role / category / tags / links on one binding",
	Long: `Pointer semantics, mirrored from the API: a flag you omit leaves the column
alone; passing an empty string clears it. --tags and --links replace the whole
set when present.`,
	Args: exactArgs(1),
	RunE: runAssetMeta,
}

func runAssetMeta(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveRequiredProjectFlag(ctx, client, cmd)
	if err != nil {
		return err
	}

	body := map[string]any{}
	if cmd.Flags().Changed("stage") {
		body["lifecycle_stage"] = flagOr(cmd, "stage", "")
	}
	if cmd.Flags().Changed("role") {
		body["asset_role"] = flagOr(cmd, "role", "")
	}
	if cmd.Flags().Changed("category") {
		body["asset_category"] = flagOr(cmd, "category", "")
	}
	if cmd.Flags().Changed("tags") {
		tags, _ := cmd.Flags().GetString("tags")
		body["tags"] = splitCSV(tags)
	}
	if cmd.Flags().Changed("links") {
		links, err := parseAssetLinks(cmd)
		if err != nil {
			return err
		}
		body["links"] = links
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass at least one of --stage, --role, --category, --tags, --links")
	}

	var updated map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/assets/" + url.PathEscape(args[0]) + "/meta"
	if err := client.PutJSON(ctx, path, body, &updated); err != nil {
		return fmt.Errorf("update asset meta: %w", err)
	}
	return printAssetResult(cmd, updated, "Updated "+args[0])
}

// ---------------------------------------------------------------------------
// asset unbind (destructive)
// ---------------------------------------------------------------------------

var assetUnbindCmd = &cobra.Command{
	Use:   "unbind <binding-id>",
	Short: "Remove one asset binding (needs --yes; the asset file is untouched)",
	Args:  exactArgs(1),
	RunE:  runAssetUnbind,
}

func runAssetUnbind(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	projectRef, err := resolveRequiredProjectFlag(ctx, client, cmd)
	if err != nil {
		return err
	}
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Unbind asset binding %s from project %s. The binding (stage, role, tags, links) is deleted; the underlying file or repository is not touched.",
		args[0], projectRef.ID)); err != nil {
		return err
	}

	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/assets/" + url.PathEscape(args[0])
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("unbind asset: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Unbound %s\n", args[0])
	return nil
}

// ---------------------------------------------------------------------------
// asset sync (bulk write, destructive)
// ---------------------------------------------------------------------------

var assetSyncCmd = &cobra.Command{
	Use:   "sync <project>",
	Short: "Import archive documents as asset bindings (needs --yes; writes many rows)",
	Long: `Walks the project's archive documents and creates bindings for the ones that
are not bound yet. It writes many rows at once, so it is gated like a delete:
run it once with the person watching the first time.`,
	Args: exactArgs(1),
	RunE: runAssetSync,
}

func runAssetSync(cmd *cobra.Command, args []string) error {
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
	category, _ := cmd.Flags().GetString("category")
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Import every unbound archive document of project %s as asset_category=%q. This creates bindings in bulk and is not undone by a single command.",
		projectRef.ID, category)); err != nil {
		return err
	}

	var result map[string]any
	body := map[string]any{"asset_category": category}
	if err := client.PostJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/assets/sync-from-archive", body, &result); err != nil {
		return fmt.Errorf("sync assets from archive: %w", err)
	}
	return printAssetResult(cmd, result, "Synced archive documents into asset bindings")
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func resolveRequiredProjectFlag(ctx context.Context, client *cli.APIClient, cmd *cobra.Command) (*resolvedID, error) {
	project, err := resolveOptionalProject(ctx, client, cmd)
	if err != nil {
		return nil, err
	}
	if project == nil {
		return nil, fmt.Errorf("--project <project-id-or-name> is required here (bindings are scoped to a project)")
	}
	return project, nil
}

func parseAssetLinks(cmd *cobra.Command) ([]map[string]string, error) {
	raw, _ := cmd.Flags().GetString("links")
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	links := make([]map[string]string, 0, 2)
	for _, pair := range splitCSV(raw) {
		parts := strings.SplitN(pair, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return nil, fmt.Errorf("--links entry %q must be <issue-id>:<depends_on|produces|resolves>", pair)
		}
		linkType := strings.TrimSpace(parts[1])
		switch linkType {
		case "depends_on", "produces", "resolves":
		default:
			return nil, fmt.Errorf("--links entry %q: link_type must be depends_on, produces or resolves", pair)
		}
		links = append(links, map[string]string{
			"issue_id":  strings.TrimSpace(parts[0]),
			"link_type": linkType,
		})
	}
	return links, nil
}

func printAssetResult(cmd *cobra.Command, result map[string]any, fallback string) error {
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		if id := strVal(result, "id"); id != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "%s\n", fallback)
			return nil
		}
	}
	if len(result) > 0 {
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s\n", fallback)
	return nil
}

func flagOr(cmd *cobra.Command, name, fallback string) string {
	value, err := cmd.Flags().GetString(name)
	if err != nil || strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func anySlice(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return nil
}

func anyStrings(value any) []string {
	list := anySlice(value)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func linkPairs(value any) []string {
	list := anySlice(value)
	out := make([]string, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, shortID(strVal(m, "issue_id"))+":"+strVal(m, "link_type"))
	}
	return out
}

func shortID(id string) string {
	if id == "" {
		return "-"
	}
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func truncateCell(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit-1]) + "…"
}

func blankDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}
