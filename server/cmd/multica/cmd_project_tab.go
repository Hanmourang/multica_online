package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 项目详情页的 TAB 集合（前端 packages/core/projects/templates.ts 的
// PROJECT_VIEWS）。每个 TAB 背后是一组各自独立的 HTTP 资源：档案是
// artifacts、资产是 assets/page、数据模型是 graph、迭代是 sprints……agent
// 拿不到这张映射时，只能在 `/api/projects/...` 上一个个猜。`multica project
// tab` 把这张映射固化下来：list 给出「这个项目有哪些 TAB、各有多少条」，
// get 直接取回该 TAB 的数据。
var projectTabCmd = &cobra.Command{
	Use:   "tab",
	Short: "Read a project detail tab (archive, assets, features, sprints, …)",
	Long: `A project's detail page is a fixed set of tabs, and each tab is a different
resource underneath the project. These commands are the mapping:

  multica project tab list <project>              # which tabs exist + row counts
  multica project tab get <project> <tab>         # the tab's data as JSON

Tabs: archive, assets, features, data-model, requirements, tasks, acceptance,
deliverables, workflows, sprints, filing. Which ones a project actually shows
is decided by its template (general | rd | data | full).`,
}

var projectTabListCmd = &cobra.Command{
	Use:   "list <project>",
	Short: "List the project's tabs with row counts",
	Args:  exactArgs(1),
	RunE:  runProjectTabList,
}

var projectTabGetCmd = &cobra.Command{
	Use:   "get <project> <tab>",
	Short: "Fetch one project tab's data as JSON",
	Args:  exactArgs(2),
	RunE:  runProjectTabGet,
}

func init() {
	projectTabListCmd.Flags().Bool("no-count", false, "Skip per-tab row counts (one request per tab)")
	projectTabListCmd.Flags().String("output", "table", "Output format: table or json")
	projectTabListCmd.Flags().Bool("all-tabs", false, "List every tab, including ones the project template hides")

	projectTabGetCmd.Flags().Int("limit", 50, "Maximum rows per collection")
	projectTabGetCmd.Flags().String("issue", "", "Issue id: narrows assets to one work item, or details one issue's deliverables")
	projectTabGetCmd.Flags().String("output", "json", "Output format: json")
	// assets：作用域与筛选。默认 all 才读得全 —— 项目页签只列项目级绑定
	// （issue_id IS NULL），工作项上绑的资产（档案导入的那批）全在窗口外。
	projectTabGetCmd.Flags().String("scope", "", "assets: all (default) | project | issue (needs --issue)")
	projectTabGetCmd.Flags().String("category", "", "assets: filter by asset_category")
	projectTabGetCmd.Flags().String("name", "", "assets: filter by asset_name substring")
	projectTabGetCmd.Flags().Bool("matrix", false, "assets: also read the stage matrix and requirement links (GET /api/assets/overview)")
	// archive：筛选 + 正文。归档正文接口只回 attachment_url / content_unavailable，
	// 读文件本身要走档案仓库目录，见 multica-project-tabs skill。
	projectTabGetCmd.Flags().String("stage", "", "archive: filter by stage 1..5")
	projectTabGetCmd.Flags().String("doc-class", "", "archive: prd | mrd | brd | roadmap | planning")
	projectTabGetCmd.Flags().String("doc-type", "", "archive: filter by doc_type")
	projectTabGetCmd.Flags().String("q", "", "archive: substring match over path / doc_type / doc_class / doc_module / requirement_key")
	projectTabGetCmd.Flags().Bool("unbound", false, "archive: only requirement-scope rows with no issue bound")
	projectTabGetCmd.Flags().String("doc", "", "archive: read one artifact (--doc <artifact-id>) content pointer")

	projectTabCmd.AddCommand(projectTabListCmd)
	projectTabCmd.AddCommand(projectTabGetCmd)
	projectCmd.AddCommand(projectTabCmd)
}

