// 工作流阶段 spec 渲染（plan 20261025 §B2，Agent W-Orch）。
//
// 目标：让 authoring 层配置的「阶段目标 / 达成判定 / 输入模板 / 输出模板」真正进入运行期
// ——改造前 Flatten 丢弃这些字段（见 workflow_definition.go §StageSpec 注释），引擎看不到，
// 配置只能存不能跑。本文件负责把快照后的 spec 渲染进 auto 阶段的 prompt 正文。
//
// 三条硬约束：
//  1. 零回归：整段渲染受 workflow_stage_spec flag 门控，关闭时 dispatchStage 的 prompt 字节
//     与改造前逐字一致（旧快照 spec 为 NULL 时同样 no-op）。
//  2. 纯函数可测：renderStageTemplate / composeSpecPrompt 不触 DB、不读 flag，表驱动单测锁死。
//  3. push→pull 一致：${inputs.*} 只替换成**指针文本**（stage_run 引用或资产名），
//     绝不内联资产正文——正文由 multica-assets MCP 按需拉取（见 workflow_pull_context.go）。
//
// 未知占位符策略：保留原文 + 返回 warning 清单（调用方 slog 记录），不静默吞错。
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// stageSpecEnabled 报告阶段 spec 是否参与运行期渲染。nil flags 视为关闭（零回归）。
func (s *WorkflowService) stageSpecEnabled(ctx context.Context) bool {
	return featureflags.WorkflowStageSpecEnabled(ctx, s.FeatureFlags)
}

// StageRenderContext 是渲染 ${...} 占位符所需的最小上下文（全部来自已加载的快照行，
// 不额外触库）。
type StageRenderContext struct {
	// Workitem 提供 ${workitem.<key>}：id / title / number / goal，外加实例创建时
	// workitem_snapshot 里的一层字符串字段（同名覆盖）。
	Workitem map[string]string
	// Inputs 提供 ${inputs.<产物名>}：值是指针文本，不是资产正文。
	Inputs map[string]string
	// AssetsRef 提供 ${project.assets}：项目资产拉取指引；空串视为不可解析。
	AssetsRef string
}

// stagePlaceholder 匹配 ${a.b} 形式的占位符（不允许嵌套花括号）。
var stagePlaceholder = regexp.MustCompile(`\$\{([^{}]+)\}`)

// renderStageTemplate 替换 tpl 中的占位符，返回渲染结果与未解析键清单（去重、保序）。
// 未解析的占位符原样保留，交由调用方记日志——绝不静默删除用户写的模板片段。
func renderStageTemplate(tpl string, rc StageRenderContext) (string, []string) {
	var unknown []string
	seen := map[string]bool{}
	out := stagePlaceholder.ReplaceAllStringFunc(tpl, func(match string) string {
		key := strings.TrimSpace(match[2 : len(match)-1])
		if v, ok := lookupStagePlaceholder(key, rc); ok {
			return v
		}
		if !seen[key] {
			seen[key] = true
			unknown = append(unknown, key)
		}
		return match
	})
	return out, unknown
}

// lookupStagePlaceholder 解析三类命名空间；值缺失（空串/未登记）一律算不可解析。
func lookupStagePlaceholder(key string, rc StageRenderContext) (string, bool) {
	switch {
	case key == "project.assets":
		return nonEmpty(rc.AssetsRef)
	case strings.HasPrefix(key, "workitem."):
		return nonEmpty(rc.Workitem[strings.TrimPrefix(key, "workitem.")])
	case strings.HasPrefix(key, "inputs."):
		return nonEmpty(rc.Inputs[strings.TrimPrefix(key, "inputs.")])
	default:
		return "", false
	}
}

func nonEmpty(v string) (string, bool) {
	return v, v != ""
}

// composeSpecPrompt 把 spec 的四个字段按「阶段目标 → 达成判定 → 输入资产 → 交付要求」
// 顺序追加到阶段正文之后（各段自身也过一遍占位符渲染）。spec 为 nil 时原样返回 base
// （旧快照/未配置阶段的零回归路径）。
func composeSpecPrompt(base string, spec *StageSpec, rc StageRenderContext) (string, []string) {
	if spec == nil {
		return base, nil
	}
	var warnings []string
	var b strings.Builder
	b.WriteString(strings.TrimRight(base, "\n"))
	appendSection := func(title, body string) {
		trimmed := strings.TrimSpace(body)
		if trimmed == "" {
			return
		}
		rendered, unknown := renderStageTemplate(trimmed, rc)
		warnings = append(warnings, unknown...)
		b.WriteString("\n\n## ")
		b.WriteString(title)
		b.WriteString("\n")
		b.WriteString(rendered)
	}
	appendSection("阶段目标", spec.Goal)
	appendSection("达成判定", spec.Criteria)
	appendSection("输入资产", spec.InputTpl)
	appendSection("交付要求", spec.OutputTpl)
	return b.String(), warnings
}

