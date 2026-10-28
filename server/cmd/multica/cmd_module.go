package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 功能模块（project_module）是「项目 → 功能模块 → 原型图」这条链的中间层。
// 模块本身没有独立的原型接口可依赖（模块级原型端点受 FF_MODULE_SPEC_CENTER
// 门控），真实数据挂在模块下的需求上：模块 → issues → 每个 issue 的
// prototype version → html_path。这三跳都在下面封装掉，调用方（尤其是 chat
// 里的 agent）不需要再猜 URL、也不再需要自己拼原型文件的绝对路径。
var moduleCmd = &cobra.Command{
	Use:   "module",
	Short: "Work with project feature modules and their prototypes",
	Long: `Feature modules group a project's requirements (e.g. "图谱浏览页").

Reading a module's prototype is always the same three hops: module -> its
requirements -> each requirement's prototype versions -> the HTML file on disk.
These commands do that for you instead of leaving you to guess API paths or to
re-derive absolute file paths by hand:

  multica module list --project <project>
  multica module get <module>                # module + its requirements
  multica module create <project> --name <n> [--color <c>] [--graph-node <id>]
  multica module update <module> [--name <n>] [--color <c>] [--graph-node <id>]
  multica module delete <module> --yes
  multica module prototype list <module>     # every version + whether the file exists
  multica module prototype read <module>     # absolute path of the live version`,
}

var moduleListCmd = &cobra.Command{
	Use:   "list [project]",
	Short: "List feature modules (all projects, or one project)",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runModuleList,
}

var moduleGetCmd = &cobra.Command{
	Use:   "get <module>",
	Short: "Get a module with its requirements and prototype versions",
	Args:  exactArgs(1),
	RunE:  runModuleGet,
}

var moduleCreateCmd = &cobra.Command{
	Use:   "create <project>",
	Short: "Create a feature module",
	Args:  exactArgs(1),
	RunE:  runModuleCreate,
}

var moduleUpdateCmd = &cobra.Command{
	Use:   "update <module>",
	Short: "Rename, recolor or rebind a module to a graph node",
	Long: `Only the flags you pass are sent; the rest keep their current value.

  --graph-node ""   unbind the module from its graph node

DELIBERATE: --graph-node rewires which data-model module this feature module
maps to, so it changes what the module TAB reports. Read the graph first
(multica graph modules <project>) and state the change before applying it.`,
	Args: exactArgs(1),
	RunE: runModuleUpdate,
}

var moduleDeleteCmd = &cobra.Command{
	Use:   "delete <module>",
	Short: "Delete a module (requirements fall back to \"no module\"; needs --yes)",
	Long: `Deleting a module does not delete its requirements: the FK is ON DELETE SET
NULL, so they become module-less and leave any cross-module lock. Prototypes
and archive documents are untouched.`,
	Args: exactArgs(1),
	RunE: runModuleDelete,
}

var modulePrototypeCmd = &cobra.Command{
	Use:   "prototype",
	Short: "List or read the prototypes produced for a module",
}

var modulePrototypeListCmd = &cobra.Command{
	Use:   "list <module>",
	Short: "List prototype versions aggregated over the module's requirements",
	Args:  exactArgs(1),
	RunE:  runModulePrototypeList,
}

var modulePrototypeReadCmd = &cobra.Command{
	Use:   "read <module>",
	Short: "Resolve the live prototype of a module to an absolute file path",
	Long: `Resolve the prototype HTML of a module to an absolute path on this machine.

Without --version the confirmed version is preferred, then the newest one.
Pass --raw to print the file content instead of the path.`,
	Args: exactArgs(1),
	RunE: runModulePrototypeRead,
}

