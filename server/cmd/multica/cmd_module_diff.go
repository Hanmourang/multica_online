package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 原型版本对比：把「v2 → v3 到底改了什么」变成一段 agent 能直接引用的结论。
//
// 后端刻意不解析 HTML（reconcile 用的是前端回传的解析缓存），所以对比也在客户端
// 做：读两版文件 → 抽区块标题 / data-fp 锚点 / 可见正文行 → 出三组差量
// （区块、锚点、行级），再给一句话摘要。纯函数，便于单测。
var modulePrototypeDiffCmd = &cobra.Command{
	Use:   "diff <module> [--from <v>] [--to <v>]",
	Short: "Summarize what changed between two prototype versions",
	Long: `Reads both versions' HTML files and reports three layers of change:

  sections  added / removed / reordered headings (h1–h3), i.e. the page structure
  anchors   added / removed / retitled data-fp codes, i.e. the feature points
  text      +/- visible lines, with a collapsed diff preview

--to defaults to the canonical version (else the newest), --from to the version
just below it. Both files must exist on this machine; a superseded version whose
file is gone is reported instead of silently comparing nothing.

This is the command to run when someone asks "这一版和上一版差在哪" — quote the
headline plus the anchor lists rather than paraphrasing the HTML.`,
	Args: exactArgs(1),
	RunE: runModulePrototypeDiff,
}

var moduleBriefVersionsCmd = &cobra.Command{
	Use:   "versions <module>",
	Short: "List the brief version record (what changed, by whom, when)",
	Long: `One row per appended brief version: version, source (manual / agent / mcp /
extract / rollback), actor type, how many fields changed, the stored one-line
summary and when.

This is the data behind the 版本记录 section of the 功能点详解 pane.`,
	Args: exactArgs(1),
	RunE: runModuleBriefVersions,
}

var moduleBriefDiffCmd = &cobra.Command{
	Use:   "diff <module> [--from <v>] [--to <v>]",
	Short: "Field-level diff between two brief versions",
	Long: `Replays the stored per-version change log and reports, per field, the value at
--from and at --to. --to defaults to the current brief version, --from to the one
just below it.

  multica module brief diff <module>                 # previous → current
  multica module brief diff <module> --from 2 --to 5 # across several patches

Use it to answer "说明改了哪些字段"; the values are the same rows the right pane
renders, so the answer stays quotable.`,
	Args: exactArgs(1),
	RunE: runModuleBriefDiff,
}

func init() {
	modulePrototypeDiffCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	modulePrototypeDiffCmd.Flags().Int("from", 0, "Older version (default: the one below --to)")
	modulePrototypeDiffCmd.Flags().Int("to", 0, "Newer version (default: canonical, else newest)")
	modulePrototypeDiffCmd.Flags().Int("context", 2, "Context lines around each change in the text preview")
	modulePrototypeDiffCmd.Flags().Int("max-lines", 60, "Maximum preview lines to print (0 = no preview)")
	modulePrototypeDiffCmd.Flags().String("output", "text", "Output format: text or json")

	moduleBriefVersionsCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleBriefVersionsCmd.Flags().String("output", "table", "Output format: table or json")

	moduleBriefDiffCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleBriefDiffCmd.Flags().Int("from", 0, "Older brief version (default: the one below --to)")
	moduleBriefDiffCmd.Flags().Int("to", 0, "Newer brief version (default: current)")
	moduleBriefDiffCmd.Flags().String("output", "text", "Output format: text or json")

	modulePrototypeCmd.AddCommand(modulePrototypeDiffCmd)
	moduleBriefCmd.AddCommand(moduleBriefVersionsCmd)
	moduleBriefCmd.AddCommand(moduleBriefDiffCmd)
}

// ── HTML 抽取（与 packages/views/.../module-feature-stats.ts 同构）─────────

type prototypeAnchor struct {
	Count int    `json:"count"`
	Title string `json:"title,omitempty"`
}

