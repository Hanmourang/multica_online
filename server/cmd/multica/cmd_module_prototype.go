package main

import (
	"context"
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
	"github.com/multica-ai/multica/server/internal/prototypeimport"
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
(multica module plan create), which moves pointer + spec together.

This command records coordinates only — a version number plus html_path. It does
NOT upload any bytes. If the HTML lives only on this machine (a file the agent
generated in a temp dir, or anything outside the archive), the version is
invisible in the web UI (preview reads attachment storage) and unreadable from
another machine. For that case use 'multica module prototype upload', which
stores the bytes, creates the archive row and registers the version in one go.`,
	Args: exactArgs(1),
	RunE: runModulePrototypeRegister,
}

// upload 是 register 的「带正文」版本：寄存器里的 html_path 只是坐标，正文可能
// 从来不存在。agent 现场生成 HTML 时，只有这条命令能让这一版在 Web 端被看见。
var modulePrototypeUploadCmd = &cobra.Command{
	Use:   "upload <module> (--file <path>|--file -|--html '<html>')",
	Short: "Upload prototype HTML bytes as a new version (visible in the web UI)",
	Long: `Stores the HTML on the server, in one command, the same way the UI's
"新建原型" does it:

  1. upload bytes            → attachment_id
  2. create the archive row  → prototypes/<module>/prototype-v<N>.html
  3. register the version    → version row whose html_path is that rel_path
  4. cache data-fp anchors   (best effort, so reconcile/coverage have numbers)

Why not register: register only records html_path. When the file exists solely on
the machine that produced it, the version cannot be previewed in the web UI and
cannot be read from another machine. Upload is the only path that carries bytes.

  multica module prototype upload <module> --file ./v3.html --prompt "加会话列表"
  cat v3.html | multica module prototype upload <module> --file -
  multica module prototype upload <module> --html "$(cat v3.html)"

--version defaults to (highest existing version + 1). --replace binds the bytes
to an existing version instead of creating one — that is the repair path for a
version whose html_path points at a file nobody can read.

After uploading, the version is confirmed only if you pass --status confirmed;
--set-canonical additionally makes it the module's live prototype.`,
	Args: exactArgs(1),
	RunE: runModulePrototypeUpload,
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

	modulePrototypeUploadCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeUploadCmd.Flags().String("file", "", "HTML file to upload; pass - to read stdin")
	modulePrototypeUploadCmd.Flags().String("html", "", "Inline HTML instead of --file")
	modulePrototypeUploadCmd.Flags().Int("version", 0, "Version number (default: highest existing + 1; required with --replace)")
	modulePrototypeUploadCmd.Flags().String("status", "pending", "pending | confirmed | superseded")
	modulePrototypeUploadCmd.Flags().String("prompt", "", "What this version changes (stored with the version)")
	modulePrototypeUploadCmd.Flags().String("issue", "", "Optional requirement to claim the version into (KEY or UUID)")
	modulePrototypeUploadCmd.Flags().Bool("set-canonical", false, "Also make it the module's canonical prototype (needs --status confirmed)")
	modulePrototypeUploadCmd.Flags().Bool("replace", false, "Bind the bytes to an existing version instead of creating one")
	modulePrototypeUploadCmd.Flags().String("rel-path", "", "Archive rel_path override (default: prototypes/<module>/prototype-v<N>.<ext>)")
	modulePrototypeUploadCmd.Flags().String("output", "json", "Output format: table or json")

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
	modulePrototypeCmd.AddCommand(modulePrototypeUploadCmd)
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

// modulePrototypeIssueID 找出版本归属的需求（模块自有版本返回空串）。
func modulePrototypeIssueID(ctx context.Context, client *cli.APIClient, module moduleRecord, version int) (string, error) {
	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return "", fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return "", err
	}
	for _, row := range timeline.Versions {
		if int(row.Version) == version && row.IssueID != "" {
			return row.IssueID, nil
		}
	}
	return "", nil
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
		version, err = nextModulePrototypeVersion(ctx, client, module)
		if err != nil {
			return err
		}
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

// nextModulePrototypeVersion 取「两轴最大值 + 1」：版本号在模块内唯一，只看模块
// 自有那一轴会与需求产的版本撞号。
func nextModulePrototypeVersion(ctx context.Context, client *cli.APIClient, module moduleRecord) (int, error) {
	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return 0, fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return 0, err
	}
	return int(maxModulePrototypeVersion(timeline.Versions)) + 1, nil
}