// projectTabDef is the static part of a tab: its ?view= key, the page label,
// and what the tab actually contains — the last one is what stops an agent from
// hunting for "assets" inside the requirements endpoint.
type projectTabDef struct {
	Key   string
	Title string
	Reads string
}

var projectTabDefs = []projectTabDef{
	{Key: "archive", Title: "项目档案", Reads: "archived documents synced from the archive repo (project_artifact)"},
	{Key: "assets", Title: "资产", Reads: "bound assets / archive-to-asset mappings"},
	{Key: "features", Title: "功能模块", Reads: "feature modules (project_module) — use `multica module` for prototypes"},
	{Key: "data-model", Title: "数据模型", Reads: "graph modules, the bus matrix and their drift"},
	{Key: "requirements", Title: "需求管理", Reads: "top-level requirements with goals and acceptance"},
	{Key: "tasks", Title: "任务追踪", Reads: "every issue of the project (board / list / gantt source)"},
	{Key: "acceptance", Title: "验收详情", Reads: "acceptance criteria and verdicts on requirements"},
	{Key: "deliverables", Title: "交付物", Reads: "archive rows carrying an issue — project rollup by default, one issue with --issue"},
	{Key: "filing", Title: "申报", Reads: "filing readiness (software copyright / patent tracks)"},
	{Key: "workflows", Title: "工作流", Reads: "workflow templates and stage runs"},
	{Key: "sprints", Title: "迭代", Reads: "sprints (迭代) of the project"},
	// 模板只对 general/rd/data 生效；模板未知的老项目保留全部八个 TAB。
}

// projectTabTemplateViews mirrors PROJECT_TEMPLATE_VIEWS in the frontend. A tab
// the template hides is still readable over HTTP, but telling an agent about it
// sends it looking for something the user cannot see in the UI.
var projectTabTemplateViews = map[string][]string{
	"general": {"archive", "assets", "requirements", "tasks", "deliverables", "workflows", "sprints"},
	"rd":      {"archive", "assets", "features", "requirements", "tasks", "acceptance", "deliverables", "filing", "workflows", "sprints"},
	"data":    {"archive", "assets", "data-model", "requirements", "tasks", "acceptance", "deliverables", "workflows", "sprints"},
}

var projectTabAliases = map[string]string{
	"asset":       "assets",
	"module":      "features",
	"modules":     "features",
	"feature":     "features",
	"data_model":  "data-model",
	"datamodel":   "data-model",
	"graph":       "data-model",
	"requirement": "requirements",
	"req":         "requirements",
	"task":        "tasks",
	"issue":       "tasks",
	"deliverable": "deliverables",
	"workflow":    "workflows",
	"sprint":      "sprints",
	"iteration":   "sprints",
	"iterations":  "sprints",
	"declare":     "filing",
}

func normalizeProjectTab(input string) (string, bool) {
	key := strings.ToLower(strings.TrimSpace(input))
	if alias, ok := projectTabAliases[key]; ok {
		key = alias
	}
	for _, def := range projectTabDefs {
		if def.Key == key {
			return key, true
		}
	}
	return "", false
}

// projectTabsForTemplate returns the tab keys a project with this template
// renders, in project-page order. Unknown / missing templates keep everything.
func projectTabsForTemplate(template string) []string {
	allowed, ok := projectTabTemplateViews[template]
	if !ok {
		allowed = nil
		for _, def := range projectTabDefs {
			allowed = append(allowed, def.Key)
		}
		return allowed
	}
	present := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		present[key] = true
	}
	out := make([]string, 0, len(allowed))
	for _, def := range projectTabDefs {
		if present[def.Key] {
			out = append(out, def.Key)
		}
	}
	return out
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

