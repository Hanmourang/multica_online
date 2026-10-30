package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 模块自有原型的维护面。
//
// 一条模块的原型时间轴有两个来源：需求产出的版本（issue_prototype_version
// 带 issue_id），以及直接挂在模块上的版本（只有 module_id）。前者归需求管，
// 后者归模块管——没有需求的模块也要能迭代原型，这正是模块级版本的用途。
// 下面的命令只动「模块自有」那一类；需求版本仍走 `multica requirement prototype`。
var modulePrototypeRegisterCmd = &cobra.Command{
	Use:   "register <module>",
	Short: "Register an HTML file as a new module prototype version",
	Long: `Puts one HTML file on the module's prototype timeline. The module does not need
a requirement: this is how a prototype is iterated when the work is module-shaped.

  multica module prototype register <module> --html-path ./v3.html --prompt "加会话列表"
  multica module prototype register <module> --html-path ./v3.html --status confirmed
  multica module prototype register <module> --html-path ./v3.html --version 7 \
    --prompt "回填历史版本"

--html-path accepts a file on this machine (absolute or relative to the working
directory) or a repository-relative path (requirements/... or change_logs/...).
A file that exists under the archive root, the sibling change_logs root or the
workspace dir is stored in its repository-relative form, so the row stays
readable from another machine; anything else is stored verbatim.

--version defaults to (highest existing version + 1). Re-registering an existing
number answers 409 prototype_version_exists.

--set-canonical is only accepted together with --status confirmed, and it moves
the module's authoritative prototype pointer on its own. When the point of the
new version is a spec change as well, use the two-phase plan instead
(multica module plan create), which moves pointer + spec together.`,
	Args: exactArgs(1),
	RunE: runModulePrototypeRegister,
}

var modulePrototypeUpdateCmd = &cobra.Command{
	Use:   "update <module> <version>",
	Short: "Fix the path, prompt or status of a module-owned version",
	Long: `Only the flags you pass are sent. This is for correcting a row, not for
publishing a new iteration: a changed file deserves a new version number so the
timeline stays honest (use register for that).

The canonical version cannot leave confirmed (409 canonical_pending_not_allowed).
Versions claimed by a requirement are refused (409 prototype_owned_by_requirement);
edit those through multica requirement prototype.`,
	Args: exactArgs(2),
	RunE: runModulePrototypeUpdate,
}

var modulePrototypeConfirmCmd = &cobra.Command{
	Use:   "confirm <module> <version>",
	Short: "Mark a module-owned version as confirmed (optionally canonical)",
	Long: `Confirm = "this prototype is accepted". --canonical additionally moves the
module's authoritative pointer and supersedes the previous confirmed version.

It does not bump spec_version and does not rebuild the feature projection: a spec
that changes with the prototype is a plan (multica module plan create/apply).`,
	Args: exactArgs(2),
	RunE: runModulePrototypeConfirm,
}

var modulePrototypeDeleteCmd = &cobra.Command{
	Use:   "delete <module> <version> --yes",
	Short: "Delete one module-owned version (needs --yes)",
	Long: `Removes the version row and its cached anchor parse. Two rows are refused:
the canonical version (confirm another one first) and any version referenced by a
release (409 prototype_in_release — releases keep their history).

Use this for a mistyped path or an abandoned draft. Deleting a version does not
touch the HTML file on disk.`,
	Args: exactArgs(2),
	RunE: runModulePrototypeDelete,
}