// parseStageSpec 反序列化 stage_run.spec 快照；NULL/非法/全空一律返回 nil（零回归）。
func parseStageSpec(raw []byte) *StageSpec {
	if len(raw) == 0 {
		return nil
	}
	var spec StageSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return nil
	}
	if spec.Goal == "" && spec.Criteria == "" && spec.InputTpl == "" && spec.OutputTpl == "" &&
		spec.LoopLabel == "" && spec.ExitLabel == "" {
		return nil
	}
	return &spec
}

// stageRenderContext 从实例/需求/阶段三张快照行组装渲染上下文（不触库）。
//
// ${inputs.<产物名>} 的指针文本按来源分两类：
//   - 有 fromStageId（上游产物）→ `stage_run:<nodeId>#<outputId>`；
//   - 无 fromStageId（外部资产，原型 role=in 语义）→ `asset:<产物名>`，
//     执行 agent 用 multica-assets MCP 按名在项目资产里定位。
func stageRenderContext(inst db.WorkflowInstance, issue db.Issue, stage db.WorkflowStageRun) StageRenderContext {
	return renderContextOf(RenderInputs{
		ProjectID: util.UUIDToString(inst.ProjectID),
		Inputs:    declaredInputs(stage.Inputs),
		Workitem:  mergeWorkitemFields(baseWorkitem(issue), snapshotStringFields(inst.WorkitemSnapshot)),
	})
}

// RenderInputs 是渲染上下文的可纯构造入参（运行期与 dry-run 预览共用）。
type RenderInputs struct {
	ProjectID string
	Inputs    []DefinitionInput
	Workitem  map[string]string
}

// renderContextOf 组装渲染上下文（不触库）：${inputs.*} 指针文本按来源分两类——
// 有 fromStageId → `stage_run:<nodeId>#<outputId>`；无 → `asset:<产物名>`。
func renderContextOf(in RenderInputs) StageRenderContext {
	inputs := map[string]string{}
	for _, item := range in.Inputs {
		name := assetNameOf(item.OutputName, item.OutputID)
		if name == "" {
			continue
		}
		if item.FromStageID != "" {
			inputs[name] = fmt.Sprintf("stage_run:%s#%s", item.FromStageID, item.OutputID)
		} else {
			inputs[name] = "asset:" + name
		}
	}
	rc := StageRenderContext{Workitem: in.Workitem, Inputs: inputs}
	if rc.Workitem == nil {
		rc.Workitem = map[string]string{}
	}
	if pid := in.ProjectID; pid != "" && !strings.HasPrefix(pid, "00000000") {
		rc.AssetsRef = fmt.Sprintf(
			"项目资产（project_id=%s）：用 multica-assets MCP 的 assets_list / assets_search / assets_get_content(bindingId) 按需拉取",
			pid)
	}
	return rc
}

// baseWorkitem 提供 ${workitem.*} 的四个内置键。
func baseWorkitem(issue db.Issue) map[string]string {
	return map[string]string{
		"id":     util.UUIDToString(issue.ID),
		"title":  issue.Title,
		"number": strconv.FormatInt(int64(issue.Number), 10),
		"goal":   issue.Goal.String,
	}
}

func mergeWorkitemFields(base, extra map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// RenderNodePrompt 把一个扁平节点的 prompt + spec 渲染成最终正文。
//
// 不触库、不入队、不写 comment——与 dispatchStage 共用 composeSpecPrompt，
// 保证「测试运行」预览与真实派发逐字同源（plan 20261025 §C7）。
func RenderNodePrompt(node WorkflowNode, in RenderInputs) (string, []string) {
	base := node.Prompt
	if strings.TrimSpace(base) == "" {
		base = defaultStagePrompt(node.Name, "dry-run")
	}
	return composeSpecPrompt(base, node.Spec, renderContextOf(in))
}

// InputsFromRawNodes 把扁平节点的 inputs（[]any，落库形态）还原成 DefinitionInput。
func InputsFromRawNodes(raw []any) []DefinitionInput {
	if len(raw) == 0 {
		return nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var inputs []DefinitionInput
	if err := json.Unmarshal(b, &inputs); err != nil {
		return nil
	}
	return inputs
}

// declaredInputs 解析 stage_run.inputs（DefinitionInput 列表）；空/非法返回 nil。
func declaredInputs(raw []byte) []DefinitionInput {
	if len(raw) == 0 {
		return nil
	}
	var inputs []DefinitionInput
	if err := json.Unmarshal(raw, &inputs); err != nil {
		return nil
	}
	return inputs
}

// snapshotStringFields 抽取 workitem_snapshot 一层的字符串字段（供 ${workitem.*} 使用）。
// 非字符串值与解析失败一律忽略——快照缺字段是常态，不得因此阻断派发。
func snapshotStringFields(raw []byte) map[string]string {
	out := map[string]string{}
	if len(raw) == 0 {
		return out
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		return out
	}
	for k, v := range fields {
		if s, ok := v.(string); ok && s != "" {
			out[k] = s
		}
	}
	return out
}
