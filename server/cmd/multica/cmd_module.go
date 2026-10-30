package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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
  multica module spec feature add|update|remove <module>   # 功能点单条增删改
  multica module brief patch <module> --base-version <n> --field brief.goal="..."
  multica module prototype list <module>     # every version + whether the file exists
  multica module prototype register <module> --html-path <file>   # 新一版原型
  multica module prototype confirm|update|delete <module> <v>     # 维护某一版
  multica module prototype parse <module>     # 抽 data-fp 锚点，reconcile 才有数
  multica module prototype diff <module> --from v --to v          # 版本对比总结
  multica module brief versions|diff <module> # 说明版本记录 / 字段级对比
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

var moduleSpecCmd = &cobra.Command{
	Use:   "spec",
	Short: "Read or write the module capability spec (module_spec/v1)",
	Long: `The spec is a module's structured feature list: {schema, summary?, features[]}
with code / title / kind (core|edge) / priority per feature.

  draft    stores the spec without bumping spec_version (a pre-publish workspace)
  publish  commits it: spec_version +1, feature projection rebuilt, change event recorded

Both endpoints sit behind FF_MODULE_SPEC_CENTER on the server; with the flag off
they answer 404 by design (the module CRUD commands keep working either way).`,
}

var moduleSpecGetCmd = &cobra.Command{
	Use:   "get <module>",
	Short: "Print the spec, its version and the canonical prototype pointer",
	Args:  exactArgs(1),
	RunE:  runModuleSpecGet,
}

var moduleSpecDraftCmd = &cobra.Command{
	Use:   "draft <module>",
	Short: "Store a spec draft (spec_version unchanged)",
	Args:  exactArgs(1),
	RunE:  runModuleSpecDraft,
}

var moduleSpecPublishCmd = &cobra.Command{
	Use:   "publish <module>",
	Short: "Publish the spec as a new version (spec_version +1)",
	Long: `Publishing is the only way a spec becomes the module's truth. Pass
--expected-version to make the write conditional: if another writer already
bumped spec_version the server answers 409 and nothing is written.`,
	Args: exactArgs(1),
	RunE: runModuleSpecPublish,
}

var moduleReconcileCmd = &cobra.Command{
	Use:   "reconcile <module>",
	Short: "Four-state matrix of spec features × prototype anchors",
	Args:  exactArgs(1),
	RunE:  runModuleReconcile,
}
var moduleCoverageCmd = &cobra.Command{
	Use:   "coverage <module>",
	Short: "Coverage KPI (same numbers as the module list badge)",
	Args:  exactArgs(1),
	RunE:  runModuleCoverage,
}

// 发布两段式：agent 只能产 draft 计划，权威原型指针的移动必须人 apply。
var modulePlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Prototype publish plans (draft → human apply)",
	Long: `A plan snapshots “candidate version + new spec + feature decisions” without
moving anything. Only plan apply promotes the candidate: it moves the canonical
prototype pointer, bumps spec_version and rebuilds the feature projection in one
transaction.

  multica module plan create <module> --candidate-version <n> [--spec <json>|--file <path>]
  multica module plan get <module> <plan-id>
  multica module plan apply <module> <plan-id> --yes

Draft plans expire after 24h; applying one twice answers 409 plan_already_applied.`,
}

var modulePlanCreateCmd = &cobra.Command{
	Use:   "create <module>",
	Short: "Snapshot a publish plan (nothing is promoted)",
	Args:  exactArgs(1),
	RunE:  runModulePlanCreate,
}

var modulePlanGetCmd = &cobra.Command{
	Use:   "get <module> <plan-id>",
	Short: "Read one plan's status and snapshot",
	Args:  exactArgs(2),
	RunE:  runModulePlanGet,
}

var modulePlanApplyCmd = &cobra.Command{
	Use:   "apply <module> <plan-id>",
	Short: "Promote the plan: canonical version + spec version + projection (needs --yes)",
	Args:  exactArgs(2),
	RunE:  runModulePlanApply,
}