func projectTabEndpoint(projectID, tab string) (string, error) {
	switch tab {
	case "archive":
		return "/api/projects/" + url.PathEscape(projectID) + "/artifacts", nil
	case "assets":
		return "/api/projects/" + url.PathEscape(projectID) + "/assets/page", nil
	case "data-model":
		return "/api/projects/" + url.PathEscape(projectID) + "/graph/modules", nil
	case "requirements", "tasks", "acceptance":
		return "/api/issues", nil
	case "filing":
		return "/api/projects/" + url.PathEscape(projectID) + "/filing/readiness", nil
	case "workflows":
		return "/api/projects/" + url.PathEscape(projectID) + "/workflow/templates", nil
	case "sprints":
		return "/api/projects/" + url.PathEscape(projectID) + "/sprints", nil
	}
	return "", fmt.Errorf("tab %q has no direct collection endpoint", tab)
}

func projectTabCount(ctx context.Context, client *cli.APIClient, projectID, tab string) string {
	escaped := url.PathEscape(projectID)
	switch tab {
	case "features":
		modules, err := fetchProjectModules(ctx, client, projectID)
		if err != nil {
			return "?"
		}
		return fmt.Sprintf("%d", len(modules))
	case "deliverables":
		// Deliverables are per issue; a project-wide number does not exist.
		return "-"
	case "workflows":
		var templates struct {
			Templates []any `json:"templates"`
		}
		var runs struct {
			Total int `json:"total"`
		}
		if err := client.GetJSON(ctx, "/api/projects/"+escaped+"/workflow/templates", &templates); err != nil {
			return "?"
		}
		if err := client.GetJSON(ctx, "/api/projects/"+escaped+"/workflow-instances?limit=1", &runs); err != nil {
			return fmt.Sprintf("%d templates", len(templates.Templates))
		}
		return fmt.Sprintf("%d templates / %d runs", len(templates.Templates), runs.Total)
	case "assets":
		// The project page lists project-level bindings only, so counting it
		// understates the project: the workspace aggregate narrowed by projectId
		// counts both scopes, and totalCount is the number the page itself shows.
		params := url.Values{"projectId": {projectID}, "pageSize": {"1"}}
		if client.WorkspaceID != "" {
			params.Set("workspace_id", client.WorkspaceID)
		}
		var page struct {
			TotalCount int `json:"totalCount"`
		}
		if err := client.GetJSON(ctx, "/api/assets/page?"+params.Encode(), &page); err != nil {
			return "?"
		}
		return fmt.Sprintf("%d", page.TotalCount)

	case "filing":
		var readiness struct {
			BlockingCount int `json:"blocking_count"`
		}
		if err := client.GetJSON(ctx, "/api/projects/"+escaped+"/filing/readiness", &readiness); err != nil {
			return "?"
		}
		if readiness.BlockingCount == 0 {
			return "ready"
		}
		return fmt.Sprintf("%d blocking", readiness.BlockingCount)
	}

	path, err := projectTabEndpoint(projectID, tab)
	if err != nil {
		return "-"
	}
	params := url.Values{"limit": {"1"}}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	switch tab {
	case "requirements", "acceptance":
		params.Set("project_id", projectID)
		params.Set("kind", "requirement")
	case "tasks":
		params.Set("project_id", projectID)
	}

	var raw map[string]any
	if err := client.GetJSON(ctx, path+"?"+params.Encode(), &raw); err != nil {
		return "?"
	}
	return fmt.Sprintf("%d", countFromEnvelope(raw, tab))
}

func countFromEnvelope(raw map[string]any, tab string) int {
	if total, ok := raw["total"].(float64); ok {
		return int(total)
	}
	listKey := map[string]string{
		"archive": "artifacts",
		"assets":  "items",
		"sprints": "sprints",
		"issues":  "issues",
	}[tab]
	if listKey == "" {
		listKey = "items"
	}
	if list, ok := raw[listKey].([]any); ok {
		return len(list)
	}
	return 0
}

