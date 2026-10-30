package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// 模块内容的单条维护：功能点（spec.features[]）的增删改，以及需求归属的挂载/摘除。
//
// 为什么不是「读整份 spec → 改 → publish」就算完：agent 每次自己拼 JSON 时最容易
// 整段覆盖别人的功能点（少写一个字段就是一次静默删除）。下面三条命令在本地做
// 一次 read-modify-write，只动被点名的那一行，其余原样往返；写动作仍然落到同一
// 个 publish 端点（spec_version+1、重建投影、记事件），版本语义与界面完全一致。
var moduleSpecFeatureCmd = &cobra.Command{
	Use:   "feature",
	Short: "Add, update or remove one feature point of the spec",
	Long: `A feature point is one row of module_spec/v1.features. These commands are a
read-modify-write over the published spec, so touching FP-03 cannot drop FP-01.

  multica module spec feature add <module> --code FP-05 --title "群设置" --group 会话
  multica module spec feature update <module> FP-05 --title "群设置（改）"
  multica module spec feature remove <module> FP-05

Every command publishes by default (spec_version+1, projection rebuilt, change
event recorded). --draft stores the result without bumping the version;
--expected-version turns the publish into a compare-and-swap (409 on conflict).

Removing a code also脱掉它的四段详情（fp.<code>.* 仍留在说明版本里，但不再渲染）。
Renaming a code reads as "removed + added" in the reconcile matrix: prefer
--code-new only when the anchor on the prototype changed too.`,
}

var moduleSpecFeatureAddCmd = &cobra.Command{
	Use:   "add <module>",
	Short: "Append one feature point (code must be new)",
	Args:  exactArgs(1),
	RunE:  runModuleSpecFeatureAdd,
}

var moduleSpecFeatureUpdateCmd = &cobra.Command{
	Use:   "update <module> <code>",
	Short: "Change title / kind / priority / group of one feature point",
	Args:  exactArgs(2),
	RunE:  runModuleSpecFeatureUpdate,
}

var moduleSpecFeatureRemoveCmd = &cobra.Command{
	Use:   "remove <module> <code>",
	Short: "Drop one feature point from the spec",
	Args:  exactArgs(2),
	RunE:  runModuleSpecFeatureRemove,
}

var moduleRequirementCmd = &cobra.Command{
	Use:   "requirement",
	Short: "Attach or detach a requirement's ownership of this module",
	Long: `A module groups requirements through issue.module_id. These two commands are
the honest way to move one: they only change that column and print what moved.

  multica module requirement add <module> MUL-123
  multica module requirement remove <module> MUL-123

Adding a task/requirement to a module can change which agents may touch it
(cross-module locks), so state the move before applying it.`,
}

var moduleRequirementAddCmd = &cobra.Command{
	Use:   "add <module> <issue>",
	Short: "Put a requirement (or task) under this module",
	Args:  exactArgs(2),
	RunE:  runModuleRequirementAdd,
}

var moduleRequirementRemoveCmd = &cobra.Command{
	Use:   "remove <module> <issue>",
	Short: "Take a requirement out of this module (module_id = null)",
	Args:  exactArgs(2),
	RunE:  runModuleRequirementRemove,
}