func init() {
	moduleListCmd.Flags().String("project", "", "Scope the listing to one project")
	moduleListCmd.Flags().String("output", "table", "Output format: table or json")
	moduleListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")

	moduleGetCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleGetCmd.Flags().String("output", "table", "Output format: table or json")
	moduleGetCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")

	modulePrototypeListCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeListCmd.Flags().String("output", "table", "Output format: table or json")
	modulePrototypeListCmd.Flags().Bool("full-id", false, "Show full UUIDs in table output")

	modulePrototypeReadCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeReadCmd.Flags().Int("version", 0, "Prototype version to read (default: confirmed, else newest)")
	modulePrototypeReadCmd.Flags().Bool("raw", false, "Print the prototype HTML instead of its path")
	modulePrototypeReadCmd.Flags().Bool("json", false, "Output the resolution result as JSON")

	moduleCreateCmd.Flags().String("name", "", "Module name (required, unique per project)")
	moduleCreateCmd.Flags().String("color", "", "Display color (hex, optional)")
	moduleCreateCmd.Flags().String("graph-node", "", "Graph node id to bind at creation")
	moduleCreateCmd.Flags().String("output", "json", "Output format: table or json")

	moduleUpdateCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleUpdateCmd.Flags().String("name", "", "New name")
	moduleUpdateCmd.Flags().String("color", "", "New color (hex)")
	moduleUpdateCmd.Flags().String("graph-node", "", "Graph node id to bind; pass an empty string to unbind")
	moduleUpdateCmd.Flags().String("output", "json", "Output format: table or json")

	moduleDeleteCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleDeleteCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(moduleDeleteCmd)

	modulePrototypeCmd.AddCommand(modulePrototypeListCmd)
	modulePrototypeCmd.AddCommand(modulePrototypeReadCmd)
	moduleCmd.AddCommand(moduleListCmd)
	moduleCmd.AddCommand(moduleGetCmd)
	moduleCmd.AddCommand(moduleCreateCmd)
	moduleCmd.AddCommand(moduleUpdateCmd)
	moduleCmd.AddCommand(moduleDeleteCmd)
	moduleCmd.AddCommand(modulePrototypeCmd)
	rootCmd.AddCommand(moduleCmd)
}

// ── 服务端读取 ───────────────────────────────────────────────────────────────

type moduleProject struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type moduleRecord struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	GraphNodeID string `json:"graph_node_id"`
	TaskCount   int    `json:"task_count"`
}