func runProjectTabList(cmd *cobra.Command, args []string) error {
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

	var project map[string]any
	if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID), &project); err != nil {
		return fmt.Errorf("get project: %w", err)
	}
	template := strVal(project, "template")

	showAll, _ := cmd.Flags().GetBool("all-tabs")
	keys := projectTabsForTemplate(template)
	if showAll {
		keys = projectTabsForTemplate("")
	}

	noCount, _ := cmd.Flags().GetBool("no-count")
	type tabRow struct {
		Key   string `json:"key"`
		Title string `json:"title"`
		Reads string `json:"reads"`
		Count string `json:"count"`
	}
	rows := make([]tabRow, 0, len(keys))
	for _, key := range keys {
		var def projectTabDef
		for _, candidate := range projectTabDefs {
			if candidate.Key == key {
				def = candidate
				break
			}
		}
		count := "-"
		if !noCount {
			count = projectTabCount(ctx, client, projectRef.ID, key)
		}
		rows = append(rows, tabRow{Key: key, Title: def.Title, Reads: def.Reads, Count: count})
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"project_id": projectRef.ID,
			"title":      strVal(project, "title"),
			"template":   orUnknown(template),
			"tabs":       rows,
		})
	}

	fmt.Printf("Project:  %s (%s)\n", strVal(project, "title"), projectRef.ID)
	fmt.Printf("Template: %s\n\n", orUnknown(template))

	table := make([][]string, 0, len(rows))
	for _, row := range rows {
		table = append(table, []string{row.Key, row.Title, row.Count, row.Reads})
	}
	cli.PrintTable(os.Stdout, []string{"TAB", "TITLE", "ROWS", "WHAT IT HOLDS"}, table)

	fmt.Fprintf(os.Stderr, "\nRead one with: multica project tab get %s <tab>\n", projectRef.ID)
	return nil
}