var (
	anchorTagRe   = mustCompile(`(?is)<[a-z][a-z0-9]*\b[^>]*\bdata-fp=["']([^"']+)["'][^>]*>`)
	anchorTitleRe = mustCompile(`(?is)data-title=["']([^"']*)["']`)
	docTitleRe    = mustCompile(`(?is)<title[^>]*>([\s\S]*?)</title>`)
	headingTagRe  = mustCompile(`(?is)<h([1-3])[^>]*>([\s\S]*?)</h[1-3]>`)
	tagStripRe    = mustCompile(`(?is)<[^>]+>`)
	spaceRunRe    = mustCompile(`\s+`)
	scriptRe      = mustCompile(`(?is)<script\b[\s\S]*?</script>`)
	styleRe       = mustCompile(`(?is)<style\b[\s\S]*?</style>`)
	commentRe     = mustCompile(`(?is)<!--[\s\S]*?-->`)
	noscriptRe    = mustCompile(`(?is)<noscript\b[\s\S]*?</noscript>`)
)

func mustCompile(pattern string) *regexp.Regexp { return regexp.MustCompile(pattern) }

// extractPrototypeAnchors 抽 data-fp 锚点：code → {count, title}。
// 服务端的 reconcile 只认这张表，所以「原型有没有标记」在这一步就有结论。
func extractPrototypeAnchors(html string) map[string]prototypeAnchor {
	out := map[string]prototypeAnchor{}
	for _, match := range anchorTagRe.FindAllStringSubmatch(html, -1) {
		code := strings.TrimSpace(match[1])
		if code == "" {
			continue
		}
		entry := out[code]
		entry.Count++
		if entry.Title == "" {
			if title := anchorTitleRe.FindStringSubmatch(match[0]); len(title) > 1 {
				entry.Title = strings.TrimSpace(title[1])
			}
		}
		out[code] = entry
	}
	return out
}

// prototypeVisibleHTML 去脚本/样式/注释：它们的字符串也是「文本」，
// 但那是渲染模板而不是页面区块。
func prototypeVisibleHTML(html string) string {
	html = commentRe.ReplaceAllString(html, " ")
	html = scriptRe.ReplaceAllString(html, " ")
	html = styleRe.ReplaceAllString(html, " ")
	return noscriptRe.ReplaceAllString(html, " ")
}

func prototypeInnerText(html string) string {
	text := tagStripRe.ReplaceAllString(html, " ")
	text = strings.NewReplacer(
		"&nbsp;", " ",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
		"&#039;", "'",
		"&amp;", "&",
	).Replace(text)
	return strings.TrimSpace(spaceRunRe.ReplaceAllString(text, " "))
}

// prototypeDoc 是一次对比所需的全部抽取结果。
type prototypeDoc struct {
	Title    string            `json:"title"`
	Sections []string          `json:"sections"`
	Anchors  map[string]string `json:"anchors"`
	Lines    []string          `json:"-"`
	Bytes    int               `json:"bytes"`
}

// prototypeReadableTitle 与前端 isReadableTitle 同口径：模板插值、HTML 片段和超长句
// 都不是区块名，拿它们做 diff 只会把渲染代码的改动误报成页面结构变化。
func prototypeReadableTitle(text string) bool {
	if text == "" || strings.ContainsAny(text, "<>") {
		return false
	}
	if strings.Contains(text, "${") || strings.Contains(text, "{{") || strings.Contains(text, "}}") {
		return false
	}
	return len([]rune(text)) <= 60
}

func parsePrototypeDoc(html string) prototypeDoc {
	body := prototypeVisibleHTML(html)
	doc := prototypeDoc{
		Anchors: map[string]string{},
		Bytes:   len(html),
	}
	if title := docTitleRe.FindStringSubmatch(body); len(title) > 1 {
		doc.Title = prototypeInnerText(title[1])
	}
	seen := map[string]bool{}
	for _, match := range headingTagRe.FindAllStringSubmatch(body, -1) {
		text := prototypeInnerText(match[2])
		// 模板占位符与超长句不是区块名（与前端 isReadableTitle 同口径）。
		if text == "" || !prototypeReadableTitle(text) {
			continue
		}
		if seen[text] {
			continue
		}
		seen[text] = true
		doc.Sections = append(doc.Sections, text)
	}
	for code, anchor := range extractPrototypeAnchors(body) {
		title := anchor.Title
		if title == "" {
			title = code
		}
		doc.Anchors[code] = title
	}
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimRight(line, " \t\r")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		doc.Lines = append(doc.Lines, trimmed)
	}
	return doc
}