func init() {
	moduleSpecFeatureAddCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleSpecFeatureAddCmd.Flags().String("code", "", "Feature code, e.g. FP-05 (required, unique per module)")
	moduleSpecFeatureAddCmd.Flags().String("title", "", "Feature title (required)")
	moduleSpecFeatureAddCmd.Flags().String("kind", "core", "core | edge")
	moduleSpecFeatureAddCmd.Flags().String("priority", "", "Optional priority label (P0 / P1 / ...)")
	moduleSpecFeatureAddCmd.Flags().String("group", "", "Optional group label shown in the right pane (e.g. 会话)")
	moduleSpecFeatureAddCmd.Flags().String("output", "json", "Output format: table or json")

	for _, cmd := range []*cobra.Command{moduleSpecFeatureUpdateCmd, moduleSpecFeatureRemoveCmd} {
		cmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
		cmd.Flags().String("output", "json", "Output format: table or json")
	}
	moduleSpecFeatureUpdateCmd.Flags().String("title", "", "New title")
	moduleSpecFeatureUpdateCmd.Flags().String("kind", "", "New kind: core | edge")
	moduleSpecFeatureUpdateCmd.Flags().String("priority", "", "New priority label (empty string clears it)")
	moduleSpecFeatureUpdateCmd.Flags().String("group", "", "New group label (empty string clears it)")
	moduleSpecFeatureUpdateCmd.Flags().String("code-new", "", "Rename the code (also rename the prototype anchor to match)")

	for _, cmd := range []*cobra.Command{moduleSpecFeatureAddCmd, moduleSpecFeatureUpdateCmd, moduleSpecFeatureRemoveCmd} {
		cmd.Flags().Int("expected-version", 0, "Only publish when the current spec_version equals this value (409 otherwise)")
		cmd.Flags().Bool("draft", false, "Store the result without bumping spec_version")
	}

	moduleRequirementAddCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleRequirementAddCmd.Flags().String("output", "json", "Output format: json or table")
	moduleRequirementRemoveCmd.Flags().String("project", "", "Project the module belongs to (skips the workspace-wide lookup)")
	moduleRequirementRemoveCmd.Flags().String("output", "json", "Output format: json or table")

	moduleSpecCmd.AddCommand(moduleSpecFeatureCmd)
	moduleSpecFeatureCmd.AddCommand(moduleSpecFeatureAddCmd)
	moduleSpecFeatureCmd.AddCommand(moduleSpecFeatureUpdateCmd)
	moduleSpecFeatureCmd.AddCommand(moduleSpecFeatureRemoveCmd)
	moduleCmd.AddCommand(moduleRequirementCmd)
	moduleRequirementCmd.AddCommand(moduleRequirementAddCmd)
	moduleRequirementCmd.AddCommand(moduleRequirementRemoveCmd)
}

// ── spec 读写 ───────────────────────────────────────────────────────────

type moduleSpecDoc struct {
	Schema   string           `json:"schema"`
	Summary  string           `json:"summary,omitempty"`
	Features []map[string]any `json:"features"`
}

// loadModuleSpecDoc 读回已发布的 spec，并按 map 保留未来新增字段。
func loadModuleSpecDoc(ctx context.Context, client *cli.APIClient, module moduleRecord) (moduleSpecDoc, int32, error) {
	var out struct {
		Spec        json.RawMessage `json:"spec"`
		SpecVersion int32           `json:"spec_version"`
	}
	if err := moduleGateHint(client.GetJSON(ctx, moduleScopedPath(module, "/spec"), &out)); err != nil {
		return moduleSpecDoc{}, 0, fmt.Errorf("get module spec: %w", err)
	}
	doc := moduleSpecDoc{Schema: "module_spec/v1", Features: []map[string]any{}}
	if len(out.Spec) > 0 && string(out.Spec) != "null" {
		if err := json.Unmarshal(out.Spec, &doc); err != nil {
			return moduleSpecDoc{}, 0, fmt.Errorf("stored spec is not readable JSON: %w", err)
		}
	}
	if doc.Schema == "" {
		doc.Schema = "module_spec/v1"
	}
	if doc.Features == nil {
		doc.Features = []map[string]any{}
	}
	return doc, out.SpecVersion, nil
}

func featureCode(feature map[string]any) string {
	code, _ := feature["code"].(string)
	return strings.TrimSpace(code)
}

func findFeatureIndex(doc moduleSpecDoc, code string) int {
	for index, feature := range doc.Features {
		if featureCode(feature) == code {
			return index
		}
	}
	return -1
}

