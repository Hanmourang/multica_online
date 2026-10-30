package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/prototypeimport"
)

// 「更新一个模块」的真实入口。
//
// 一次改造要同时知道五样东西：模块本体、已发布规格里的功能点、右栏说明哪儿还空着、
// 权威原型是哪一版且正文到底在哪、以及 spec 功能点与原型锚点的对账现状。过去这要
// 五次调用（module get / spec get / brief get / prototype list / prototype read），
// 少做一次就开始猜——猜文件在哪、猜版本号、猜该调哪个工具。本命令把它们合成一次
// 只读快照，并把下一步命令直接写出来。
var moduleContextCmd = &cobra.Command{
	Use:   "context <module>",
	Short: "One read-only snapshot for updating a module (spec, gaps, prototype, next steps)",
	Long: `Everything an update needs, in one call:

  - module identity + spec_version / brief_version / canonical prototype version
  - every feature of the published spec with its detail fill state (filled/total)
  - which brief.* fields are still blank
  - the canonical prototype and where its bytes actually live
    (local file / attachment storage / unreadable — never guess a path)
  - reconcile coverage of spec features against the prototype's data-fp anchors
  - next_commands: the exact commands for whatever is still missing

Read-only: writes stay behind brief patch / prototype upload / plan apply.

  multica module context <module>
  multica module context <module> --version 3`,
	Args: exactArgs(1),
	RunE: runModuleContext,
}

func init() {
	moduleContextCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleContextCmd.Flags().Int("version", 0, "Prototype version to inspect (default: confirmed, else newest)")
	moduleContextCmd.Flags().String("output", "json", "Output format: table or json")
}

// moduleContextFeature 是一个功能点的填充度摘要：detail 里哪几段还是空的。
type moduleContextFeature struct {
	Code            string   `json:"code"`
	Title           string   `json:"title"`
	Kind            string   `json:"kind"`
	Filled          int      `json:"filled"`
	Total           int      `json:"total"`
	Missing         []string `json:"missing,omitempty"`
	AcceptanceOK    int      `json:"acceptance_ok"`
	AcceptanceTotal int      `json:"acceptance_total"`
}

// featureDetailSegments 与服务端 buildWorkspaceFeatures 的四段同一口径：
// 1 描述/定位、2 细节要求、3 交互/依赖、4 验收标准。
var featureDetailSegments = [][]string{
	{"desc", "loc"},
	{"req"},
	{"interaction", "deps"},
	{"acceptance"},
}