// ── 行级 diff（LCS，与前端 diffHtmlLines 同口径）─────────────────────────

type prototypeDiffLine struct {
	Kind    string `json:"kind"` // same | added | removed
	Text    string `json:"text"`
	LeftNo  int    `json:"left_no,omitempty"`
	RightNo int    `json:"right_no,omitempty"`
}

const prototypeDiffMaxLines = 2000

func diffPrototypeLines(left, right []string) []prototypeDiffLine {
	a := left
	b := right
	if len(a) > prototypeDiffMaxLines {
		a = a[:prototypeDiffMaxLines]
	}
	if len(b) > prototypeDiffMaxLines {
		b = b[:prototypeDiffMaxLines]
	}
	n, m := len(a), len(b)
	// dp[i][j] = LCS(a[i:], b[j:]) 的长度。原型 HTML 通常几百行，内存可接受。
	dp := make([][]uint16, n+1)
	for i := range dp {
		dp[i] = make([]uint16, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
				continue
			}
			if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	out := make([]prototypeDiffLine, 0, n+m)
	i, j := 0, 0
	leftNo, rightNo := 1, 1
	for i < n && j < m {
		if a[i] == b[j] {
			out = append(out, prototypeDiffLine{Kind: "same", Text: a[i], LeftNo: leftNo, RightNo: rightNo})
			i++
			j++
			leftNo++
			rightNo++
			continue
		}
		if dp[i+1][j] >= dp[i][j+1] {
			out = append(out, prototypeDiffLine{Kind: "removed", Text: a[i], LeftNo: leftNo})
			i++
			leftNo++
			continue
		}
		out = append(out, prototypeDiffLine{Kind: "added", Text: b[j], RightNo: rightNo})
		j++
		rightNo++
	}
	for ; i < n; i++ {
		out = append(out, prototypeDiffLine{Kind: "removed", Text: a[i], LeftNo: leftNo})
		leftNo++
	}
	for ; j < m; j++ {
		out = append(out, prototypeDiffLine{Kind: "added", Text: b[j], RightNo: rightNo})
		rightNo++
	}
	return out
}

// prototypeDiffHunk 是一段带上下文的差异窗口。
type prototypeDiffHunk struct {
	Lines []prototypeDiffLine `json:"lines"`
}

// collapsePrototypeDiff 只留变更行与前后 context 行，中间相同行折成窗口间隔。
func collapsePrototypeDiff(lines []prototypeDiffLine, context int) []prototypeDiffHunk {
	if context < 0 {
		context = 0
	}
	keep := make([]bool, len(lines))
	any := false
	for index, line := range lines {
		if line.Kind == "same" {
			continue
		}
		any = true
		from := index - context
		if from < 0 {
			from = 0
		}
		to := index + context
		if to >= len(lines) {
			to = len(lines) - 1
		}
		for k := from; k <= to; k++ {
			keep[k] = true
		}
	}
	if !any {
		return nil
	}
	var hunks []prototypeDiffHunk
	var current prototypeDiffHunk
	for index, line := range lines {
		if !keep[index] {
			if len(current.Lines) > 0 {
				hunks = append(hunks, current)
				current = prototypeDiffHunk{}
			}
			continue
		}
		current.Lines = append(current.Lines, line)
	}
	if len(current.Lines) > 0 {
		hunks = append(hunks, current)
	}
	return hunks
}

// ── 对比结果 ────────────────────────────────────────────────────────────

type prototypeVersionRef struct {
	Version int32  `json:"version"`
	Status  string `json:"status"`
	Owner   string `json:"owner,omitempty"`
	Path    string `json:"html_path"`
	File    string `json:"file"`
	Bytes   int    `json:"bytes"`
	Title   string `json:"title,omitempty"`
}

type prototypeAnchorRename struct {
	Code string `json:"code"`
	From string `json:"from"`
	To   string `json:"to"`
}

type prototypeDiffResult struct {
	Module          string                  `json:"module"`
	From            prototypeVersionRef     `json:"from"`
	To              prototypeVersionRef     `json:"to"`
	SectionsAdded   []string                `json:"sections_added"`
	SectionsRemoved []string                `json:"sections_removed"`
	SectionsMoved   []string                `json:"sections_reordered"`
	AnchorsAdded    []string                `json:"anchors_added"`
	AnchorsRemoved  []string                `json:"anchors_removed"`
	AnchorsRetitled []prototypeAnchorRename `json:"anchors_retitled"`
	LinesAdded      int                     `json:"lines_added"`
	LinesRemoved    int                     `json:"lines_removed"`
	Hunks           []prototypeDiffHunk     `json:"hunks,omitempty"`
	Headline        string                  `json:"headline"`
}

func comparePrototypeDocs(from, to prototypeDoc, module string, fromRef, toRef prototypeVersionRef) prototypeDiffResult {
	result := prototypeDiffResult{Module: module, From: fromRef, To: toRef}

	fromSections := make(map[string]int, len(from.Sections))
	for index, title := range from.Sections {
		fromSections[title] = index
	}
	toSections := make(map[string]int, len(to.Sections))
	for index, title := range to.Sections {
		toSections[title] = index
	}
	for _, title := range to.Sections {
		if _, ok := fromSections[title]; !ok {
			result.SectionsAdded = append(result.SectionsAdded, title)
		}
	}
	for _, title := range from.Sections {
		if _, ok := toSections[title]; !ok {
			result.SectionsRemoved = append(result.SectionsRemoved, title)
		}
	}
	for title := range fromSections {
		if toIndex, ok := toSections[title]; ok && toIndex != fromSections[title] {
			result.SectionsMoved = append(result.SectionsMoved, title)
		}
	}
	sort.Strings(result.SectionsMoved)

	for code, title := range to.Anchors {
		old, ok := from.Anchors[code]
		switch {
		case !ok:
			result.AnchorsAdded = append(result.AnchorsAdded, code)
		case old != title:
			result.AnchorsRetitled = append(result.AnchorsRetitled, prototypeAnchorRename{Code: code, From: old, To: title})
		}
	}
	for code := range from.Anchors {
		if _, ok := to.Anchors[code]; !ok {
			result.AnchorsRemoved = append(result.AnchorsRemoved, code)
		}
	}
	sort.Strings(result.AnchorsAdded)
	sort.Strings(result.AnchorsRemoved)
	sort.Slice(result.AnchorsRetitled, func(i, j int) bool { return result.AnchorsRetitled[i].Code < result.AnchorsRetitled[j].Code })

	lines := diffPrototypeLines(from.Lines, to.Lines)
	for _, line := range lines {
		switch line.Kind {
		case "added":
			result.LinesAdded++
		case "removed":
			result.LinesRemoved++
		}
	}
	result.Headline = prototypeDiffHeadline(result)
	return result
}

func prototypeDiffHeadline(result prototypeDiffResult) string {
	parts := make([]string, 0, 4)
	if n := len(result.SectionsAdded); n > 0 {
		parts = append(parts, fmt.Sprintf("新增 %d 个区块", n))
	}
	if n := len(result.SectionsRemoved); n > 0 {
		parts = append(parts, fmt.Sprintf("删除 %d 个区块", n))
	}
	if n := len(result.AnchorsAdded); n > 0 {
		parts = append(parts, fmt.Sprintf("新增 %d 个功能点锚点", n))
	}
	if n := len(result.AnchorsRemoved); n > 0 {
		parts = append(parts, fmt.Sprintf("删除 %d 个功能点锚点", n))
	}
	if n := len(result.AnchorsRetitled); n > 0 {
		parts = append(parts, fmt.Sprintf("%d 个锚点改标题", n))
	}
	if len(parts) == 0 {
		parts = append(parts, "没有区块或锚点变化")
	}
	return fmt.Sprintf("%s；正文 +%d −%d 行", strings.Join(parts, "、"), result.LinesAdded, result.LinesRemoved)
}

// ── 命令实现 ────────────────────────────────────────────────────────────

func runModulePrototypeDiff(cmd *cobra.Command, args []string) error {
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
	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return err
	}
	if len(timeline.Versions) == 0 {
		return fmt.Errorf("module %q has no prototype versions yet", module.Name)
	}

	wantTo, _ := cmd.Flags().GetInt("to")
	wantFrom, _ := cmd.Flags().GetInt("from")
	to := pickModulePrototypeVersion(timeline.Versions, wantTo)
	if wantTo == 0 && timeline.Canonical != nil {
		for index := range timeline.Versions {
			if int(timeline.Versions[index].Version) == int(*timeline.Canonical) {
				to = &timeline.Versions[index]
				break
			}
		}
	}
	if to == nil {
		return fmt.Errorf("no prototype version v%d; available: %s", wantTo, joinVersionList(timeline.Versions))
	}
	from := pickModulePrototypeVersion(timeline.Versions, wantFrom)
	if wantFrom == 0 {
		previous := previousVersion(timeline.Versions, to.Version)
		from = pickModulePrototypeVersion(timeline.Versions, previous)
	}
	if from == nil {
		return fmt.Errorf("no prototype version v%d to compare against; available: %s", wantFrom, joinVersionList(timeline.Versions))
	}
	if from.Version == to.Version {
		return fmt.Errorf("nothing to compare: both sides are v%d; pass --from or --to", to.Version)
	}

	fromDoc, fromRef, err := loadPrototypeDoc(module, *from)
	if err != nil {
		return err
	}
	toDoc, toRef, err := loadPrototypeDoc(module, *to)
	if err != nil {
		return err
	}
	result := comparePrototypeDocs(fromDoc, toDoc, module.Name, fromRef, toRef)
	contextLines, _ := cmd.Flags().GetInt("context")
	result.Hunks = collapsePrototypeDiff(diffPrototypeLines(fromDoc.Lines, toDoc.Lines), contextLines)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), result)
	}
	printPrototypeDiff(cmd, result)
	return nil
}

