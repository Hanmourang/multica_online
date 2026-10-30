package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/prototypeimport"
)

// 「从原型导入」：把原型里真实画出来的东西搬成功能点清单。
//
// 右栏那个按钮（prototype-inspector 的 useImportFromPrototype）做的就是这件事，
// 但它是浏览器本地读 HTML 的，agent 走 API 时没有等价通路，只能自己拼整份 spec
// ——那正是「少写一行就静默删掉一个功能点」的姿势。这条命令把同一步做成服务端
// 语义相同的读改写：优先 data-fp 锚点（编号与 reconcile 对齐），没有锚点才退到
// h2/h3 区块标题并按 FP-nn 续号。
//
// 它只搬原型上已有的结构，不猜内容：锚点给的 data-title 就是功能点名，区块标题
// 就是分组；读不出来的字段保持为空，留给人工或 brief patch 补齐。
//
// 解析与合并的纯函数放在 internal/prototypeimport：MCP 侧的 modules_spec_import
// 复用同一份实现（那边 HTML 是内联传入的），两个入口不会导出两套编号。
var moduleSpecImportCmd = &cobra.Command{
	Use:   "import <module>",
	Short: "Turn the prototype's data-fp anchors (or section headings) into feature points",
	Long: `Reads one prototype version (or --html-path) and merges what is really on the
page into the published spec:

  data-fp="FP-05" data-title="群设置"  → feature point code FP-05, title 群设置
  an h2/h3 heading when there is no anchor → a new FP-nn in that section's group

Codes already in the spec and titles already present are skipped, so running it
twice imports nothing new. Afterwards the anchor cache is uploaded, which is what
reconcile / coverage read — without it every feature point looks like an empty slot.

  multica module spec import <module> --dry-run     # what would be added
  multica module spec import <module>               # publish + upload anchors
  multica module spec import <module> --version 3 --no-brief

--draft stores the result without bumping spec_version. --no-brief keeps the
模块说明 fields (brief.scope / brief.flow) untouched.`,
	Args: exactArgs(1),
	RunE: runModuleSpecImport,
}

func init() {
	moduleSpecImportCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleSpecImportCmd.Flags().Int("version", 0, "Prototype version to read (default: confirmed, else newest)")
	moduleSpecImportCmd.Flags().String("html-path", "", "Read this HTML file instead of a registered version")
	moduleSpecImportCmd.Flags().Bool("dry-run", false, "Print what would be imported and write nothing")
	moduleSpecImportCmd.Flags().Bool("draft", false, "Store the result as a draft (spec_version unchanged)")
	moduleSpecImportCmd.Flags().Bool("no-brief", false, "Do not fill empty brief.scope / brief.flow from the prototype structure")
	moduleSpecImportCmd.Flags().Bool("no-anchors", false, "Do not upload the anchor cache (reconcile stays empty)")
	moduleSpecImportCmd.Flags().Int("expected-version", 0, "Only publish when the current spec_version equals this value (409 otherwise)")
	moduleSpecImportCmd.Flags().String("output", "json", "Output format: table or json")
	moduleSpecCmd.AddCommand(moduleSpecImportCmd)
}