func runProjectTabGet(cmd *cobra.Command, args []string) error {
	tab, ok := normalizeProjectTab(args[1])
	if !ok {
		keys := make([]string, 0, len(projectTabDefs))
		for _, def := range projectTabDefs {
			keys = append(keys, def.Key)
		}
		return fmt.Errorf("unknown tab %q; valid tabs: %s", args[1], strings.Join(keys, ", "))
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

	limit, _ := cmd.Flags().GetInt("limit")
	payload := map[string]any{
		"project_id": projectRef.ID,
		"tab":        tab,
	}

	switch tab {
	case "assets":
		// The project tab lists only project-level bindings (issue_id IS NULL),
		// so an agent asked "what assets does this project have" sees a fraction
		// of them: every binding made on a work item — the archive-imported ones
		// included — falls outside that window. Default to the workspace
		// aggregate narrowed by projectId, which returns both scopes.
		if err := collectTabAssets(ctx, client, projectRef.ID, limit, cmd, payload); err != nil {
			return err
		}
	case "archive":
		if err := collectTabArchive(ctx, client, projectRef.ID, limit, cmd, payload); err != nil {
			return err
		}
	case "features":
		modules, err := fetchProjectModules(ctx, client, projectRef.ID)
		if err != nil {
			return err
		}
		enriched := make([]map[string]any, 0, len(modules))
		for _, module := range modules {
			issues, err := fetchModuleIssues(ctx, client, module.ID)
			if err != nil {
				return err
			}
			enriched = append(enriched, map[string]any{
				"id":            module.ID,
				"name":          module.Name,
				"graph_node_id": module.GraphNodeID,
				"issue_count":   len(issues),
				"issue_ids":     issueIDs(issues),
			})
		}
		payload["source"] = "/api/projects/{id}/modules + /api/issues?module_id="
		payload["modules"] = enriched
		payload["next"] = "multica module prototype read <module-id>"
	case "deliverables":
		if err := collectTabDeliverables(ctx, client, projectRef.ID, cmd, payload); err != nil {
			return err
		}
	case "data-model":
		var modules map[string]any
		if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/graph/modules", &modules); err != nil {
			return fmt.Errorf("get graph modules: %w", err)
		}
		var matrix map[string]any
		if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/graph/bus-matrix", &matrix); err != nil {
			return fmt.Errorf("get bus matrix: %w", err)
		}
		payload["source"] = "/api/projects/{id}/graph/modules + /graph/bus-matrix"
		payload["graph_modules"] = modules["modules"]
		payload["bus_matrix"] = matrix["bus_matrix"]
	case "workflows":
		var templates map[string]any
		if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/workflow/templates", &templates); err != nil {
			return fmt.Errorf("get workflow templates: %w", err)
		}
		qs := url.Values{"limit": {fmt.Sprintf("%d", limit)}}
		var instances map[string]any
		if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectRef.ID)+"/workflow-instances?"+qs.Encode(), &instances); err != nil {
			return fmt.Errorf("get workflow instances: %w", err)
		}
		payload["source"] = "/api/projects/{id}/workflow/templates + /workflow-instances"
		payload["templates"] = templates["templates"]
		payload["instances"] = instances["instances"]
		payload["status_counts"] = instances["status_counts"]
	default:
		path, err := projectTabEndpoint(projectRef.ID, tab)
		if err != nil {
			return err
		}
		params := url.Values{"limit": {fmt.Sprintf("%d", limit)}}
		if client.WorkspaceID != "" {
			params.Set("workspace_id", client.WorkspaceID)
		}
		if tab == "requirements" || tab == "tasks" || tab == "acceptance" {
			params.Set("project_id", projectRef.ID)
		}
		if tab == "requirements" || tab == "acceptance" {
			params.Set("kind", "requirement")
		}
		var raw map[string]any
		if err := client.GetJSON(ctx, path+"?"+params.Encode(), &raw); err != nil {
			return fmt.Errorf("get %s: %w", tab, err)
		}
		payload["source"] = path + "?" + params.Encode()
		if issues, ok := raw["issues"]; ok {
			payload["issues"] = issues
			payload["total"] = raw["total"]
		} else if artifacts, ok := raw["artifacts"]; ok {
			payload["artifacts"] = artifacts
			payload["total"] = raw["total"]
		} else if items, ok := raw["items"]; ok {
			payload["items"] = items
			payload["total"] = raw["total"]
		} else if sprints, ok := raw["sprints"]; ok {
			payload["sprints"] = sprints
			payload["total"] = raw["total"]
		} else {
			payload["data"] = raw
		}
	}

	if tab == "acceptance" {
		payload["next"] = "multica requirement acceptance criteria <issue-id> / `multica requirement get <issue-id>` for verdicts"
	}
	return cli.PrintJSON(os.Stdout, payload)
}