// loadPrototypeDoc 读某一版的原型文件并抽出对比用结构。
func loadPrototypeDoc(module moduleRecord, version modulePrototypeVersion) (prototypeDoc, prototypeVersionRef, error) {
	ref := prototypeVersionRef{
		Version: version.Version,
		Status:  version.Status,
		Owner:   version.Owner,
		Path:    version.HtmlPath,
	}
	abs, candidates := resolveModulePrototypePath(version.HtmlPath)
	if abs == "" {
		return prototypeDoc{}, ref, fmt.Errorf(
			"prototype file of %s v%d is not on this machine.\n  html_path: %s\ntried:\n  %s\nRun `multica module prototype list %s` and compare two versions that still have a file.",
			module.Name, version.Version, version.HtmlPath, strings.Join(candidates, "\n  "), displayID(module.ID, true))
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return prototypeDoc{}, ref, fmt.Errorf("read prototype file %s: %w", abs, err)
	}
	doc := parsePrototypeDoc(string(data))
	ref.File = abs
	ref.Bytes = doc.Bytes
	ref.Title = doc.Title
	return doc, ref, nil
}

func printPrototypeDiff(cmd *cobra.Command, result prototypeDiffResult) {
	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "Module: %s\n", result.Module)
	fmt.Fprintf(out, "From:   v%d (%s) %s\n", result.From.Version, statusOrUnknown(result.From.Status), result.From.Path)
	fmt.Fprintf(out, "To:     v%d (%s) %s\n", result.To.Version, statusOrUnknown(result.To.Status), result.To.Path)
	fmt.Fprintf(out, "Summary: %s\n", result.Headline)

	if len(result.SectionsAdded)+len(result.SectionsRemoved)+len(result.SectionsMoved) > 0 {
		fmt.Fprintln(out, "\nSections:")
		for _, title := range result.SectionsAdded {
			fmt.Fprintf(out, "  + %s\n", title)
		}
		for _, title := range result.SectionsRemoved {
			fmt.Fprintf(out, "  - %s\n", title)
		}
		for _, title := range result.SectionsMoved {
			fmt.Fprintf(out, "  ~ %s (order changed)\n", title)
		}
	}
	if len(result.AnchorsAdded)+len(result.AnchorsRemoved)+len(result.AnchorsRetitled) > 0 {
		fmt.Fprintln(out, "\nAnchors:")
		for _, code := range result.AnchorsAdded {
			fmt.Fprintf(out, "  + %s\n", code)
		}
		for _, code := range result.AnchorsRemoved {
			fmt.Fprintf(out, "  - %s\n", code)
		}
		for _, rename := range result.AnchorsRetitled {
			fmt.Fprintf(out, "  ~ %s  %q → %q\n", rename.Code, rename.From, rename.To)
		}
	}

	maxLines, _ := cmd.Flags().GetInt("max-lines")
	if maxLines <= 0 || len(result.Hunks) == 0 {
		return
	}
	fmt.Fprintln(out, "\nText preview:")
	printed := 0
	for index, hunk := range result.Hunks {
		if index > 0 {
			fmt.Fprintln(out, "  …")
		}
		for _, line := range hunk.Lines {
			if printed >= maxLines {
				fmt.Fprintln(out, "  … (truncated; raise --max-lines or use --output json)")
				return
			}
			printed++
			fmt.Fprintf(out, "  %s\n", formatPrototypeDiffLine(line))
		}
	}
}