func runModuleContext(cmd *cobra.Command, args []string) error {
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

	// 右栏工作区是功能点 / 说明 / 版本指针的唯一来源，一次拿全。
	var workspace map[string]any
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/workspace"), &workspace)); err != nil {
		return fmt.Errorf("get module workspace: %w", err)
	}

	issues, err := fetchModuleIssues(ctx, client, module.ID)
	if err != nil {
		return fmt.Errorf("list requirements of module %q: %w", module.Name, err)
	}
	timeline, err := fetchModuleTimeline(ctx, client, module, issues)
	if err != nil {
		return err
	}
	requested, _ := cmd.Flags().GetInt("version")
	target := pickModulePrototypeVersion(timeline.Versions, requested)

	proto := moduleContextPrototype(ctx, client, module, target, timeline)
	features := summarizeWorkspaceFeatures(workspace)
	briefGaps := blankBriefKeys(workspace)
	briefVersion := intAt(mapOf(workspace, "brief"), "version")

	// 对账口径只在后端：这里只搬运数字，不自算。
	var reconcile map[string]any
	reconcilePath := moduleScopedPath(module, "/prototype-reconcile")
	if intAt(proto, "version") > 0 {
		reconcilePath += "?version=" + strconv.Itoa(intAt(proto, "version"))
	}
	if err := moduleGateHint(client.GetJSON(ctx, reconcilePath, &reconcile)); err != nil {
		return fmt.Errorf("reconcile module prototype: %w", err)
	}

	next := moduleContextNextCommands(module, proto, features, briefVersion)
	result := map[string]any{
		"module": map[string]any{
			"id":                          module.ID,
			"name":                        module.Name,
			"project_id":                  module.ProjectID,
			"spec_version":                intAt(workspace, "spec_version"),
			"brief_version":               briefVersion,
			"canonical_prototype_version": intAt(workspace, "canonical_prototype_version"),
		},
		"prototype":     proto,
		"features":      features,
		"brief_gaps":    briefGaps,
		"coverage":      mapOf(reconcile, "coverage"),
		"reconcile":     listOf(reconcile, "rows"),
		"next_commands": next,
	}

	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		fmt.Printf("Module:    %s (%s)\n", module.Name, displayID(module.ID, true))
		fmt.Printf("Spec:      v%d · %d features\n", intAt(workspace, "spec_version"), len(features))
		fmt.Printf("Brief:     v%d · %d blank field(s)\n", briefVersion, len(briefGaps))
		if intAt(proto, "version") > 0 {
			fmt.Printf("Prototype: v%d (%s) · %s · %s\n",
				intAt(proto, "version"), strVal(proto, "status"), strVal(proto, "html_path"), strVal(proto, "readable_from"))
		} else {
			fmt.Println("Prototype: none registered yet")
		}
		if coverage := mapOf(reconcile, "coverage"); len(coverage) > 0 {
			fmt.Printf("Coverage:  %d/%d covered · %d missing · %d changed · %d unregistered\n",
				intAt(coverage, "covered"), intAt(coverage, "denominator"),
				intAt(coverage, "missing"), intAt(coverage, "changed"), intAt(coverage, "unregistered"))
		}

		if len(features) > 0 {
			rows := make([][]string, 0, len(features))
			for _, f := range features {
				missing := "-"
				if len(f.Missing) > 0 {
					missing = strings.Join(f.Missing, ",")
				}
				rows = append(rows, []string{
					f.Code,
					truncateCell(f.Title, 28),
					fmt.Sprintf("%d/%d", f.Filled, f.Total),
					fmt.Sprintf("%d/%d", f.AcceptanceOK, f.AcceptanceTotal),
					missing,
				})
			}
			cli.PrintTable(os.Stdout, []string{"CODE", "TITLE", "DETAIL", "ACCEPT", "MISSING"}, rows)
		}
		if len(briefGaps) > 0 {
			fmt.Printf("\nBlank brief fields: %s\n", strings.Join(briefGaps, ", "))
		}
		fmt.Printf("\nNext:\n")
		for _, command := range next {
			fmt.Printf("  %s\n", command)
		}
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), result)
}

// moduleContextPrototype 描述「权威原型是谁、正文在哪」。
//
// 这一块是过去最多弯路的来源：html_path 可能只是一个虚拟路径，磁盘上没有文件。
// 这里如实回答三种来源之一（local / server / unreadable），而不是把路径一丢。
func moduleContextPrototype(ctx context.Context, client *cli.APIClient, module moduleRecord, target *modulePrototypeVersion, timeline modulePrototypeTimeline) map[string]any {
	if target == nil {
		return map[string]any{
			"version":       0,
			"readable_from": "none",
			"note":          "no prototype version yet",
		}
	}
	out := map[string]any{
		"version":   int(target.Version),
		"status":    target.Status,
		"html_path": target.HtmlPath,
		"owner":     target.Owner,
	}
	if target.IssueKey != "" {
		out["issue"] = target.IssueKey
	}
	if timeline.Canonical != nil {
		out["canonical"] = int(*timeline.Canonical)
	}
	ref := displayID(module.ID, true)
	out["read_command"] = fmt.Sprintf("multica module prototype read %s --version %d --raw", ref, target.Version)
	out["out_command"] = fmt.Sprintf("multica module prototype read %s --version %d --out /tmp/%s-v%d.html",
		ref, target.Version, prototypePathSlug(module.Name), target.Version)

	switch {
	case strings.TrimSpace(target.HtmlPath) == "":
		out["readable_from"] = "unreadable"
		out["note"] = "version recorded no html_path"
	case localPrototypeExists(target.HtmlPath):
		out["readable_from"] = "local"
	default:
		artifact, ok := findPrototypeArtifact(ctx, client, module, target.HtmlPath, target.Version)
		if !ok {
			out["readable_from"] = "unreadable"
			out["note"] = "html_path is not on this machine and no archive row with an attachment matches it: upload the bytes with `multica module prototype upload`"
			return out
		}
		out["readable_from"] = "server"
		out["artifact_id"] = artifact.ID
		out["attachment_id"] = artifact.AttachmentID
	}
	return out
}

// localPrototypeExists 只解析路径、不读文件：context 只需要知道「在不在本机」。
func localPrototypeExists(htmlPath string) bool {
	abs, _ := resolveModulePrototypePath(htmlPath)
	if abs != "" {
		return true
	}
	return fileExists(htmlPath)
}