// prototypeUploadLimit 与界面「新增原型」的 20MiB 上限一致。
const prototypeUploadLimit = 20 << 20

// prototypePathSlug / prototypeRelPathFor 只是 prototypeimport 的本地别名：界面、
// CLI 与 MCP 三个入口必须算出同一个 rel_path，否则档案行与版本行对不上，
// Web 端预览与 prototype read 都会找不到正文。
func prototypePathSlug(value string) string {
	return prototypeimport.PathSlug(value)
}

func prototypeRelPathFor(moduleName string, version int, fileName string) string {
	return prototypeimport.RelPath(moduleName, int32(version), fileName)
}

// readPrototypeUpload 把「正文从哪来」归一成字节 + 文件名。三种来源只允许给一种：
// --html（agent 直接拼出来的）、--file <path>（本地稿子）、--file -（stdin）。
func readPrototypeUpload(cmd *cobra.Command) ([]byte, string, error) {
	inline := flagOr(cmd, "html", "")
	file := strings.TrimSpace(flagOr(cmd, "file", ""))
	switch {
	case inline != "" && file != "":
		return nil, "", fmt.Errorf("pass either --file or --html, not both")
	case inline != "":
		return []byte(inline), "prototype.html", nil
	case file == "-":
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, "", fmt.Errorf("read prototype HTML from stdin: %w", err)
		}
		return data, "prototype.html", nil
	case file != "":
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, "", fmt.Errorf("read prototype file %s: %w", file, err)
		}
		return data, filepath.Base(file), nil
	}
	return nil, "", fmt.Errorf("pass --file <path> (or --file - for stdin) or --html '<html>': upload needs the prototype bytes")
}