func formatPrototypeDiffLine(line prototypeDiffLine) string {
	switch line.Kind {
	case "added":
		return fmt.Sprintf("+ %-4d %s", line.RightNo, line.Text)
	case "removed":
		return fmt.Sprintf("- %-4d %s", line.LeftNo, line.Text)
	default:
		return fmt.Sprintf("  %-4d %s", line.RightNo, line.Text)
	}
}

// ── 说明（brief）版本记录与对比 ──────────────────────────────────────────

type moduleBriefChange struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Scope string `json:"scope"`
	Op    string `json:"op"`
	From  any    `json:"from"`
	To    any    `json:"to"`
}

type moduleBriefVersionEntry struct {
	Version       int32               `json:"version"`
	BaseVersion   *int32              `json:"base_version"`
	Status        string              `json:"status"`
	Source        string              `json:"source"`
	DiffSummary   string              `json:"diff_summary"`
	Changes       []moduleBriefChange `json:"changes"`
	CreatedByType string              `json:"created_by_type"`
	CreatedAt     string              `json:"created_at"`
}

type moduleWorkspaceSnapshot struct {
	ModuleID       string                    `json:"module_id"`
	Name           string                    `json:"name"`
	SpecVersion    int32                     `json:"spec_version"`
	Brief          map[string]any            `json:"brief"`
	FeatureCount   int                       `json:"feature_count"`
	Versions       []moduleBriefVersionEntry `json:"versions"`
	Releases       []map[string]any          `json:"releases"`
	Canonical      *int32                    `json:"canonical_prototype_version"`
	BriefVersion   *int32                    `json:"brief_version"`
	ReleaseVersion *int32                    `json:"release_version"`
}