// 右栏「功能点详解」的读写面：模块说明 + 功能点四段详情 + 成对发布。
var moduleBriefCmd = &cobra.Command{
	Use:   "brief",
	Short: "Read or patch the module brief (the right pane's 说明)",
	Long: `Every patch appends one brief version; nothing is overwritten. Field keys are
brief.* (模块说明) or fp.<code>.* (功能点四段：desc / loc / req / interaction /
deps / acceptance). System fields (module.*, fp.code / since / removed) are
read-only and answer 422.

  multica module brief get <module>
  multica module brief patch <module> --base-version <n> --field brief.goal="..."
                   [--field fp.FP-01.desc="..."] [--note "..."] [--source agent]

--base-version is optimistic locking: if someone else patched first the server
answers 409 base_stale and prints the current version; re-run with that number.`,
}

var moduleBriefGetCmd = &cobra.Command{
	Use:   "get <module>",
	Short: "Print the workspace: field definitions, brief fields, feature details, versions",
	Args:  exactArgs(1),
	RunE:  runModuleBriefGet,
}

var moduleBriefPatchCmd = &cobra.Command{
	Use:   "patch <module>",
	Short: "Append a brief version with one or more field values",
	Args:  exactArgs(1),
	RunE:  runModuleBriefPatch,
}

var moduleReleaseCmd = &cobra.Command{
	Use:   "release",
	Short: "Paired releases: brief version × prototype version",
	Long: `A release pins one brief version to one prototype version and is the only
place the module's two pointers move. Releasing is a human action; rollback
never rewrites history — it copies the old fields into a brand new version.

  multica module release list <module>
  multica module release publish <module> [--brief-version <n>] [--prototype-version <m>] --yes
  multica module release rollback <module> <release-version> --yes`,
}

var moduleReleaseListCmd = &cobra.Command{
	Use:   "list <module>",
	Short: "List paired releases and the current pointers",
	Args:  exactArgs(1),
	RunE:  runModuleReleaseList,
}

var moduleReleasePublishCmd = &cobra.Command{
	Use:   "publish <module>",
	Short: "Publish brief vN × prototype vM (needs --yes)",
	Args:  exactArgs(1),
	RunE:  runModuleReleasePublish,
}

var moduleReleaseRollbackCmd = &cobra.Command{
	Use:   "rollback <module> <release-version>",
	Short: "Re-release an old pair as a new version (needs --yes)",
	Args:  exactArgs(2),
	RunE:  runModuleReleaseRollback,
}

var modulePrototypeCmd = &cobra.Command{
	Use:   "prototype",
	Short: "List, read, register, maintain, parse or diff a module's prototypes",
}

var modulePrototypeListCmd = &cobra.Command{
	Use:   "list <module>",
	Short: "List prototype versions aggregated over the module's requirements",
	Args:  exactArgs(1),
	RunE:  runModulePrototypeList,
}