// publishModuleSpecDoc 把改完的 spec 写回：默认 publish，--draft 只存草稿。
func publishModuleSpecDoc(cmd *cobra.Command, client *cli.APIClient, module moduleRecord, doc moduleSpecDoc, version int32, action string, code string) error {
	raw, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode spec: %w", err)
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	draft, _ := cmd.Flags().GetBool("draft")
	path := moduleScopedPath(module, "/spec/publish")
	body := map[string]any{"spec": json.RawMessage(raw)}
	if draft {
		path = moduleScopedPath(module, "/spec/draft")
		body = map[string]any{"spec": json.RawMessage(raw)}
	} else if expected, _ := cmd.Flags().GetInt("expected-version"); expected > 0 {
		body["expected_version"] = expected
	} else {
		body["expected_version"] = version
	}

	var out map[string]any
	if err := moduleGateHint(client.PostJSON(ctx, path, body, &out)); err != nil {
		return fmt.Errorf("%s feature %s: %w (409 = someone else published first; re-read the spec and retry)", action, code, err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		verb := "Published"
		if draft {
			verb = "Drafted"
		}
		fmt.Printf("%s %s with %d feature(s)%s\n", verb, module.Name, len(doc.Features), draftedVersionNote(draft, version, out))
		fmt.Printf("Feature: %s\n", code)
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
		"module_id":     module.ID,
		"action":        action,
		"code":          code,
		"draft":         draft,
		"feature_count": len(doc.Features),
		"result":        out,
	})
}

func draftedVersionNote(draft bool, version int32, out map[string]any) string {
	if draft {
		return " (spec_version unchanged)"
	}
	next, _ := out["spec_version"].(float64)
	if next == 0 {
		return fmt.Sprintf(" (spec_version %d → next)", version)
	}
	return fmt.Sprintf(" (spec_version %d → %.0f)", version, next)
}