func fetchModuleWorkspace(ctx context.Context, client *cli.APIClient, module moduleRecord) (moduleWorkspaceSnapshot, error) {
	var out moduleWorkspaceSnapshot
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/workspace"), &out)); err != nil {
		return out, fmt.Errorf("get module workspace: %w", err)
	}
	return out, nil
}

func runModuleBriefVersions(cmd *cobra.Command, args []string) error {
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
	workspace, err := fetchModuleWorkspace(ctx, client, module)
	if err != nil {
		return err
	}
	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"module_id":     workspace.ModuleID,
			"brief_version": workspace.BriefVersion,
			"versions":      workspace.Versions,
			"releases":      workspace.Releases,
		})
	}
	if len(workspace.Versions) == 0 {
		fmt.Printf("Module %q has no brief versions yet.\n", module.Name)
		fmt.Fprintf(os.Stderr, "Write the first field with `multica module brief patch %s --base-version 0 --field brief.goal=\"...\"`.\n", displayID(module.ID, true))
		return nil
	}
	rows := make([][]string, 0, len(workspace.Versions))
	for _, version := range workspace.Versions {
		by := version.CreatedByType
		if by == "" {
			by = "-"
		}
		summary := version.DiffSummary
		if summary == "" {
			summary = "-"
		}
		rows = append(rows, []string{
			fmt.Sprintf("v%d", version.Version),
			version.Source,
			by,
			fmt.Sprintf("%d", len(version.Changes)),
			summary,
			version.CreatedAt,
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"VERSION", "SOURCE", "BY", "CHANGED", "SUMMARY", "CREATED"}, rows)
	fmt.Fprintf(cmd.OutOrStdout(), "\nCurrent brief version: %s\n", intPtrText(workspace.BriefVersion))
	return nil
}