var modulePrototypeReadCmd = &cobra.Command{
	Use:   "read <module>",
	Short: "Read the live prototype of a module (local file, else the server copy)",
	Long: `Resolve the prototype HTML of a module.

Without --version the confirmed version is preferred, then the newest one.
The HTML is looked up on this machine first (html_path inside the archive root /
change_logs / workspace), then — for prototypes registered through the UI, whose
bytes live in attachment storage and whose html_path is only a virtual path —
fetched from the server. Pass --raw to print the HTML instead of the coordinates.`,
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
	modulePrototypeReadCmd.Flags().Bool("json", false, "Output the resolution result as JSON (source: local|server)")
	modulePrototypeReadCmd.Flags().String("out", "", "Write the HTML to this path so it can be edited and uploaded back")

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

	moduleSpecGetCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleSpecGetCmd.Flags().String("output", "json", "Output format: table or json")
	moduleSpecDraftCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleSpecDraftCmd.Flags().String("spec", "", "Inline spec JSON (module_spec/v1)")
	moduleSpecDraftCmd.Flags().String("file", "", "Read the spec JSON from a file; use - for stdin")
	moduleSpecDraftCmd.Flags().String("output", "json", "Output format: table or json")
	moduleSpecPublishCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleSpecPublishCmd.Flags().String("spec", "", "Inline spec JSON (module_spec/v1)")
	moduleSpecPublishCmd.Flags().String("file", "", "Read the spec JSON from a file; use - for stdin")
	moduleSpecPublishCmd.Flags().Int("expected-version", 0, "Only publish when the current spec_version equals this value (409 otherwise)")
	moduleSpecPublishCmd.Flags().String("output", "json", "Output format: table or json")
	moduleReconcileCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleReconcileCmd.Flags().Int("version", 0, "Reconcile against one prototype version (default: the canonical one)")
	moduleReconcileCmd.Flags().String("output", "json", "Output format: table or json")
	moduleCoverageCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleCoverageCmd.Flags().String("output", "json", "Output format: table or json")
	modulePlanCreateCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePlanCreateCmd.Flags().Int("candidate-version", 0, "Prototype version to promote (required)")
	modulePlanCreateCmd.Flags().String("spec", "", "Inline new spec JSON (default: keep the published spec)")
	modulePlanCreateCmd.Flags().String("file", "", "Read the new spec JSON from a file; use - for stdin")
	modulePlanCreateCmd.Flags().String("decisions", "", "Inline feature decisions JSON (code -> decision)")
	modulePlanCreateCmd.Flags().String("output", "json", "Output format: table or json")
	modulePlanGetCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePlanGetCmd.Flags().String("output", "json", "Output format: table or json")
	modulePlanApplyCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePlanApplyCmd.Flags().String("output", "json", "Output format: table or json")
	moduleBriefGetCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleBriefGetCmd.Flags().String("output", "json", "Output format: table or json")
	moduleBriefPatchCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleBriefPatchCmd.Flags().Int("base-version", -1, "Current brief version (required; 0 for a module that was never patched)")
	moduleBriefPatchCmd.Flags().StringArray("field", nil, "key=value; repeatable (brief.goal=\"...\", fp.FP-01.desc=\"...\")")
	moduleBriefPatchCmd.Flags().String("fields", "", "Inline JSON object of key -> value (instead of --field)")
	moduleBriefPatchCmd.Flags().String("note", "", "One-line summary stored in the version history")
	moduleBriefPatchCmd.Flags().String("source", "", "manual | agent | mcp | extract (default manual)")
	moduleBriefPatchCmd.Flags().String("output", "json", "Output format: table or json")
	moduleReleaseListCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleReleaseListCmd.Flags().String("output", "json", "Output format: table or json")
	moduleReleasePublishCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleReleasePublishCmd.Flags().Int("brief-version", 0, "Brief version to release (default: the current one)")
	moduleReleasePublishCmd.Flags().Int("prototype-version", 0, "Prototype version to pair with it (default: the canonical one)")
	moduleReleasePublishCmd.Flags().String("note", "", "Release note")
	moduleReleasePublishCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(moduleReleasePublishCmd)
	moduleReleaseRollbackCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleReleaseRollbackCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(moduleReleaseRollbackCmd)
	addDestructiveFlags(modulePlanApplyCmd)

	modulePrototypeCmd.AddCommand(modulePrototypeListCmd)
	modulePrototypeCmd.AddCommand(modulePrototypeReadCmd)
	moduleSpecCmd.AddCommand(moduleSpecGetCmd)
	moduleSpecCmd.AddCommand(moduleSpecDraftCmd)
	moduleSpecCmd.AddCommand(moduleSpecPublishCmd)
	modulePlanCmd.AddCommand(modulePlanCreateCmd)
	modulePlanCmd.AddCommand(modulePlanGetCmd)
	modulePlanCmd.AddCommand(modulePlanApplyCmd)
	moduleBriefCmd.AddCommand(moduleBriefGetCmd)
	moduleBriefCmd.AddCommand(moduleBriefPatchCmd)
	moduleReleaseCmd.AddCommand(moduleReleaseListCmd)
	moduleReleaseCmd.AddCommand(moduleReleasePublishCmd)
	moduleReleaseCmd.AddCommand(moduleReleaseRollbackCmd)
	moduleCmd.AddCommand(moduleListCmd)
	moduleCmd.AddCommand(moduleGetCmd)
	moduleCmd.AddCommand(moduleCreateCmd)
	moduleCmd.AddCommand(moduleUpdateCmd)
	moduleCmd.AddCommand(moduleDeleteCmd)
	moduleCmd.AddCommand(moduleSpecCmd)
	moduleCmd.AddCommand(modulePlanCmd)
	moduleCmd.AddCommand(moduleBriefCmd)
	moduleCmd.AddCommand(moduleReleaseCmd)
	moduleCmd.AddCommand(moduleReconcileCmd)
	moduleCmd.AddCommand(moduleCoverageCmd)
	moduleCmd.AddCommand(moduleContextCmd)
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
	// FeatureCode 这条 issue 绑定的功能点（空 = 只到模块粒度）。把归属链的
	// 最后一跳也吐出来，agent 才能看出哪些功能点还没人干、哪些被重复拆了。
	FeatureCode string `json:"feature_code,omitempty"`
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
	Prompt    string `json:"prompt"`
	CreatedAt string `json:"created_at"`

	// Filled in locally: who owns the row (module = registered on the module,
	// requirement = produced by one of its requirements) and which issue it was
	// registered through.
	Owner      string `json:"owner,omitempty"`
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

// ── 模块能力规格：spec / reconcile / coverage ────────────────────────────
//
// 这四条命令与界面的「原型图」子 TAB 同源：同一组 /spec、/prototype-reconcile、
// /coverage 端点，因此 agent 改完规格后，人看到的版本号、功能点与覆盖率立即一致。

func moduleScopedPath(module moduleRecord, suffix string) string {
	return "/api/projects/" + url.PathEscape(module.ProjectID) +
		"/modules/" + url.PathEscape(module.ID) + suffix
}

// moduleGateHint 把 flag 门控导致的 404 翻译成可执行的提示。
func moduleGateHint(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "404") {
		return fmt.Errorf("%w (spec / prototype / reconcile endpoints are gated by FF_MODULE_SPEC_CENTER; set it to true and restart the API)", err)
	}
	return err
}