func runModuleSpecFeatureAdd(cmd *cobra.Command, args []string) error {
	code := strings.TrimSpace(flagOr(cmd, "code", ""))
	if code == "" {
		return fmt.Errorf("--code is required (e.g. FP-05)")
	}
	title := strings.TrimSpace(flagOr(cmd, "title", ""))
	if title == "" {
		return fmt.Errorf("--title is required")
	}
	kind := strings.TrimSpace(flagOr(cmd, "kind", "core"))
	if kind != "core" && kind != "edge" {
		return fmt.Errorf("--kind must be core or edge")
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
	doc, version, err := loadModuleSpecDoc(ctx, client, module)
	if err != nil {
		return err
	}
	if findFeatureIndex(doc, code) >= 0 {
		return fmt.Errorf("feature %s already exists in %q; use `multica module spec feature update`", code, module.Name)
	}
	feature := map[string]any{"code": code, "title": title, "kind": kind}
	if priority := strings.TrimSpace(flagOr(cmd, "priority", "")); priority != "" {
		feature["priority"] = priority
	}
	if group := strings.TrimSpace(flagOr(cmd, "group", "")); group != "" {
		feature["group"] = group
	}
	doc.Features = append(doc.Features, feature)
	return publishModuleSpecDoc(cmd, client, module, doc, version, "add", code)
}

func runModuleSpecFeatureUpdate(cmd *cobra.Command, args []string) error {
	code := strings.TrimSpace(args[1])
	if code == "" {
		return fmt.Errorf("feature code is required")
	}
	if !cmd.Flags().Changed("title") && !cmd.Flags().Changed("kind") &&
		!cmd.Flags().Changed("priority") && !cmd.Flags().Changed("group") && !cmd.Flags().Changed("code-new") {
		return fmt.Errorf("nothing to update: pass at least one of --title, --kind, --priority, --group, --code-new")
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
	doc, version, err := loadModuleSpecDoc(ctx, client, module)
	if err != nil {
		return err
	}
	index := findFeatureIndex(doc, code)
	if index < 0 {
		codes := make([]string, 0, len(doc.Features))
		for _, feature := range doc.Features {
			codes = append(codes, featureCode(feature))
		}
		return fmt.Errorf("feature %s not found in %q; current codes: %s", code, module.Name, strings.Join(codes, ", "))
	}
	feature := doc.Features[index]
	if cmd.Flags().Changed("title") {
		feature["title"] = strings.TrimSpace(flagOr(cmd, "title", ""))
	}
	if cmd.Flags().Changed("kind") {
		kind := strings.TrimSpace(flagOr(cmd, "kind", ""))
		if kind != "core" && kind != "edge" {
			return fmt.Errorf("--kind must be core or edge")
		}
		feature["kind"] = kind
	}
	if cmd.Flags().Changed("priority") {
		priority := strings.TrimSpace(flagOr(cmd, "priority", ""))
		if priority == "" {
			delete(feature, "priority")
		} else {
			feature["priority"] = priority
		}
	}
	if cmd.Flags().Changed("group") {
		group := strings.TrimSpace(flagOr(cmd, "group", ""))
		if group == "" {
			delete(feature, "group")
		} else {
			feature["group"] = group
		}
	}
	if cmd.Flags().Changed("code-new") {
		next := strings.TrimSpace(flagOr(cmd, "code-new", ""))
		if next == "" {
			return fmt.Errorf("--code-new cannot be empty")
		}
		if existing := findFeatureIndex(doc, next); existing >= 0 && existing != index {
			return fmt.Errorf("feature %s already exists; code must stay unique per module", next)
		}
		feature["code"] = next
		code = next
	}
	doc.Features[index] = feature
	return publishModuleSpecDoc(cmd, client, module, doc, version, "update", code)
}

func runModuleSpecFeatureRemove(cmd *cobra.Command, args []string) error {
	code := strings.TrimSpace(args[1])
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
	doc, version, err := loadModuleSpecDoc(ctx, client, module)
	if err != nil {
		return err
	}
	index := findFeatureIndex(doc, code)
	if index < 0 {
		codes := make([]string, 0, len(doc.Features))
		for _, feature := range doc.Features {
			codes = append(codes, featureCode(feature))
		}
		return fmt.Errorf("feature %s not found in %q; current codes: %s", code, module.Name, strings.Join(codes, ", "))
	}
	doc.Features = append(doc.Features[:index], doc.Features[index+1:]...)
	return publishModuleSpecDoc(cmd, client, module, doc, version, "remove", code)
}

// ── 需求归属 ────────────────────────────────────────────────────────────

func runModuleRequirementAdd(cmd *cobra.Command, args []string) error {
	return setModuleRequirement(cmd, args, true)
}

func runModuleRequirementRemove(cmd *cobra.Command, args []string) error {
	return setModuleRequirement(cmd, args, false)
}

func setModuleRequirement(cmd *cobra.Command, args []string, attach bool) error {
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
	issue, err := resolveIssueRef(ctx, client, args[1])
	if err != nil {
		return fmt.Errorf("resolve requirement: %w", err)
	}

	body := map[string]any{"module_id": module.ID}
	if !attach {
		// null 才是「摘除」；空串会被服务端当成无效 UUID。
		body["module_id"] = nil
	}
	var out map[string]any
	if err := client.PutJSON(ctx, "/api/issues/"+issue.ID, body, &out); err != nil {
		return fmt.Errorf("%s requirement %s: %w", map[bool]string{true: "attach", false: "detach"}[attach], issue.Display, err)
	}
	if output, _ := cmd.Flags().GetString("output"); output == "table" {
		if attach {
			fmt.Printf("%s → module %s\n", issue.Display, module.Name)
		} else {
			fmt.Printf("%s is no longer in module %s\n", issue.Display, module.Name)
		}
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{
		"issue":     issue.Display,
		"module":    module.Name,
		"module_id": module.ID,
		"attached":  attach,
	})
}