type moduleIssue struct {
	ID         string `json:"id"`
	Identifier string `json:"identifier"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	Number     int    `json:"number"`
}

func (i moduleIssue) label() string {
	if i.Identifier != "" {
		return i.Identifier
	}
	return i.ID
}

type modulePrototypeVersion struct {
	ID        string `json:"id"`
	IssueID   string `json:"issue_id"`
	Version   int32  `json:"version"`
	Status    string `json:"status"`
	HtmlPath  string `json:"html_path"`
	CreatedAt string `json:"created_at"`

	// Filled in locally: the issue the version was registered through.
	IssueKey   string `json:"issue_key,omitempty"`
	IssueTitle string `json:"issue_title,omitempty"`
}

func fetchModuleProjects(ctx context.Context, client *cli.APIClient) ([]moduleProject, error) {
	if client.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace_id is required to list modules across projects; run `multica config set workspace_id <id>`, pass --workspace-id, or scope the command with --project")
	}
	params := url.Values{"workspace_id": {client.WorkspaceID}}
	var result struct {
		Projects []moduleProject `json:"projects"`
	}
	if err := client.GetJSON(ctx, "/api/projects?"+params.Encode(), &result); err != nil {
		return nil, err
	}
	return result.Projects, nil
}

func fetchProjectModules(ctx context.Context, client *cli.APIClient, projectID string) ([]moduleRecord, error) {
	var result struct {
		Modules []moduleRecord `json:"modules"`
	}
	path := "/api/projects/" + url.PathEscape(projectID) + "/modules"
	if err := client.GetJSON(ctx, path, &result); err != nil {
		return nil, err
	}
	for i := range result.Modules {
		if result.Modules[i].ProjectID == "" {
			result.Modules[i].ProjectID = projectID
		}
	}
	return result.Modules, nil
}

// loadModuleCandidates returns every module the resolver may match, plus a
// project id → project lookup for display. A --project scope short-circuits the
// workspace-wide fan-out, which is the common case for chat callers that
// already have the project id in hand.
func loadModuleCandidates(ctx context.Context, client *cli.APIClient, projectArg string) ([]moduleRecord, map[string]moduleProject, error) {
	if strings.TrimSpace(projectArg) != "" {
		ref, err := resolveProjectID(ctx, client, projectArg)
		if err != nil {
			return nil, nil, fmt.Errorf("resolve project: %w", err)
		}
		modules, err := fetchProjectModules(ctx, client, ref.ID)
		if err != nil {
			return nil, nil, fmt.Errorf("list modules of project %q: %w", ref.Display, err)
		}
		return modules, map[string]moduleProject{ref.ID: {ID: ref.ID, Title: ref.Display}}, nil
	}

	projects, err := fetchModuleProjects(ctx, client)
	if err != nil {
		return nil, nil, fmt.Errorf("list projects: %w", err)
	}
	byID := make(map[string]moduleProject, len(projects))
	var modules []moduleRecord
	for _, p := range projects {
		byID[p.ID] = p
		scoped, err := fetchProjectModules(ctx, client, p.ID)
		if err != nil {
			return nil, nil, fmt.Errorf("list modules of project %q: %w", p.Title, err)
		}
		modules = append(modules, scoped...)
	}
	return modules, byID, nil
}

// fetchModuleIssues is the bridge from a module to its requirements. Without
// module_id filtering on /api/issues the caller had to page the whole project
// and filter client-side, which silently truncates once the project grows.
func fetchModuleIssues(ctx context.Context, client *cli.APIClient, moduleID string) ([]moduleIssue, error) {
	params := url.Values{"module_id": {moduleID}, "limit": {"200"}}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	var result struct {
		Issues []moduleIssue `json:"issues"`
		Total  int           `json:"total"`
	}
	if err := client.GetJSON(ctx, "/api/issues?"+params.Encode(), &result); err != nil {
		return nil, err
	}
	return result.Issues, nil
}

func fetchModulePrototypeVersions(ctx context.Context, client *cli.APIClient, issues []moduleIssue) ([]modulePrototypeVersion, error) {
	seen := map[string]bool{}
	var out []modulePrototypeVersion
	for _, issue := range issues {
		var result struct {
			Versions []modulePrototypeVersion `json:"versions"`
		}
		path := "/api/issues/" + url.PathEscape(issue.ID) + "/prototypes"
		if err := client.GetJSON(ctx, path, &result); err != nil {
			return nil, fmt.Errorf("list prototypes of %s: %w", issue.label(), err)
		}
		for _, v := range result.Versions {
			if v.ID != "" && seen[v.ID] {
				continue
			}
			seen[v.ID] = true
			v.IssueKey = issue.label()
			v.IssueTitle = issue.Title
			out = append(out, v)
		}
	}
	// 版本号从新到旧，同版本按需求 key 聚在一起，方便「这一版是哪个需求产出的」。
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Version != out[j].Version {
			return out[i].Version > out[j].Version
		}
		return out[i].IssueKey < out[j].IssueKey
	})
	return out, nil
}

// ── 模块解析 ─────────────────────────────────────────────────────────────────

// resolveModule accepts a full UUID, a UUID prefix, or the module name. Names
// matter here: in chat people (and agents quoting them) say "读取图谱浏览页的
// 原型图" far more often than they paste a UUID.
func resolveModule(ctx context.Context, client *cli.APIClient, projectArg, input string) (moduleRecord, moduleProject, error) {
	modules, projects, err := loadModuleCandidates(ctx, client, projectArg)
	if err != nil {
		return moduleRecord{}, moduleProject{}, err
	}
	if len(modules) == 0 {
		return moduleRecord{}, moduleProject{}, fmt.Errorf("no modules found%s", scopeSuffix(projectArg))
	}

	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return moduleRecord{}, moduleProject{}, fmt.Errorf("module is required")
	}

	if _, err := normalizeUUIDPrefix(trimmed); err == nil {
		prefix := compactUUID(trimmed)
		var matches []moduleRecord
		for _, m := range modules {
			if strings.HasPrefix(compactUUID(m.ID), prefix) {
				matches = append(matches, m)
			}
		}
		switch len(matches) {
		case 1:
			return matches[0], projects[matches[0].ProjectID], nil
		case 0:
			return moduleRecord{}, moduleProject{}, fmt.Errorf("no module found matching id prefix %q; run `multica module list` to see the available modules", input)
		default:
			return moduleRecord{}, moduleProject{}, ambiguousModuleError("id prefix", input, matches, projects)
		}
	}

	lower := strings.ToLower(trimmed)
	var exact, partial []moduleRecord
	for _, m := range modules {
		name := strings.ToLower(m.Name)
		switch {
		case name == lower:
			exact = append(exact, m)
		case strings.Contains(name, lower):
			partial = append(partial, m)
		}
	}
	switch len(exact) {
	case 1:
		return exact[0], projects[exact[0].ProjectID], nil
	case 0:
		switch len(partial) {
		case 1:
			return partial[0], projects[partial[0].ProjectID], nil
		case 0:
			return moduleRecord{}, moduleProject{}, fmt.Errorf("no module named %q; run `multica module list` to see the available modules", input)
		default:
			return moduleRecord{}, moduleProject{}, ambiguousModuleError("name", input, partial, projects)
		}
	default:
		return moduleRecord{}, moduleProject{}, ambiguousModuleError("name", input, exact, projects)
	}
}

func ambiguousModuleError(kind, input string, matches []moduleRecord, projects map[string]moduleProject) error {
	sort.Slice(matches, func(i, j int) bool { return matches[i].ID < matches[j].ID })
	lines := make([]string, 0, len(matches))
	for _, m := range matches {
		title := projects[m.ProjectID].Title
		if title == "" {
			title = m.ProjectID
		}
		lines = append(lines, fmt.Sprintf("  %s  %s  (project: %s)", m.ID, m.Name, title))
	}
	return fmt.Errorf("ambiguous module %s %q; matches:\n%s\nPass --project to narrow the search, or use the full UUID", kind, input, strings.Join(lines, "\n"))
}

func scopeSuffix(projectArg string) string {
	if strings.TrimSpace(projectArg) == "" {
		return " in this workspace; check that you are targeting the right workspace"
	}
	return " in project " + projectArg
}

// ── 命令实现 ─────────────────────────────────────────────────────────────────

func runModuleList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	projectArg, _ := cmd.Flags().GetString("project")
	if len(args) == 1 {
		projectArg = args[0]
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	modules, projects, err := loadModuleCandidates(ctx, client, projectArg)
	if err != nil {
		return err
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, modules)
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	headers := []string{"ID", "MODULE", "PROJECT", "ISSUES", "GRAPH NODE"}
	rows := make([][]string, 0, len(modules))
	for _, m := range modules {
		title := projects[m.ProjectID].Title
		if title == "" {
			title = displayID(m.ProjectID, fullID)
		}
		graph := m.GraphNodeID
		if graph == "" {
			graph = "-"
		}
		rows = append(rows, []string{
			displayID(m.ID, fullID),
			m.Name,
			title,
			fmt.Sprintf("%d", m.TaskCount),
			graph,
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runModuleCreate(cmd *cobra.Command, args []string) error {
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
	if cmd.Flags().Changed("color") {
		body["color"] = flagOr(cmd, "color", "")
	}
	if cmd.Flags().Changed("graph-node") {
		body["graph_node_id"] = flagOr(cmd, "graph-node", "")
	}

	var created map[string]any
	path := "/api/projects/" + url.PathEscape(projectRef.ID) + "/modules"
	if err := client.PostJSON(ctx, path, body, &created); err != nil {
		return fmt.Errorf("create module: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), created)
}

func runModuleUpdate(cmd *cobra.Command, args []string) error {
	if !cmd.Flags().Changed("name") && !cmd.Flags().Changed("color") && !cmd.Flags().Changed("graph-node") {
		return fmt.Errorf("nothing to update: pass at least one of --name, --color, --graph-node")
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	module, _, err := resolveModule(ctx, client, flagOr(cmd, "project", ""), args[0])
	if err != nil {
		return err
	}
	body := map[string]any{}
	if cmd.Flags().Changed("name") {
		name := flagOr(cmd, "name", "")
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("--name cannot be empty")
		}
		body["name"] = name
	}
	if cmd.Flags().Changed("color") {
		body["color"] = flagOr(cmd, "color", "")
	}
	if cmd.Flags().Changed("graph-node") {
		body["graph_node_id"] = flagOr(cmd, "graph-node", "")
	}

	var updated map[string]any
	path := "/api/projects/" + url.PathEscape(module.ProjectID) + "/modules/" + url.PathEscape(module.ID)
	if err := client.PatchJSON(ctx, path, body, &updated); err != nil {
		return fmt.Errorf("update module: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), updated)
}

func runModuleDelete(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	module, _, err := resolveModule(ctx, client, flagOr(cmd, "project", ""), args[0])
	if err != nil {
		return err
	}
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Delete feature module %q (%s) of project %s. Its %d requirement(s) become module-less; the module itself cannot be restored.",
		module.Name, module.ID, module.ProjectID, module.TaskCount)); err != nil {
		return err
	}

	path := "/api/projects/" + url.PathEscape(module.ProjectID) + "/modules/" + url.PathEscape(module.ID)
	if err := client.DeleteJSON(ctx, path); err != nil {
		return fmt.Errorf("delete module: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
		"deleted":   true,
		"module_id": module.ID,
		"name":      module.Name,
		"project":   module.ProjectID,
	})
}

func runModuleGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	projectArg, _ := cmd.Flags().GetString("project")

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	module, project, err := resolveModule(ctx, client, projectArg, args[0])
	if err != nil {
		return err
	}
	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	versions, err := fetchModulePrototypeVersions(ctx, client, issues)
	if err != nil {
		return err
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"module":     module,
			"issues":     issues,
			"prototypes": versions,
		})
	}

	fullID, _ := cmd.Flags().GetBool("full-id")
	fmt.Printf("Module:  %s\n", module.Name)
	fmt.Printf("ID:      %s\n", displayID(module.ID, fullID))
	fmt.Printf("Project: %s (%s)\n", project.Title, displayID(module.ProjectID, fullID))
	if module.GraphNodeID != "" {
		fmt.Printf("Graph:   %s\n", module.GraphNodeID)
	}
	if latest := pickModulePrototypeVersion(versions, 0); latest != nil {
		fmt.Printf("Prototype: v%d (%s)\n", latest.Version, statusOrUnknown(latest.Status))
	} else {
		fmt.Printf("Prototype: none registered yet\n")
	}
	fmt.Println()

	fmt.Println("Requirements:")
	if len(issues) == 0 {
		fmt.Println("  (none — this module has no requirements yet)")
	} else {
		headers := []string{"ID", "STATUS", "TITLE"}
		rows := make([][]string, 0, len(issues))
		for _, issue := range issues {
			rows = append(rows, []string{issue.label(), issue.Status, issue.Title})
		}
		cli.PrintTable(os.Stdout, headers, rows)
	}

	fmt.Println()
	moduleRef := displayID(module.ID, true)
	fmt.Fprintf(os.Stderr, "Next:\n  multica module prototype list %s\n  multica module prototype read %s\n", moduleRef, moduleRef)
	return nil
}

func runModulePrototypeList(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	projectArg, _ := cmd.Flags().GetString("project")

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	module, _, err := resolveModule(ctx, client, projectArg, args[0])
	if err != nil {
		return err
	}
	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	versions, err := fetchModulePrototypeVersions(ctx, client, issues)
	if err != nil {
		return err
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"module":   map[string]string{"id": module.ID, "name": module.Name, "project_id": module.ProjectID},
			"versions": versions,
		})
	}

	if len(versions) == 0 {
		fmt.Printf("Module %q has no prototype versions yet.\n", module.Name)
		if len(issues) > 0 {
			fmt.Fprintf(os.Stderr, "Requirements of this module: %s\nRegister one with `multica requirement prototype register <issue> --html-path <path>`.\n", joinIssueKeys(issues))
		}
		return nil
	}

	headers := []string{"VERSION", "STATUS", "FILE", "REQUIREMENT", "PATH"}
	rows := make([][]string, 0, len(versions))
	for _, v := range versions {
		rows = append(rows, []string{
			fmt.Sprintf("v%d", v.Version),
			statusOrUnknown(v.Status),
			modulePrototypeFileState(v.HtmlPath),
			v.IssueKey,
			v.HtmlPath,
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)

	fmt.Fprintf(os.Stderr, "Next:\n  multica module prototype read %s --version %d\n", displayID(module.ID, true), versions[0].Version)
	return nil
}

func runModulePrototypeRead(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	projectArg, _ := cmd.Flags().GetString("project")
	versionFlag, _ := cmd.Flags().GetInt("version")
	rawOutput, _ := cmd.Flags().GetBool("raw")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	module, _, err := resolveModule(ctx, client, projectArg, args[0])
	if err != nil {
		return err
	}
	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	versions, err := fetchModulePrototypeVersions(ctx, client, issues)
	if err != nil {
		return err
	}

	target := pickModulePrototypeVersion(versions, versionFlag)
	if target == nil {
		if len(versions) == 0 {
			return fmt.Errorf("module %q has no prototype versions yet; register one with `multica requirement prototype register <issue> --html-path <path>`", module.Name)
		}
		return fmt.Errorf("module %q has no prototype version v%d; available: %s", module.Name, versionFlag, joinVersionList(versions))
	}

	absPath, candidates := resolveModulePrototypePath(target.HtmlPath)
	if absPath == "" || !fileExists(absPath) {
		return fmt.Errorf(
			"prototype file for module %q v%d does not exist on this machine.\n  html_path: %s\ntried:\n  %s\n"+
				"The path is probably stale (superseded versions keep their original path). "+
				"Run `multica module prototype list %s` to see which version still has a file.",
			module.Name, target.Version, target.HtmlPath,
			strings.Join(candidates, "\n  "),
			displayID(module.ID, true),
		)
	}

	info, statErr := os.Stat(absPath)
	if statErr != nil {
		return fmt.Errorf("stat prototype file %s: %w", absPath, statErr)
	}

	if rawOutput {
		data, readErr := os.ReadFile(absPath)
		if readErr != nil {
			return fmt.Errorf("read prototype file %s: %w", absPath, readErr)
		}
		_, writeErr := os.Stdout.Write(data)
		if writeErr != nil {
			return writeErr
		}
		if len(data) > 0 && data[len(data)-1] != '\n' {
			fmt.Println()
		}
		return nil
	}

	if jsonOutput {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"module_id":   module.ID,
			"module_name": module.Name,
			"project_id":  module.ProjectID,
			"version":     target.Version,
			"status":      target.Status,
			"issue":       target.IssueKey,
			"html_path":   target.HtmlPath,
			"file":        absPath,
			"bytes":       info.Size(),
		})
	}

	fmt.Printf("Module:  %s\n", module.Name)
	fmt.Printf("Version: v%d (%s)\n", target.Version, statusOrUnknown(target.Status))
	if target.IssueKey != "" {
		fmt.Printf("From:    %s %s\n", target.IssueKey, target.IssueTitle)
	}
	fmt.Printf("Path:    %s\n", target.HtmlPath)
	fmt.Printf("File:    %s\n", absPath)
	fmt.Printf("Size:    %d bytes\n", info.Size())
	fmt.Fprintf(os.Stderr, "\nRead it with: cat %q\n", absPath)
	return nil
}

// ── 版本与路径解析 ───────────────────────────────────────────────────────────

// pickModulePrototypeVersion returns the requested version, or — when 0 — the
// confirmed one, falling back to the newest. Confirmed wins over "newest
// number" because a newer pending draft is not what the user is talking about
// when they say "这个模块的原型图".
func pickModulePrototypeVersion(versions []modulePrototypeVersion, requested int) *modulePrototypeVersion {
	if len(versions) == 0 {
		return nil
	}
	if requested > 0 {
		for i := range versions {
			if int(versions[i].Version) == requested {
				return &versions[i]
			}
		}
		return nil
	}
	for i := range versions {
		if versions[i].Status == "confirmed" && versions[i].HtmlPath != "" {
			return &versions[i]
		}
	}
	return &versions[0]
}

// modulePrototypeRoots lists the directories html_path may be relative to.
// The archive CLI's own resolution lives behind `multica archive`, so an agent
// holding a raw html_path has no way to turn it into a real file: the two
// observed shapes are `requirements/...` (relative to the archive root) and
// `change_logs/...` (relative to its parent workspace dir).
func modulePrototypeRoots() []string {
	var roots []string
	add := func(p string) {
		if strings.TrimSpace(p) == "" {
			return
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return
		}
		for _, existing := range roots {
			if existing == abs {
				return
			}
		}
		roots = append(roots, abs)
	}

	archiveRoot := os.Getenv("MULTICA_ARCHIVE_ROOT")
	if archiveRoot == "" {
		if home, err := os.UserHomeDir(); err == nil {
			archiveRoot = filepath.Join(home, "Documents", "workspace", "projects_mgmt")
		}
	}
	if archiveRoot != "" {
		add(archiveRoot)
		add(siblingChangeLogsRoot(archiveRoot))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, "Documents", "workspace"))
	}
	if wd, err := os.Getwd(); err == nil {
		add(wd)
	}
	return roots
}

// resolveModulePrototypePath turns a stored html_path into an absolute path,
// returning the first candidate that exists (or all candidates when none do,
// so the caller can show the user what was tried).
func resolveModulePrototypePath(htmlPath string) (string, []string) {
	candidates := modulePrototypePathCandidates(htmlPath)
	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate, candidates
		}
	}
	return "", candidates
}

func modulePrototypePathCandidates(htmlPath string) []string {
	rel := strings.TrimSpace(filepath.ToSlash(htmlPath))
	if rel == "" {
		return nil
	}
	if filepath.IsAbs(htmlPath) {
		return []string{filepath.Clean(htmlPath)}
	}

	subPaths := []string{rel}
	if strings.HasPrefix(rel, "change_logs/") {
		// `change_logs/...` is written relative to the workspace dir that
		// contains both the archive root and change_logs, so joining the
		// archive root (or change_logs itself) with the full path misses.
		subPaths = append(subPaths, strings.TrimPrefix(rel, "change_logs/"))
	}

	var out []string
	seen := map[string]bool{}
	for _, root := range modulePrototypeRoots() {
		for _, sub := range subPaths {
			abs := filepath.Clean(filepath.Join(root, filepath.FromSlash(sub)))
			// html_path comes from the database, so a `..` segment must not be
			// able to walk the resolver out of the root it is joined against.
			if _, ok := relInside(root, abs); !ok {
				continue
			}
			if seen[abs] {
				continue
			}
			seen[abs] = true
			out = append(out, abs)
		}
	}
	return out
}

func modulePrototypeFileState(htmlPath string) string {
	if strings.TrimSpace(htmlPath) == "" {
		return "no-path"
	}
	if abs, _ := resolveModulePrototypePath(htmlPath); abs != "" {
		return "ok"
	}
	return "missing"
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func statusOrUnknown(status string) string {
	if status == "" {
		return "unknown"
	}
	return status
}

func joinIssueKeys(issues []moduleIssue) string {
	keys := make([]string, 0, len(issues))
	for _, issue := range issues {
		keys = append(keys, issue.label())
	}
	return strings.Join(keys, ", ")
}

func joinVersionList(versions []modulePrototypeVersion) string {
	lines := make([]string, 0, len(versions))
	for _, v := range versions {
		lines = append(lines, fmt.Sprintf("v%d(%s)", v.Version, statusOrUnknown(v.Status)))
	}
	return strings.Join(lines, ", ")
}