func runModuleSpecGet(cmd *cobra.Command, args []string) error {
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
	var out map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/spec"), &out)); err != nil {
		return fmt.Errorf("get module spec: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleSpecDraft(cmd *cobra.Command, args []string) error {
	spec, err := moduleSpecPayload(cmd)
	if err != nil {
		return err
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
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/spec/draft"), map[string]any{"spec": spec}, &out)); err != nil {
		return fmt.Errorf("draft module spec: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleSpecPublish(cmd *cobra.Command, args []string) error {
	spec, err := moduleSpecPayload(cmd)
	if err != nil {
		return err
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
	body := map[string]any{"spec": spec}
	if cmd.Flags().Changed("expected-version") {
		expected, _ := cmd.Flags().GetInt("expected-version")
		body["expected_version"] = expected
	}
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/spec/publish"), body, &out)); err != nil {
		return fmt.Errorf("publish module spec: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleReconcile(cmd *cobra.Command, args []string) error {
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
	path := moduleScopedPath(module, "/prototype-reconcile")
	if version, _ := cmd.Flags().GetInt("version"); version > 0 {
		path += fmt.Sprintf("?version=%d", version)
	}
	var out map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, path, &out)); err != nil {
		return fmt.Errorf("reconcile module: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleCoverage(cmd *cobra.Command, args []string) error {
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
	var out map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/coverage"), &out)); err != nil {
		return fmt.Errorf("module coverage: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModulePlanCreate(cmd *cobra.Command, args []string) error {
	candidate, _ := cmd.Flags().GetInt("candidate-version")
	if candidate <= 0 {
		return fmt.Errorf("pass --candidate-version <n> (the prototype version to promote; see `multica module prototype list`)")
	}
	body := map[string]any{"candidate_version": candidate}
	if strings.TrimSpace(flagOr(cmd, "spec", "")) != "" || strings.TrimSpace(flagOr(cmd, "file", "")) != "" {
		spec, err := moduleSpecPayload(cmd)
		if err != nil {
			return err
		}
		body["new_spec"] = spec
	}
	if decisions, err := moduleOptionalJSON(flagOr(cmd, "decisions", ""), "decisions"); err != nil {
		return err
	} else if decisions != nil {
		body["decisions"] = decisions
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
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/prototype-plans"), body, &out)); err != nil {
		return fmt.Errorf("create prototype plan: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModulePlanGet(cmd *cobra.Command, args []string) error {
	planID, err := modulePlanID(args[1])
	if err != nil {
		return err
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
	var out map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/prototype-plans/"+planID), &out)); err != nil {
		return fmt.Errorf("get prototype plan: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModulePlanApply(cmd *cobra.Command, args []string) error {
	planID, err := modulePlanID(args[1])
	if err != nil {
		return err
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
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Apply prototype plan %s to module %q (%s): the canonical prototype pointer moves, spec_version is bumped and the feature projection is rebuilt.",
		planID, module.Name, module.ID)); err != nil {
		return err
	}
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/prototype-plans/"+planID+"/apply"), nil, &out)); err != nil {
		return fmt.Errorf("apply prototype plan: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

// ── 右栏工作区：brief / release ──────────────────────────────────────

func runModuleBriefGet(cmd *cobra.Command, args []string) error {
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
	var out map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/workspace"), &out)); err != nil {
		return fmt.Errorf("get module workspace: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleBriefPatch(cmd *cobra.Command, args []string) error {
	baseVersion, _ := cmd.Flags().GetInt("base-version")
	if baseVersion < 0 {
		return fmt.Errorf("pass --base-version <n> from `multica module brief get` (0 if the module was never patched)")
	}
	fields := map[string]any{}
	if raw := strings.TrimSpace(flagOr(cmd, "fields", "")); raw != "" {
		if err := json.Unmarshal([]byte(raw), &fields); err != nil {
			return fmt.Errorf("--fields must be a JSON object: %w", err)
		}
	}
	pairs, _ := cmd.Flags().GetStringArray("field")
	for _, pair := range pairs {
		key, value, found := strings.Cut(pair, "=")
		if !found || strings.TrimSpace(key) == "" {
			return fmt.Errorf("--field expects key=value, got %q", pair)
		}
		fields[strings.TrimSpace(key)] = moduleFieldValue(value)
	}
	if len(fields) == 0 {
		return fmt.Errorf("pass at least one --field key=value or --fields <json>")
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
	body := map[string]any{"base_version": baseVersion, "fields": fields}
	if note := strings.TrimSpace(flagOr(cmd, "note", "")); note != "" {
		body["note"] = note
	}
	if source := strings.TrimSpace(flagOr(cmd, "source", "")); source != "" {
		body["source"] = source
	}
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/workspace/patch"), body, &out)); err != nil {
		return fmt.Errorf("patch module brief (409 means someone else patched first — re-run with the current_version it prints): %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

// moduleFieldValue 让 --field 的字符串值尽量保持 JSON 类型（数字/布尔/数组）。
func moduleFieldValue(raw string) any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	switch trimmed[0] {
	case '[', '{', '"':
		var out any
		if err := json.Unmarshal([]byte(trimmed), &out); err == nil {
			return out
		}
	}
	switch trimmed {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	return raw
}

func runModuleReleaseList(cmd *cobra.Command, args []string) error {
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
	var out map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/releases"), &out)); err != nil {
		return fmt.Errorf("list module releases: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleReleasePublish(cmd *cobra.Command, args []string) error {
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
		"Release module %q (%s): the current brief version is paired with a prototype version and both module pointers move.",
		module.Name, module.ID)); err != nil {
		return err
	}
	body := map[string]any{}
	if briefVersion, _ := cmd.Flags().GetInt("brief-version"); briefVersion > 0 {
		body["brief_version"] = briefVersion
	}
	if prototypeVersion, _ := cmd.Flags().GetInt("prototype-version"); prototypeVersion > 0 {
		body["prototype_version"] = prototypeVersion
	}
	if note := strings.TrimSpace(flagOr(cmd, "note", "")); note != "" {
		body["note"] = note
	}
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/releases"), body, &out)); err != nil {
		return fmt.Errorf("publish module release: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModuleReleaseRollback(cmd *cobra.Command, args []string) error {
	releaseVersion, err := strconv.Atoi(strings.TrimSpace(args[1]))
	if err != nil || releaseVersion <= 0 {
		return fmt.Errorf("release version must be a positive integer, got %q", args[1])
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
	if err := confirmDestructive(cmd, fmt.Sprintf(
		"Roll module %q (%s) back to R%d: a new brief version and a new release are appended; history is kept.",
		module.Name, module.ID, releaseVersion)); err != nil {
		return err
	}
	path := moduleScopedPath(module, fmt.Sprintf("/releases/%d/rollback", releaseVersion))
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, path, nil, &out)); err != nil {
		return fmt.Errorf("rollback module release: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

// modulePlanID 检查计划 id 形状，避开把 slug 拼进路径。
func modulePlanID(input string) (string, error) {
	id := strings.TrimSpace(input)
	if len(id) != 36 {
		return "", fmt.Errorf("plan id must be the full UUID printed by `multica module plan create`")
	}
	return id, nil
}

// moduleOptionalJSON 解析可省略的内联 JSON 参数。
func moduleOptionalJSON(value, name string) (json.RawMessage, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(value), &probe); err != nil {
		return nil, fmt.Errorf("--%s is not a JSON object: %w", name, err)
	}
	return json.RawMessage(value), nil
}

// moduleSpecPayload 读 --spec / --file（- 读 stdin），并做一次形状检查：
// 必须是对象且带 features，避免把无效 JSON 送到服务端才报 422。
func moduleSpecPayload(cmd *cobra.Command) (json.RawMessage, error) {
	inline := strings.TrimSpace(flagOr(cmd, "spec", ""))
	file := strings.TrimSpace(flagOr(cmd, "file", ""))
	if inline != "" && file != "" {
		return nil, fmt.Errorf("pass either --spec or --file, not both")
	}
	var raw []byte
	switch {
	case inline != "":
		raw = []byte(inline)
	case file == "-":
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, fmt.Errorf("read spec from stdin: %w", err)
		}
		raw = data
	case file != "":
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read spec file: %w", err)
		}
		raw = data
	default:
		return nil, fmt.Errorf("pass --spec '<json>' or --file <path> (use - for stdin)")
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, fmt.Errorf("spec is not valid JSON: %w", err)
	}
	if _, ok := probe["features"]; !ok {
		return nil, fmt.Errorf(`spec must be a module_spec/v1 object containing "features"`)
	}
	return json.RawMessage(raw), nil
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
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return err
	}
	versions := timeline.Versions

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"module":     module,
			"issues":     issues,
			"prototypes": versions,
			"canonical":  timeline.Canonical,
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
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return err
	}
	versions := timeline.Versions

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"module":    map[string]string{"id": module.ID, "name": module.Name, "project_id": module.ProjectID},
			"canonical": timeline.Canonical,
			"gated":     timeline.Gated,
			"versions":  versions,
		})
	}

	if len(versions) == 0 {
		fmt.Printf("Module %q has no prototype versions yet.\n", module.Name)
		fmt.Fprintf(os.Stderr, "Register one with `multica module prototype register %s --html-path <file>`%s.\n",
			displayID(module.ID, true), requirementHint(issues))
		return nil
	}

	headers := []string{"VERSION", "STATUS", "OWNER", "FILE", "REQUIREMENT", "PATH"}
	rows := make([][]string, 0, len(versions))
	for _, v := range versions {
		status := statusOrUnknown(v.Status)
		if timeline.Canonical != nil && int32(*timeline.Canonical) == v.Version {
			status += " *"
		}
		rows = append(rows, []string{
			fmt.Sprintf("v%d", v.Version),
			status,
			v.Owner,
			modulePrototypeFileState(v.HtmlPath),
			v.IssueKey,
			v.HtmlPath,
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	if timeline.Canonical != nil {
		fmt.Printf("\n* canonical prototype version\n")
	}

	fmt.Fprintf(os.Stderr, "Next:\n  multica module prototype read %s --version %d\n  multica module prototype diff %s --from %d --to %d\n",
		displayID(module.ID, true), versions[0].Version,
		displayID(module.ID, true), previousVersion(versions, versions[0].Version), versions[0].Version)
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
	outPath := strings.TrimSpace(flagOr(cmd, "out", ""))
	if outPath != "" && (rawOutput || jsonOutput) {
		return fmt.Errorf("--out writes the HTML to a file; drop --raw / --json")
	}

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
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return err
	}
	versions := timeline.Versions

	target := pickModulePrototypeVersion(versions, versionFlag)
	if target == nil {
		if len(versions) == 0 {
			return fmt.Errorf("module %q has no prototype versions yet; register one with `multica module prototype register %s --html-path <file>`", module.Name, displayID(module.ID, true))
		}
		return fmt.Errorf("module %q has no prototype version v%d; available: %s", module.Name, versionFlag, joinVersionList(versions))
	}

	body, candidates, err := loadPrototypeBody(ctx, client, module, target.HtmlPath, target.Version)
	if err != nil {
		if len(candidates) > 0 {
			return fmt.Errorf("%w\nlocal candidates tried:\n  %s", err, strings.Join(candidates, "\n  "))
		}
		return err
	}

	if rawOutput {
		_, writeErr := os.Stdout.WriteString(body.HTML)
		if writeErr != nil {
			return writeErr
		}
		if body.HTML != "" && !strings.HasSuffix(body.HTML, "\n") {
			fmt.Println()
		}
		return nil
	}

	if outPath != "" {
		// 落盘是为了「读出来 → 改 → 写回去」形成一个环。没有这一步，agent 只能把
		// 整篇 HTML 握在上下文里，改完还得自己拼上传参数。
		if err := writePrototypeFile(outPath, body.HTML); err != nil {
			return err
		}
		fmt.Printf("Wrote %d bytes to %s\n", len(body.HTML), outPath)
		fmt.Fprintf(os.Stderr, "\nEdit it, then write it back:\n  multica module prototype upload %s --file %s --version %d --replace\n",
			displayID(module.ID, true), outPath, target.Version)
		return nil
	}

	if jsonOutput {
		return cli.PrintJSON(os.Stdout, map[string]any{
			"module_id":     module.ID,
			"module_name":   module.Name,
			"project_id":    module.ProjectID,
			"version":       target.Version,
			"status":        target.Status,
			"issue":         target.IssueKey,
			"html_path":     target.HtmlPath,
			"source":        body.Kind,
			"file":          body.Path,
			"bytes":         body.Bytes,
			"artifact_id":   body.ArtifactID,
			"attachment_id": body.AttachmentID,
		})
	}

	fmt.Printf("Module:  %s\n", module.Name)
	fmt.Printf("Version: v%d (%s)\n", target.Version, statusOrUnknown(target.Status))
	if target.IssueKey != "" {
		fmt.Printf("From:    %s %s\n", target.IssueKey, target.IssueTitle)
	}
	fmt.Printf("Path:    %s\n", target.HtmlPath)
	if body.Kind == "server" {
		// 上传登记的原型没有磁盘副本：正文只存在于 attachment 里，说清楚它是怎么来的，
		// 否则下一个 agent 又会去找一个永远不存在的文件。
		fmt.Printf("Source:  server · artifact %s · attachment %s\n", body.ArtifactID, body.AttachmentID)
		fmt.Printf("Size:    %d bytes\n", body.Bytes)
		fmt.Fprintf(os.Stderr, "\nRead it with: multica module prototype read %s --raw\n", displayID(module.ID, true))
		return nil
	}
	fmt.Printf("File:    %s\n", body.Path)
	fmt.Printf("Size:    %d bytes\n", body.Bytes)
	fmt.Fprintf(os.Stderr, "\nRead it with: cat %q\n", body.Path)
	return nil
}

// writePrototypeFile 落盘前补好目录：agent 常把 --out 指向一个还不存在的临时目录。
func writePrototypeFile(path, html string) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create directory for %s: %w", path, err)
		}
	}
	if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
		return fmt.Errorf("write prototype to %s: %w", path, err)
	}
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