func runModuleSpecImport(cmd *cobra.Command, args []string) error {
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

	requested, _ := cmd.Flags().GetInt("version")
	htmlPath := strings.TrimSpace(flagOr(cmd, "html-path", ""))
	version := 0
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
				return fmt.Errorf("module %q has no prototype versions yet; register one with `multica module prototype register %s --html-path <file>` or pass --html-path",
					module.Name, displayID(module.ID, true))
			}
			return fmt.Errorf("module %q has no prototype version v%d; available: %s", module.Name, requested, joinVersionList(timeline.Versions))
		}
		version = int(target.Version)
		htmlPath = target.HtmlPath
	}
	// 正文可能在本地，也可能只存在服务端附件里（界面上下载的原型）：导入必须两边都认，
	// 否则 agent 在远端 runtime 里对「已上传」的原型永远只能导空白。
	body, localCandidates, err := loadPrototypeBody(ctx, client, module, htmlPath, int32(version))
	if err != nil {
		if len(localCandidates) > 0 {
			return fmt.Errorf("%w\nlocal candidates tried:\n  %s", err, strings.Join(localCandidates, "\n  "))
		}
		return err
	}
	html := body.HTML
	file := body.Path

	candidates := prototypeimport.Candidates(html)
	if len(candidates) == 0 {
		return fmt.Errorf("no data-fp anchor and no h2/h3 heading found in %s: nothing to import (add data-fp=\"FP-01\" to the blocks you want as feature points)", file)
	}

	doc, specVersion, err := loadModuleSpecDoc(ctx, client, module)
	if err != nil {
		return err
	}
	existing := make([]any, len(doc.Features))
	for index, feature := range doc.Features {
		existing[index] = feature
	}
	added, skipped := prototypeimport.Merge(existing, candidates)

	briefFields, briefVersion, err := importBriefFields(ctx, client, module, html)
	if err != nil {
		return err
	}

	dryRun, _ := cmd.Flags().GetBool("dry-run")
	if len(added) == 0 {
		return reportModuleSpecImport(cmd, module, file, version, added, skipped, briefFields, len(doc.Features), specVersion, specVersion, dryRun)
	}

	doc.Features = append(doc.Features, added...)
	if dryRun {
		return reportModuleSpecImport(cmd, module, file, version, added, skipped, briefFields, len(doc.Features), specVersion, specVersion, dryRun)
	}

	draft, _ := cmd.Flags().GetBool("draft")
	expected, _ := cmd.Flags().GetInt("expected-version")
	if expected <= 0 {
		expected = int(specVersion)
	}
	result, err := postModuleSpecDoc(ctx, client, module, doc, draft, int32(expected))
	if err != nil {
		return fmt.Errorf("publish imported feature points: %w", err)
	}
	// 以服务端回的 spec_version 为准：草稿不涨、发布 +1，拿不到才自己推。
	published := specVersion
	if value, ok := moduleSpecVersionFrom(result); ok {
		published = value
	} else if !draft {
		published = specVersion + 1
	}

	if len(briefFields) > 0 && briefVersion >= 0 {
		body := map[string]any{
			"base_version": briefVersion,
			"fields":       briefFields,
			"source":       "extract",
			"note":         "从原型导入",
		}
		var out map[string]any
		if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, "/workspace/patch"), body, &out)); err != nil {
			// spec 已经写进去了；brief 冲突不该把整个导入判失败，但要如实说出来。
			fmt.Fprintf(os.Stderr, "warn: feature points were imported, but the brief patch failed: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "Brief filled: %d field(s) (%s)\n", len(briefFields), strings.Join(prototypeimport.SortedKeys(briefFields), ", "))
		}
	}

	anchorsUploaded := false
	if version > 0 {
		if noAnchors, _ := cmd.Flags().GetBool("no-anchors"); !noAnchors {
			anchors := prototypeimport.Anchors(html)
			if len(anchors) > 0 {
				body := map[string]any{"anchors": anchors}
				var out map[string]any
				if err := moduleGateHint(client.PostJSON(ctx, moduleScopedPath(module, fmt.Sprintf("/prototype-versions/%d/parse", version)), body, &out)); err != nil {
					fmt.Fprintf(os.Stderr, "warn: feature points were imported, but uploading the anchor cache failed: %v\n", err)
				} else {
					anchorsUploaded = true
				}
			}
		}
	}

	if anchorsUploaded {
		fmt.Fprintln(os.Stderr, "Anchor cache uploaded: reconcile / coverage will see these feature points.")
	}
	return reportModuleSpecImport(cmd, module, file, version, added, skipped, briefFields, len(doc.Features), specVersion, published, dryRun)
}