// collectTabAssets reads the assets tab. The scope flag decides which of the
// three endpoints answers:
//
//	all     GET /api/assets/page?projectId=…     project + issue bindings (default)
//	project GET /api/projects/{id}/assets/page   project bindings only (UI tab)
//	issue   GET /api/issues/{id}/assets          one work item's bindings
//
// All three page with toPage/pageSize — NOT `limit`, which the asset handlers
// ignore, which is why a `--limit 200` used to come back as 20 rows.
func collectTabAssets(ctx context.Context, client *cli.APIClient, projectID string, limit int, cmd *cobra.Command, payload map[string]any) error {
	matrix, _ := cmd.Flags().GetBool("matrix")

	// One query builder for both surfaces: `multica asset list` (no project) and
	// this tab (always one project). Duplicating it here is how the two drifted
	// apart before (toPage vs limit, totalCount vs total).
	query := readAssetQueryFlags(cmd)
	query.ProjectID = projectID
	if limit > 0 {
		query.Limit = limit
	}
	if query.Scope == "issue" && strings.TrimSpace(query.IssueID) == "" {
		return fmt.Errorf("--scope issue needs --issue <issue-id> (find one with `multica issue list --project %s`, or use --scope all)", projectID)
	}

	page, err := fetchAssetPage(ctx, client, query)
	if err != nil {
		return err
	}

	payload["source"] = page.Source
	payload["scope"] = page.Scope
	payload["items"] = page.Items
	payload["total"] = page.TotalCount
	payload["page"] = page.Page
	payload["page_size"] = page.PageSize
	payload["total_pages"] = page.TotalPages
	payload["next"] = "multica project tab get <p> assets --matrix  (stage matrix + requirement links); " +
		"multica asset meta <binding-id> --project <p>  (write stage/role/tags); " +
		"multica project tab get <p> archive --doc <artifact-id>  (archive row behind an imported asset)"

	if matrix {
		var overview struct {
			Bindings []map[string]any `json:"bindings"`
			Issues   []map[string]any `json:"issues"`
		}
		mq := url.Values{"projectId": {projectID}}
		if client.WorkspaceID != "" {
			mq.Set("workspace_id", client.WorkspaceID)
		}
		if err := client.GetJSON(ctx, "/api/assets/overview?"+mq.Encode(), &overview); err != nil {
			return fmt.Errorf("get asset overview: %w", err)
		}
		payload["matrix_source"] = "/api/assets/overview?" + mq.Encode()
		payload["matrix_bindings"] = overview.Bindings
		payload["linkable_issues"] = overview.Issues
	}
	return nil
}