// runModulePrototypeUpload 一步完成 upload → artifact → version → anchors。
//
// 顺序不能反：档案行必须先存在，register 失败时还能用 update 修指针；反过来会
// 留下一行指向不存在正文的版本——那正是让人反复去找文件的坑。
func runModulePrototypeUpload(cmd *cobra.Command, args []string) error {
	content, fileName, err := readPrototypeUpload(cmd)
	if err != nil {
		return err
	}
	if len(content) == 0 {
		return fmt.Errorf("prototype HTML is empty; nothing to upload")
	}
	if len(content) > prototypeUploadLimit {
		return fmt.Errorf("prototype HTML is %d bytes, over the %d byte limit; split it or point --file at the real file", len(content), prototypeUploadLimit)
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
	replace, _ := cmd.Flags().GetBool("replace")

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
		if replace {
			return fmt.Errorf("--replace needs an explicit --version: it binds the bytes to that existing version")
		}
		version, err = nextModulePrototypeVersion(ctx, client, module)
		if err != nil {
			return err
		}
	}
	relPath := strings.TrimSpace(flagOr(cmd, "rel-path", ""))
	if relPath == "" {
		relPath = prototypeRelPathFor(module.Name, version, fileName)
	}

	// 1. 字节
	attachmentID, err := client.UploadFile(ctx, content, fileName, "")
	if err != nil {
		return fmt.Errorf("upload prototype bytes: %w", err)
	}

	// 2. 档案行（Web 端预览只认带 attachment 的档案行）
	artifactBody := map[string]any{
		"scope":         "project",
		"stage":         1,
		"doc_type":      "prototype",
		"rel_path":      relPath,
		"doc_module":    module.Name,
		"version":       version,
		"attachment_id": attachmentID,
	}
	var artifact map[string]any
	if err := client.PostJSON(ctx, "/api/projects/"+url.PathEscape(module.ProjectID)+"/artifacts", artifactBody, &artifact); err != nil {
		return fmt.Errorf("bytes uploaded (attachment %s) but the archive row at %s could not be created: %w\n"+
			"The bytes are orphaned; retry, or create the row yourself:\n  multica artifact create %s --scope project --stage 1 --doc-type prototype --rel-path %s --doc-module %q --version %d --attachment %s",
			attachmentID, relPath, err, module.ProjectID, relPath, module.Name, version, attachmentID)
	}
	artifactID := strVal(artifact, "id")

	// 3. 版本行：html_path 必须与档案行的 rel_path 一致，MatchArtifact 才能精确命中。
	body := map[string]any{"html_path": relPath}
	if prompt := strings.TrimSpace(flagOr(cmd, "prompt", "")); prompt != "" {
		body["prompt"] = prompt
	}
	var out map[string]any
	if replace {
		body["status"] = status
		path := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d", version))
		if err := moduleGateHint(client.PatchJSON(ctx, path, body, &out)); err != nil {
			if strings.Contains(err.Error(), "prototype_owned_by_requirement") {
				return fmt.Errorf("bytes and archive row are stored (artifact %s), but v%d belongs to a requirement and cannot be re-pointed through the module axis: %w\n"+
					"Use multica requirement prototype to update the requirement's version.", artifactID, version, err)
			}
			return fmt.Errorf("bytes and archive row are stored (artifact %s, attachment %s) but re-pointing v%d failed: %w",
				artifactID, attachmentID, version, err)
		}
	} else {
		body["version"] = version
		body["status"] = status
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
		if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/prototype-versions"), body, &out)); err != nil {
			return fmt.Errorf("bytes and archive row are stored (artifact %s, attachment %s) but registering v%d failed: %w\n"+
				"Pick another --version, or bind the stored bytes with:\n  multica module prototype upload %s --file %s --version %d --replace",
				artifactID, attachmentID, version, err, displayID(module.ID, true), fileName, version)
		}
	}

	// 4. 锚点缓存（尽力而为）：没它 reconcile/coverage 会把每个功能点判成空位。
	anchors := extractPrototypeAnchors(string(content))
	var parseErr string
	if len(anchors) > 0 {
		parsePath := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d/parse", version))
		if err := moduleGateHint(client.PostJSON(ctx, parsePath, map[string]any{"anchors": anchors}, nil)); err != nil {
			parseErr = err.Error()
		}
	}

	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Printf("Uploaded %s v%d (%s)\n", module.Name, version, status)
		fmt.Printf("Path:     %s\n", relPath)
		fmt.Printf("Artifact: %s · attachment %s\n", artifactID, attachmentID)
		fmt.Printf("Bytes:    %d\n", len(content))
		fmt.Printf("Anchors:  %d\n", len(anchors))
		if parseErr != "" {
			fmt.Fprintf(os.Stderr, "Anchor cache not refreshed (%s); run multica module prototype parse %s %d\n", parseErr, displayID(module.ID, true), version)
		}
		moduleRef := displayID(module.ID, true)
		fmt.Fprintf(os.Stderr, "Next:\n  multica module prototype read %s --version %d --raw\n  multica module reconcile %s --version %d\n",
			moduleRef, version, moduleRef, version)
		if !setCanonical {
			fmt.Fprintf(os.Stderr, "  multica module prototype confirm %s %d --canonical   # make it the live prototype\n", moduleRef, version)
		}
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"module_id":     module.ID,
			"module_name":   module.Name,
			"version":       version,
			"status":        status,
			"html_path":     relPath,
			"artifact_id":   artifactID,
			"attachment_id": attachmentID,
			"bytes":         len(content),
			"anchors":       len(anchors),
			"replaced":      replace,
		})
	}
	result := map[string]any{
		"module_id":     module.ID,
		"module_name":   module.Name,
		"project_id":    module.ProjectID,
		"version":       version,
		"status":        status,
		"html_path":     relPath,
		"artifact_id":   artifactID,
		"attachment_id": attachmentID,
		"bytes":         len(content),
		"anchors":       len(anchors),
		"replaced":      replace,
	}
	if parseErr != "" {
		result["anchor_parse_error"] = parseErr
	}
	return cli.PrintJSON(cmd.OutOrStdout(), result)
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
	err = moduleGateHint(client.PatchJSON(ctx, path, body, &out))
	if err != nil && strings.Contains(err.Error(), "prototype_owned_by_requirement") {
		// 右栏的「更新文件」对两条轴上的版本都有效；这里走同一条路：
		// 先定位归属需求，再打需求侧端点。status 是模块自有的开关，不能顺手改。
		if _, hasStatus := body["status"]; hasStatus {
			return fmt.Errorf("version v%d belongs to a requirement: --status only applies to module-owned versions; requirement versions follow the requirement's own flow", version)
		}
		issueID, lookupErr := modulePrototypeIssueID(ctx, client, module, version)
		if lookupErr != nil {
			return fmt.Errorf("version v%d belongs to a requirement and its owner could not be resolved: %w", version, lookupErr)
		}
		if issueID == "" {
			return fmt.Errorf("version v%d belongs to a requirement that is no longer attached to module %q; run `multica module prototype list %s` to see the current owners",
				version, module.Name, displayID(module.ID, true))
		}
		issueBody := map[string]any{}
		if value, ok := body["html_path"]; ok {
			issueBody["html_path"] = value
		}
		if value, ok := body["prompt"]; ok {
			issueBody["prompt"] = value
		}
		var issueOut map[string]any
		if err := client.PatchJSON(ctx, "/api/issues/"+issueID+"/prototypes/"+strconv.Itoa(version), issueBody, &issueOut); err != nil {
			return fmt.Errorf("update prototype version on the requirement axis: %w", err)
		}
		if output, _ := cmd.Flags().GetString("output"); output == "table" {
			fmt.Printf("Updated v%d of module %s (owner: requirement %s)\n", version, module.Name, issueID)
			return nil
		}
		return cli.PrintJSON(cmd.OutOrStdout(), issueOut)
	}
	if err != nil {
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
	// 两者都可能是“只存在服务端附件里”的虚拟路径，具体在哪由 loadPrototypeBody 定。
	htmlPath := strings.TrimSpace(flagOr(cmd, "html-path", ""))
	version := requested
	if htmlPath == "" {
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
		htmlPath = target.HtmlPath
	}
	if version <= 0 {
		return fmt.Errorf("pass the version to store the anchors under, e.g. `multica module prototype parse %s 3 --html-path %s`", displayID(module.ID, true), htmlPath)
	}

	body, candidates, err := loadPrototypeBody(ctx, client, module, htmlPath, int32(version))
	if err != nil {
		if len(candidates) > 0 {
			return fmt.Errorf("%w\nlocal candidates tried:\n  %s", err, strings.Join(candidates, "\n  "))
		}
		return err
	}

	anchors := extractPrototypeAnchors(body.HTML)
	payload := map[string]any{"anchors": anchors}
	var out map[string]any
	path := moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d/parse", version))
	if err := moduleGateHint(client.PostJSON(ctx, path, payload, &out)); err != nil {
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
		fmt.Printf("Source:  %s\n", body.Kind)
		fmt.Printf("File:    %s\n", body.Path)
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
		"module_id":     module.ID,
		"version":       version,
		"source":        body.Kind,
		"file":          body.Path,
		"artifact_id":   body.ArtifactID,
		"attachment_id": body.AttachmentID,
		"anchors":       anchors,
		"count":         len(anchors),
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
