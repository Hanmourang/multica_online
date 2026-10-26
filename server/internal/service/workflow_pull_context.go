// 工作流阶段 push→pull 上下文组装（plan 101 P3，Agent W-Orch）。
//
// 目标：auto 阶段派发时不再把大块资产正文内联进 prompt comment，而是附一段**紧凑指针**
// ——issue/project/stage 作用域 id + 必检资产清单 + multica-assets MCP 拉取指引，让执行
// agent 按需拉取。与 WorkflowAssetGate 配套：门禁保证必检项已就绪，指针告诉 agent 去哪取。
//
// 全程受 workflow_pull_context flag 门控：flag 关闭时 dispatchStage 用原始 prompt，字节级
// 与既有实现一致（零回归）。指针文本由纯函数生成，不触 DB，便于单测锁死格式。
package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// pullContextEnabled 报告 push→pull 上下文组装是否开启。nil flags 视为关闭（零回归）。
func (s *WorkflowService) pullContextEnabled(ctx context.Context) bool {
	return featureflags.WorkflowPullContextEnabled(ctx, s.FeatureFlags)
}

// composePullPointer 在阶段正文后追加一段 pull 指针块。base 为原始 stage prompt
// （可能为空）；issueID/projectID/stageID 为已字符串化的作用域 id；required 为本阶段
// 必检资产名清单（可空）。输出对同一组入参逐字稳定，便于回归与快照比对。
// projectID 为空时省略该行；required 为空时省略 checklist 行。
func composePullPointer(base, issueID, projectID, stageID string, required []string) string {
	var b strings.Builder
	trimmed := strings.TrimRight(base, "\n")
	if trimmed != "" {
		b.WriteString(trimmed)
		b.WriteString("\n\n")
	}
	b.WriteString("<stage-context mode=\"pull\">\n")
	b.WriteString("issue_id: " + issueID + "\n")
	if projectID != "" {
		b.WriteString("project_id: " + projectID + "\n")
	}
	b.WriteString("stage_id: " + stageID + "\n")
	if len(required) > 0 {
		b.WriteString("required_assets: [" + strings.Join(required, ", ") + "]\n")
	}
	b.WriteString("大块资产正文不再内联。请用 multica-assets MCP 工具按需拉取：" +
		"assets_list / assets_search / assets_get_content(bindingId)。")
	b.WriteString("\n</stage-context>")
	return b.String()
}

// pullContextPrompt 依据 flag 组装最终写入 stage prompt comment 的文本：
// 关闭 → 原样返回 base（零回归）；开启 → 追加 pull 指针块。必检清单复用准入解析，
// 指针只列出「需要拉取什么」，不做上游满足判定（那是门禁的职责）。
func (s *WorkflowService) pullContextPrompt(ctx context.Context, base string, issue db.Issue, inst db.WorkflowInstance, stage db.WorkflowStageRun) string {
	if !s.pullContextEnabled(ctx) {
		return base
	}
	required := requiredAssetNames(stage.Inputs)
	return composePullPointer(
		base,
		util.UUIDToString(issue.ID),
		util.UUIDToString(inst.ProjectID),
		util.UUIDToString(stage.ID),
		required,
	)
}

// defaultStagePrompt 生成缺省阶段正文（未配置 prompt 时），与既有内联文案逐字一致。
func defaultStagePrompt(name, instID string) string {
	return fmt.Sprintf("[workflow] 执行阶段「%s」（实例 %s）。", name, instID)
}