// collectTabArchive reads the archive tab: the list, the unbound requirement
// rows, or one artifact's content pointer. The list endpoint has no paging —
// it returns every match — so --limit only truncates the local output.
func collectTabArchive(ctx context.Context, client *cli.APIClient, projectID string, limit int, cmd *cobra.Command, payload map[string]any) error {
	escaped := url.PathEscape(projectID)

	docID, _ := cmd.Flags().GetString("doc")
	if docID = strings.TrimSpace(docID); docID != "" {
		path := "/api/projects/" + escaped + "/artifacts/" + url.PathEscape(docID) + "/content"
		var content map[string]any
		if err := client.GetJSON(ctx, path, &content); err != nil {
			return fmt.Errorf("get artifact content pointer: %w", err)
		}
		payload["source"] = path
		payload["data"] = content
		payload["next"] = "content_unavailable=true means the server holds no rendered copy: read the file at " +
			"artifact.rel_path inside the archive repo, or the project's local_directory resource"
		return nil
	}

	unbound, _ := cmd.Flags().GetBool("unbound")
	if unbound {
		path := "/api/projects/" + escaped + "/artifacts/unbound"
		var artifacts []map[string]any
		if err := client.GetJSON(ctx, path, &artifacts); err != nil {
			return fmt.Errorf("get unbound artifacts: %w", err)
		}
		payload["source"] = path
		payload["artifacts"] = capRows(artifacts, limit)
		payload["total"] = len(artifacts)
		payload["next"] = "read a content pointer with --doc <artifact-id>; bind one with POST /api/projects/{id}/artifacts/{artifactId}/bind"
		return nil
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
	path := "/api/projects/" + escaped + "/artifacts"
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var resp struct {
		Artifacts []map[string]any `json:"artifacts"`
		Total     int              `json:"total"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("get archive artifacts: %w", err)
	}
	payload["source"] = path
	payload["artifacts"] = capRows(resp.Artifacts, limit)
	payload["total"] = resp.Total
	payload["next"] = "multica project tab get <p> deliverables  (project-wide rollup of these rows); " +
		"multica project tab get <p> archive --doc <artifact-id>  (content pointer)"
	return nil
}

// collectTabDeliverables answers the deliverables tab. With --issue it reads the
// per-issue overview (the UI's 交付概览); without one it rolls the project's
// archive rows up by scope / stage / issue, which is the 项目交付物 question —
// the per-issue endpoint alone cannot answer it.
func collectTabDeliverables(ctx context.Context, client *cli.APIClient, projectID string, cmd *cobra.Command, payload map[string]any) error {
	issueID, _ := cmd.Flags().GetString("issue")
	if issueID = strings.TrimSpace(issueID); issueID != "" {
		path := "/api/issues/" + url.PathEscape(issueID) + "/deliverables-overview"
		var raw map[string]any
		if err := client.GetJSON(ctx, path, &raw); err != nil {
			return fmt.Errorf("get deliverables of issue %s: %w", issueID, err)
		}
		payload["source"] = path
		payload["issue_id"] = issueID
		payload["data"] = raw
		payload["next"] = "multica project tab get <p> deliverables  (project-wide rollup, no --issue)"
		return nil
	}

	path := "/api/projects/" + url.PathEscape(projectID) + "/artifacts"
	var resp struct {
		Artifacts []map[string]any `json:"artifacts"`
		Total     int              `json:"total"`
	}
	if err := client.GetJSON(ctx, path, &resp); err != nil {
		return fmt.Errorf("get deliverables rollup: %w", err)
	}
	payload["source"] = path
	payload["rollup"] = aggregateProjectDeliverables(resp.Artifacts, 3)
	payload["next"] = "per-issue detail: multica project tab get <p> deliverables --issue <issue-id>; " +
		"unbound rows: multica project tab get <p> archive --unbound"
	return nil
}

func capRows(rows []map[string]any, limit int) []map[string]any {
	if limit > 0 && len(rows) > limit {
		return rows[:limit]
	}
	return rows
}

// aggregateProjectDeliverables rolls the archive rows up the way the 交付物 view
// reads them: an issue's deliverables ARE the artifacts carrying its issue_id.
// Returns counts per scope / stage / issue plus a few sample paths per issue, so
// "what does this project deliver" is one call instead of a per-issue sweep.
func aggregateProjectDeliverables(artifacts []map[string]any, samplesPerIssue int) map[string]any {
	byScope := map[string]int{}
	byStage := map[string]int{}
	byIssue := map[string]int{}
	samples := map[string][]string{}

	for _, artifact := range artifacts {
		scope, _ := artifact["scope"].(string)
		if scope == "" {
			scope = "unknown"
		}
		byScope[scope]++

		stage := "unassigned"
		if n, ok := artifact["stage"].(float64); ok && n > 0 {
			stage = strconv.Itoa(int(n))
		}
		byStage[stage]++

		issueID, _ := artifact["issue_id"].(string)
		if issueID == "" {
			byIssue["unassigned"]++
			continue
		}
		byIssue[issueID]++
		if relPath, _ := artifact["rel_path"].(string); relPath != "" && len(samples[issueID]) < samplesPerIssue {
			samples[issueID] = append(samples[issueID], relPath)
		}
	}

	issues := make([]map[string]any, 0, len(byIssue))
	for issueID, count := range byIssue {
		issues = append(issues, map[string]any{
			"issue_id":       issueID,
			"artifact_count": count,
			"sample_paths":   samples[issueID],
		})
	}
	sort.Slice(issues, func(i, j int) bool {
		return issues[i]["issue_id"].(string) < issues[j]["issue_id"].(string)
	})

	return map[string]any{
		"total":      len(artifacts),
		"by_scope":   byScope,
		"by_stage":   byStage,
		"by_issue":   issues,
		"unassigned": byIssue["unassigned"],
		"scope_note": "deliverables are archive rows carrying an issue_id; rows with no issue are the unbound pool",
	}
}

func issueIDs(issues []moduleIssue) []string {
	ids := make([]string, 0, len(issues))
	for _, issue := range issues {
		ids = append(ids, issue.ID)
	}
	return ids
}

func orUnknown(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unknown (all tabs)"
	}
	return value
}