func runModuleBriefDiff(cmd *cobra.Command, args []string) error {
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
	workspace, err := fetchModuleWorkspace(ctx, client, module)
	if err != nil {
		return err
	}
	if len(workspace.Versions) == 0 {
		return fmt.Errorf("module %q has no brief versions yet", module.Name)
	}

	to, _ := cmd.Flags().GetInt("to")
	if to == 0 && workspace.BriefVersion != nil {
		to = int(*workspace.BriefVersion)
	}
	if to == 0 {
		to = int(workspace.Versions[0].Version)
	}
	from, _ := cmd.Flags().GetInt("from")
	if from == 0 {
		smallest := to
		for _, version := range workspace.Versions {
			if int(version.Version) < smallest {
				smallest = int(version.Version)
			}
		}
		from = smallest - 1
		if from < 0 {
			from = 0
		}
	}
	if from >= to {
		return fmt.Errorf("--from (%d) must be lower than --to (%d)", from, to)
	}

	type fieldChange struct {
		Label string `json:"label"`
		Scope string `json:"scope"`
		From  any    `json:"from"`
		To    any    `json:"to"`
	}
	window := make([]moduleBriefVersionEntry, 0, len(workspace.Versions))
	for _, version := range workspace.Versions {
		if int(version.Version) > from && int(version.Version) <= to {
			window = append(window, version)
		}
	}
	if len(window) == 0 {
		return fmt.Errorf("no brief version in (%d, %d]; run `multica module brief versions %s` to see the record", from, to, displayID(module.ID, true))
	}
	sort.Slice(window, func(i, j int) bool { return window[i].Version < window[j].Version })

	fields := map[string]*fieldChange{}
	for _, version := range window {
		for _, change := range version.Changes {
			entry, ok := fields[change.Key]
			if !ok {
				entry = &fieldChange{Label: change.Label, Scope: change.Scope, From: change.From}
				fields[change.Key] = entry
			}
			if entry.Label == "" {
				entry.Label = change.Label
			}
			entry.To = change.To
		}
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	if output, _ := cmd.Flags().GetString("output"); output == "json" {
		rows := make([]map[string]any, 0, len(keys))
		for _, key := range keys {
			entry := fields[key]
			rows = append(rows, map[string]any{
				"key": key, "label": entry.Label, "scope": entry.Scope,
				"from": entry.From, "to": entry.To,
			})
		}
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
			"module_id":  workspace.ModuleID,
			"from":       from,
			"to":         to,
			"versions":   len(window),
			"field_diff": rows,
		})
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Module: %s\n", module.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "Range:  brief v%d → v%d (%d patch(es))\n", from, to, len(window))
	if len(keys) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No field changed in this range.")
		return nil
	}
	rows := make([][]string, 0, len(keys))
	for _, key := range keys {
		entry := fields[key]
		label := entry.Label
		if label == "" {
			label = key
		}
		rows = append(rows, []string{
			key,
			label,
			truncateCell(formatFieldValue(entry.From), 48),
			truncateCell(formatFieldValue(entry.To), 48),
		})
	}
	cli.PrintTable(cmd.OutOrStdout(), []string{"FIELD", "LABEL", "FROM", "TO"}, rows)
	return nil
}

func formatFieldValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "(empty)"
	case string:
		if strings.TrimSpace(typed) == "" {
			return "(empty)"
		}
		return typed
	default:
		raw, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprintf("%v", typed)
		}
		return string(raw)
	}
}

func intPtrText(value *int32) string {
	if value == nil {
		return "none"
	}
	return fmt.Sprintf("v%d", *value)
}

// previousVersion 返回比给定版本小的最近一个版本号（没有则返回 0）。
func previousVersion(versions []modulePrototypeVersion, current int32) int {
	best := 0
	for _, version := range versions {
		if int(version.Version) < int(current) && int(version.Version) > best {
			best = int(version.Version)
		}
	}
	return best
}

// requirementHint 在「模块还没有原型」时补一句需求入口：有需求的模块，
// 原型常常挂在需求上，agent 不该只看到模块级空态。
func requirementHint(issues []moduleIssue) string {
	if len(issues) == 0 {
		return ""
	}
	return fmt.Sprintf("\nThis module has requirements (%s); a prototype registered there also shows up here.", joinIssueKeys(issues))
}