var modulePrototypeParseCmd = &cobra.Command{
	Use:   "parse <module> [<version>]",
	Short: "Extract data-fp anchors of a version so reconcile/coverage have numbers",
	Long: `Reconcile and coverage read a cached anchor map (module_prototype_parse); the
server deliberately does not parse HTML. This command parses the version's file
locally and uploads the anchors, which is what the 结构对账 TAB does when it
renders.

  multica module prototype parse <module>              # live version
  multica module prototype parse <module> 2            # one version
  multica module prototype parse <module> --html-path ./v3.html   # not registered yet

Anchors are self-declared in the prototype as data-fp="fp.xxx" (data-title is the
human title). A prototype with only headings has zero anchors: reconcile then
reports every spec feature as missing, which is a真实 result, not an error.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: runModulePrototypeParse,
}

func init() {
	modulePrototypeRegisterCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeRegisterCmd.Flags().String("html-path", "", "HTML file or repository-relative path (required)")
	modulePrototypeRegisterCmd.Flags().Int("version", 0, "Version number (default: highest existing + 1)")
	modulePrototypeRegisterCmd.Flags().String("status", "pending", "pending | confirmed | superseded")
	modulePrototypeRegisterCmd.Flags().String("prompt", "", "What this version changes (stored with the version)")
	modulePrototypeRegisterCmd.Flags().String("issue", "", "Optional requirement to claim the version into (KEY or UUID)")
	modulePrototypeRegisterCmd.Flags().Bool("set-canonical", false, "Also make it the module's canonical prototype (needs --status confirmed)")
	modulePrototypeRegisterCmd.Flags().String("output", "json", "Output format: table or json")

	modulePrototypeUpdateCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeUpdateCmd.Flags().String("html-path", "", "New HTML file or repository-relative path")
	modulePrototypeUpdateCmd.Flags().String("prompt", "", "New prompt / intent line")
	modulePrototypeUpdateCmd.Flags().String("status", "", "New status: pending | confirmed | superseded")
	modulePrototypeUpdateCmd.Flags().String("output", "json", "Output format: table or json")

	modulePrototypeConfirmCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeConfirmCmd.Flags().Bool("canonical", false, "Also move the module's canonical prototype pointer to this version")
	modulePrototypeConfirmCmd.Flags().String("output", "json", "Output format: table or json")

	modulePrototypeDeleteCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeDeleteCmd.Flags().String("output", "json", "Output format: table or json")
	addDestructiveFlags(modulePrototypeDeleteCmd)

	modulePrototypeParseCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeParseCmd.Flags().String("html-path", "", "Parse this file instead of the version's stored path")
	modulePrototypeParseCmd.Flags().String("output", "json", "Output format: table or json")

	modulePrototypeCmd.AddCommand(modulePrototypeRegisterCmd)
	modulePrototypeCmd.AddCommand(modulePrototypeUpdateCmd)
	modulePrototypeCmd.AddCommand(modulePrototypeConfirmCmd)
	modulePrototypeCmd.AddCommand(modulePrototypeDeleteCmd)
	modulePrototypeCmd.AddCommand(modulePrototypeParseCmd)
}

// ── 读取：模块自有版本 + 需求版本合并 ────────────────────────────────────

// modulePrototypeTimeline 是一条模块的完整原型时间轴。
type modulePrototypeTimeline struct {
	Versions  []modulePrototypeVersion
	Canonical *int32
	// Gated 表示模块级端点被 FF_MODULE_SPEC_CENTER 关掉了，时间轴只有需求版。
	Gated bool
}

// fetchModuleOwnedPrototypeVersions 读模块自有的版本（无需求也能有）。
// 404 视为「flag 关闭」，返回 Gated=true 而不是报错：读链路必须两条路都能走。
func fetchModuleOwnedPrototypeVersions(ctx context.Context, client *cli.APIClient, module moduleRecord) ([]modulePrototypeVersion, *int32, bool) {
	var result struct {
		Versions  []modulePrototypeVersion `json:"versions"`
		Canonical *int32                   `json:"canonical_prototype_version"`
	}
	if err := client.GetJSON(ctx, moduleScopedPath(module, "/prototype-versions"), &result); err != nil {
		if strings.Contains(err.Error(), "404") {
			return nil, nil, true
		}
		return nil, nil, false
	}
	for i := range result.Versions {
		result.Versions[i].Owner = "module"
	}
	return result.Versions, result.Canonical, false
}

// fetchModuleTimeline 合并两条轴。模块版优先（它带着 canonical 指针），
// 需求版补上 issue 归属；同一 id 只留一条，避免界面上重复两行。
func fetchModuleTimeline(ctx context.Context, client *cli.APIClient, module moduleRecord, issues []moduleIssue) (modulePrototypeTimeline, error) {
	owned, canonical, gated := fetchModuleOwnedPrototypeVersions(ctx, client, module)
	byIssue, err := fetchModulePrototypeVersions(ctx, client, issues)
	if err != nil {
		return modulePrototypeTimeline{}, err
	}
	issueByID := make(map[string]modulePrototypeVersion, len(byIssue))
	for _, version := range byIssue {
		issueByID[version.ID] = version
	}

	seen := make(map[string]bool, len(owned)+len(byIssue))
	out := make([]modulePrototypeVersion, 0, len(owned)+len(byIssue))
	for _, version := range owned {
		if version.ID != "" {
			seen[version.ID] = true
		}
		// 模块登记时认领的需求行：issue 归属信息在需求轴那边，补回来。
		if peer, ok := issueByID[version.ID]; ok {
			version.IssueKey = peer.IssueKey
			version.IssueTitle = peer.IssueTitle
			if version.IssueID == "" {
				version.IssueID = peer.IssueID
			}
		}
		out = append(out, version)
	}
	for _, version := range byIssue {
		if version.ID != "" && seen[version.ID] {
			continue
		}
		version.Owner = "requirement"
		out = append(out, version)
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Version != out[j].Version {
			return out[i].Version > out[j].Version
		}
		return out[i].Owner < out[j].Owner
	})
	return modulePrototypeTimeline{Versions: out, Canonical: canonical, Gated: gated}, nil
}

// maxModulePrototypeVersion 返回可用作「下一版」的版本号。
func maxModulePrototypeVersion(versions []modulePrototypeVersion) int32 {
	var max int32
	for _, version := range versions {
		if version.Version > max {
			max = version.Version
		}
	}
	return max
}

// prototypeHTMLPathForRegistration 把「手上的文件」变成能存进库的 html_path。
//
// 文件落在档案根 / change_logs / 工作区目录之内时存相对路径（换机器仍能解析，
// `prototype read` 的候选根就是这三处）；不在任何已知根下时原样存绝对路径，
// 至少不撒谎。非文件输入（例如已经在库里出现过的仓库相对路径）原样返回。
func prototypeHTMLPathForRegistration(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil || !fileExists(abs) {
		return filepath.ToSlash(trimmed)
	}
	best := ""
	for _, root := range modulePrototypeRoots() {
		rel, ok := relInside(root, abs)
		if !ok {
			continue
		}
		if filepath.Base(root) == "change_logs" && !strings.HasPrefix(rel, "change_logs/") {
			rel = "change_logs/" + rel
		}
		if best == "" || len(rel) < len(best) {
			best = rel
		}
	}
	if best != "" {
		return best
	}
	return filepath.ToSlash(abs)
}

// ── 写入 ────────────────────────────────────────────────────────────────

func runModulePrototypeRegister(cmd *cobra.Command, args []string) error {
	rawPath := strings.TrimSpace(flagOr(cmd, "html-path", ""))
	if rawPath == "" {
		return fmt.Errorf("--html-path is required (the HTML file of this prototype version)")
	}
	htmlPath := prototypeHTMLPathForRegistration(rawPath)
	if htmlPath == "" {
		return fmt.Errorf("--html-path is required (the HTML file of this prototype version)")
	}
	status := strings.TrimSpace(flagOr(cmd, "status", "pending"))
	if status == "" {
		status = "pending"
	}
	switch status {
	case "pending", "confirmed", "superseded":
	default:
		return fmt.Errorf("--status must be pending, confirmed or superseded")
	}
	setCanonical, _ := cmd.Flags().GetBool("set-canonical")
	if setCanonical && status != "confirmed" {
		return fmt.Errorf("--set-canonical needs --status confirmed: only a confirmed version may become canonical")
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

	version, _ := cmd.Flags().GetInt("version")
	if version <= 0 {
		issues, err := fetchModuleIssues(ctx, client, module.ID)
		if err != nil {
			return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
		}
		timeline, err := fetchModuleTimeline(ctx, client, module, issues)
		if err != nil {
			return err
		}
		version = int(maxModulePrototypeVersion(timeline.Versions)) + 1
	}

	body := map[string]any{
		"version":   version,
		"html_path": htmlPath,
		"status":    status,
	}
	if prompt := strings.TrimSpace(flagOr(cmd, "prompt", "")); prompt != "" {
		body["prompt"] = prompt
	}
	if setCanonical {
		body["set_canonical"] = true
	}
	if ref := strings.TrimSpace(flagOr(cmd, "issue", "")); ref != "" {
		issue, err := resolveIssueRef(ctx, client, ref)
		if err != nil {
			return fmt.Errorf("resolve requirement: %w", err)
		}
		body["issue_id"] = issue.ID
	}

	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/prototype-versions"), body, &out)); err != nil {
		return fmt.Errorf("register prototype version: %w", err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Printf("Registered %s v%d (%s)\n", module.Name, version, status)
		fmt.Printf("Path: %s\n", htmlPath)
		if setCanonical {
			fmt.Println("Canonical pointer moved to this version.")
		}
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModulePrototypeUpdate(cmd *cobra.Command, args []string) error {
	version, err := modulePrototypeVersionArg(args[1])
	if err != nil {
		return err
	}
	body := map[string]any{}
	if cmd.Flags().Changed("html-path") {
		path := prototypeHTMLPathForRegistration(flagOr(cmd, "html-path", ""))
		if path == "" {
			return fmt.Errorf("--html-path cannot be empty")
		}
		body["html_path"] = path
	}
	if cmd.Flags().Changed("prompt") {
		body["prompt"] = strings.TrimSpace(flagOr(cmd, "prompt", ""))
	}
	if cmd.Flags().Changed("status") {
		status := strings.TrimSpace(flagOr(cmd, "status", ""))
		switch status {
		case "pending", "confirmed", "superseded":
			body["status"] = status
		default:
			return fmt.Errorf("--status must be pending, confirmed or superseded")
		}
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass at least one of --html-path, --prompt, --status")
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
	path := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d", version))
	if err := moduleGateHint(client.PatchJSON(ctx, path, body, &out)); err != nil {
		return fmt.Errorf("update prototype version: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModulePrototypeConfirm(cmd *cobra.Command, args []string) error {
	version, err := modulePrototypeVersionArg(args[1])
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
	canonical, _ := cmd.Flags().GetBool("canonical")
	body := map[string]any{}
	if canonical {
		body["set_canonical"] = true
	}
	var out map[string]any
	path := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d/confirm", version))
	if err := moduleGateHint(client.PostJSON(ctx, path, body, &out)); err != nil {
		return fmt.Errorf("confirm prototype version: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), out)
}

func runModulePrototypeDelete(cmd *cobra.Command, args []string) error {
	version, err := modulePrototypeVersionArg(args[1])
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
		"Delete prototype v%d of module %q (%s). The version row and its cached anchors are removed; the HTML file on disk is kept. Canonical versions and versions referenced by a release are refused by the server.",
		version, module.Name, module.ID)); err != nil {
		return err
	}
	path := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d", version))
	if err := moduleGateHint(client.DeleteJSON(ctx, path)); err != nil {
		return fmt.Errorf("delete prototype version: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
		"deleted":   true,
		"module_id": module.ID,
		"version":   version,
	})
}

func runModulePrototypeParse(cmd *cobra.Command, args []string) error {
	requested := 0
	if len(args) == 2 {
		version, err := modulePrototypeVersionArg(args[1])
		if err != nil {
			return err
		}
		requested = version
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

	// 文件来源：--html-path 优先（还没登记的稿子也能先看覆盖率），否则用版本的路径。
	file := strings.TrimSpace(flagOr(cmd, "html-path", ""))
	version := requested
	if file == "" {
		issues, err := fetchModuleIssues(ctx, client, module.ID)
		if err != nil {
			return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
		}
		timeline, err := fetchModuleTimeline(ctx, client, module, issues)
		if err != nil {
			return err
		}
		target := pickModulePrototypeVersion(timeline.Versions, requested)
		if target == nil {
			if len(timeline.Versions) == 0 {
				return fmt.Errorf("module %q has no prototype versions yet; register one with `multica module prototype register %s --html-path <file>`", module.Name, displayID(module.ID, true))
			}
			return fmt.Errorf("module %q has no prototype version v%d; available: %s", module.Name, requested, joinVersionList(timeline.Versions))
		}
		version = int(target.Version)
		abs, candidates := resolveModulePrototypePath(target.HtmlPath)
		if abs == "" {
			return fmt.Errorf("prototype file of %s v%d is not on this machine.\n  html_path: %s\ntried:\n  %s\nPass --html-path <file> to parse a local copy.",
				module.Name, target.Version, target.HtmlPath, strings.Join(candidates, "\n  "))
		}
		file = abs
	} else if abs, _ := resolveModulePrototypePath(file); abs != "" {
		file = abs
	}
	if version <= 0 {
		return fmt.Errorf("pass the version to store the anchors under, e.g. `multica module prototype parse %s 3 --html-path %s`", displayID(module.ID, true), file)
	}

	html, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("read prototype file: %w", err)
	}
	anchors := extractPrototypeAnchors(string(html))
	body := map[string]any{"anchors": anchors}
	var out map[string]any
	path := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d/parse", version))
	if err := moduleGateHint(client.PostJSON(ctx, path, body, &out)); err != nil {
		return fmt.Errorf("upload prototype anchors: %w", err)
	}

	codes := make([]string, 0, len(anchors))
	for code := range anchors {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Printf("Module:  %s\n", module.Name)
		fmt.Printf("Version: v%d\n", version)
		fmt.Printf("File:    %s\n", file)
		fmt.Printf("Anchors: %d\n", len(anchors))
		if len(codes) == 0 {
			fmt.Println("No data-fp anchor found: add data-fp=\"fp.xxx\" to the blocks you want to reconcile.")
			fmt.Println("Reconcile will report every spec feature as missing until anchors exist.")
			return nil
		}
		rows := make([][]string, 0, len(codes))
		for _, code := range codes {
			rows = append(rows, []string{code, fmt.Sprintf("%d", anchors[code].Count), anchors[code].Title})
		}
		cli.PrintTable(os.Stdout, []string{"CODE", "COUNT", "TITLE"}, rows)
		fmt.Fprintf(os.Stderr, "Next:\n  multica module reconcile %s --version %d\n", displayID(module.ID, true), version)
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
		"module_id": module.ID,
		"version":   version,
		"file":      file,
		"anchors":   anchors,
		"count":     len(anchors),
	})
}

// modulePrototypeVersionArg 解析 <version> 位置参数（允许写作 v3 / V3）。
func modulePrototypeVersionArg(input string) (int, error) {
	trimmed := strings.TrimSpace(input)
	trimmed = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "v"), "V"))
	version, err := strconv.Atoi(trimmed)
	if err != nil || version <= 0 {
		return 0, fmt.Errorf("version must be a positive integer (e.g. 3 or v3), got %q", input)
	}
	return version, nil
}