// reportModuleSpecImport 同时承担 dry-run 的输出：两者形状一致，只差 written 标记。
func reportModuleSpecImport(
	cmd *cobra.Command,
	module moduleRecord,
	file string,
	version int,
	added []map[string]any,
	skipped []map[string]string,
	briefFields map[string]any,
	featureCount int,
	specVersion int32,
	publishedVersion int32,
	dryRun bool,
) error {
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		if dryRun {
			fmt.Println("Dry run: nothing is written.")
		}
		fmt.Printf("Module:  %s\n", module.Name)
		if version > 0 {
			fmt.Printf("Version: v%d\n", version)
		}
		fmt.Printf("File:    %s\n", file)
		fmt.Printf("Added:   %d feature(s)\n", len(added))
		rows := make([][]string, 0, len(added))
		for _, feature := range added {
			code, _ := feature["code"].(string)
			title, _ := feature["title"].(string)
			group, _ := feature["group"].(string)
			rows = append(rows, []string{code, title, group})
		}
		if len(rows) > 0 {
			cli.PrintTable(os.Stdout, []string{"CODE", "TITLE", "GROUP"}, rows)
		}
		for _, skip := range skipped {
			fmt.Printf("Skipped: %s (%s)\n", skip["title"], skip["reason"])
		}
		keys := make([]string, 0, len(briefFields))
		for key := range briefFields {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			fmt.Printf("Brief:   %s\n", key)
		}
		if !dryRun {
			fmt.Printf("Features now: %d · spec_version %d → %s\n", featureCount, specVersion, specVersionLabel(specVersion, publishedVersion, len(added) > 0))
		}
		return nil
	}
	payload := map[string]any{
		"module_id":     module.ID,
		"version":       version,
		"file":          file,
		"dry_run":       dryRun,
		"added":         added,
		"skipped":       skipped,
		"brief_fields":  briefFields,
		"feature_count": featureCount,
		"spec_version":  specVersion,
	}
	if briefWritten := len(briefFields); briefWritten > 0 {
		payload["brief_fields_written"] = briefWritten
	}
	if publishedVersion > specVersion {
		payload["spec_version_after"] = publishedVersion
	}
	return cli.PrintJSON(cmd.OutOrStdout(), payload)
}

// specVersionLabel 只用于表格模式的尾注：没写入就是 unchanged，草稿原地不动，
// 发布会涨到新版本号。
func specVersionLabel(before, after int32, changed bool) string {
	if !changed {
		return fmt.Sprintf("%d (unchanged)", before)
	}
	if after <= before {
		return fmt.Sprintf("%d (draft)", before)
	}
	return fmt.Sprintf("%d", after)
}

// moduleSpecVersionFrom 从 publish 的响应里取回 spec_version。
func moduleSpecVersionFrom(result map[string]any) (int32, bool) {
	raw, ok := result["spec_version"]
	if !ok {
		return 0, false
	}
	switch value := raw.(type) {
	case float64:
		return int32(value), true
	case int:
		return int32(value), true
	case json.Number:
		if n, err := value.Int64(); err == nil {
			return int32(n), true
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
			return int32(n), true
		}
	}
	return 0, false
}

// postModuleSpecDoc 把整份 spec 写回：publish（带乐观锁）或 draft。
func postModuleSpecDoc(ctx context.Context, client *cli.APIClient, module moduleRecord, doc moduleSpecDoc, draft bool, expected int32) (map[string]any, error) {
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("encode spec: %w", err)
	}
	path := moduleScopedPath(module, "/spec/publish")
	body := map[string]any{"spec": json.RawMessage(raw), "expected_version": expected}
	if draft {
		path = moduleScopedPath(module, "/spec/draft")
		body = map[string]any{"spec": json.RawMessage(raw)}
	}
	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, path, body, &out)); err != nil {
		return nil, fmt.Errorf("%w (409 = someone else published first; re-read the spec and retry)", err)
	}
	return out, nil
}

// importBriefFields 只补能从原型结构读出来的字段，且只在字段还是空的时候补。
// 返回 briefVersion = -1 表示没有可补的（或读不到 workspace）。
func importBriefFields(
	ctx context.Context,
	client *cli.APIClient,
	module moduleRecord,
	html string,
) (map[string]any, int, error) {
	sections := prototypeimport.SectionTitles(html)
	flow := prototypeimport.NavFlow(html)
	if len(sections) <= 1 && len(flow) <= 1 {
		return map[string]any{}, -1, nil
	}

	var workspace struct {
		Brief struct {
			Version int `json:"version"`
			Fields  map[string]struct {
				Value any `json:"value"`
			} `json:"fields"`
		} `json:"brief"`
	}
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/workspace"), &workspace)); err != nil {
		return nil, -1, fmt.Errorf("get module workspace: %w", err)
	}
	current := make(map[string]string, len(workspace.Brief.Fields))
	for key, entry := range workspace.Brief.Fields {
		current[key] = prototypeimport.RenderScalar(entry.Value)
	}
	return prototypeimport.BriefFields(sections, flow, current), workspace.Brief.Version, nil
}