// findPrototypeArtifact 与 loadPrototypeArtifact 同一套匹配，只是不下载正文。
func findPrototypeArtifact(ctx context.Context, client *cli.APIClient, module moduleRecord, htmlPath string, version int32) (prototypeimport.ArtifactRef, bool) {
	refs, err := fetchProjectArtifacts(ctx, client, module.ProjectID, "prototype")
	if err == nil {
		if ref, ok := prototypeimport.MatchArtifact(refs, htmlPath, module.Name, version); ok {
			return ref, true
		}
	}
	if wider, widerErr := fetchProjectArtifacts(ctx, client, module.ProjectID, ""); widerErr == nil && len(wider) > len(refs) {
		if ref, ok := prototypeimport.MatchArtifact(wider, htmlPath, module.Name, version); ok {
			return ref, true
		}
	}
	return prototypeimport.ArtifactRef{}, false
}

// summarizeWorkspaceFeatures 把 /workspace 的 features 收成「哪几段还空着」。
func summarizeWorkspaceFeatures(workspace map[string]any) []moduleContextFeature {
	rows := listOf(workspace, "features")
	out := make([]moduleContextFeature, 0, len(rows))
	for _, raw := range rows {
		row := asMap(raw)
		detail := mapOf(row, "detail")
		missing := make([]string, 0, len(featureDetailSegments))
		for _, segment := range featureDetailSegments {
			present := false
			for _, suffix := range segment {
				if !isBlankValue(detail[suffix]) {
					present = true
					break
				}
			}
			if !present {
				missing = append(missing, segment[0])
			}
		}
		out = append(out, moduleContextFeature{
			Code:            strVal(row, "code"),
			Title:           strVal(row, "title"),
			Kind:            strVal(row, "kind"),
			Filled:          intAt(row, "filled"),
			Total:           intAt(row, "total"),
			Missing:         missing,
			AcceptanceOK:    intAt(row, "acceptance_ok"),
			AcceptanceTotal: intAt(row, "acceptance_total"),
		})
	}
	return out
}

// blankBriefKeys 列出模块说明里还没填写的字段（只读 brief.* 一层，功能点由 features 管）。
func blankBriefKeys(workspace map[string]any) []string {
	fields := mapOf(mapOf(workspace, "brief"), "fields")
	out := make([]string, 0, 8)
	for _, raw := range listOf(workspace, "field_defs") {
		def := asMap(raw)
		if strVal(def, "scope") != "brief" {
			continue
		}
		key := strVal(def, "key")
		if key == "" {
			continue
		}
		if isBlankValue(mapOf(fields, key)["value"]) {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

// moduleContextNextCommands 把「还缺什么」翻译成可直接执行的命令。
func moduleContextNextCommands(module moduleRecord, proto map[string]any, features []moduleContextFeature, briefVersion int) []string {
	ref := displayID(module.ID, true)
	version := intAt(proto, "version")
	out := make([]string, 0, 5)

	switch strVal(proto, "readable_from") {
	case "none":
		out = append(out, fmt.Sprintf("multica module prototype upload %s --file <your.html>   # module has no prototype yet", ref))
	case "unreadable":
		out = append(out, fmt.Sprintf("multica module prototype upload %s --file <your.html> --version %d --replace   # v%d has no readable body", ref, version, version))
	default:
		if command := strVal(proto, "out_command"); command != "" {
			out = append(out, command)
		}
	}

	blank := make([]string, 0, len(features))
	for _, f := range features {
		if f.Filled < f.Total || f.AcceptanceTotal == 0 {
			blank = append(blank, f.Code)
		}
	}
	if len(blank) > 0 {
		out = append(out, fmt.Sprintf("multica module brief patch %s --base-version %d --field fp.%s.desc=\"...\" --note \"补齐功能点详解\"   # incomplete: %s",
			ref, briefVersion, blank[0], strings.Join(blank, ",")))
	}
	if version > 0 {
		out = append(out, fmt.Sprintf("multica module reconcile %s --version %d", ref, version))
	}
	return out
}

// ── JSON map 取值小工具（服务端返回的是无类型的 map）─────────────────────

func asMap(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func mapOf(m map[string]any, key string) map[string]any {
	return asMap(m[key])
}

func listOf(m map[string]any, key string) []any {
	if list, ok := m[key].([]any); ok {
		return list
	}
	return nil
}

func intAt(m map[string]any, key string) int {
	switch typed := m[key].(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case int32:
		return int(typed)
	}
	return 0
}

func isBlankValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	}
	return false
}
