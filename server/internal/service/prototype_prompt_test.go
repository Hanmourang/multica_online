// 原型提示词组装（spec: 2026-09-04-requirement-calendar-design.md §8 原型师行 +
// 画面 4 提示词卡片）：固定模板五段〔需求〕〔目标〕〔仓库〕〔产出〕〔风格〕；
// 重新生成时把 verdict='no' 且带修正诉求（note 非空）的标记项追加为〔本轮修正〕段。
// 本测试覆盖：五段齐备、修正段条件追加、note 为空的 ✗ 不回流、产出路径 slug。
package service

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func prototypeIssue() db.Issue {
	return db.Issue{
		Title:       "退款流程异步化改造",
		Description: pgtype.Text{String: "现有退款为同步阻塞调用，大促期间拖垮支付链路。", Valid: true},
		Goal:        pgtype.Text{String: "退款处理时长 P99 30min → 5min；对账差异率保持 0", Valid: true},
	}
}

func TestAssemblePrototypePrompt(t *testing.T) {
	const outputPath = "docs/prototypes/SIRI-29-refund-async.html"

	t.Run("assembles the fixed five segments", func(t *testing.T) {
		prompt := AssemblePrototypePrompt(prototypeIssue(), "payments-service.git", outputPath, "", nil)
		for _, seg := range []string{"〔需求〕", "〔目标〕", "〔仓库〕", "〔产出〕", "〔风格〕"} {
			if !strings.Contains(prompt, seg) {
				t.Fatalf("prompt missing segment %s:\n%s", seg, prompt)
			}
		}
		if !strings.Contains(prompt, "退款流程异步化改造") {
			t.Fatalf("prompt missing requirement title:\n%s", prompt)
		}
		if !strings.Contains(prompt, "P99 30min → 5min") {
			t.Fatalf("prompt missing goal:\n%s", prompt)
		}
		if !strings.Contains(prompt, "payments-service.git") {
			t.Fatalf("prompt missing repo label:\n%s", prompt)
		}
		if !strings.Contains(prompt, outputPath) {
			t.Fatalf("prompt missing output path %s:\n%s", outputPath, prompt)
		}
		// 无标记时不得出现修正段。
		if strings.Contains(prompt, "\n\n〔本轮修正〕") {
			t.Fatalf("prompt must not contain 〔本轮修正〕 without no-marks:\n%s", prompt)
		}
	})

	t.Run("no-verdict marks with notes append the correction segment", func(t *testing.T) {
		marks := []PrototypeMark{
			{DetailID: "d1", Verdict: "ok"},
			{DetailID: "d3", Verdict: "no", Note: "进度条太粗"},
			{DetailID: "d4", Verdict: "pending"},
		}
		prompt := AssemblePrototypePrompt(prototypeIssue(), "payments-service.git", outputPath, "", marks)
		if !strings.Contains(prompt, "\n\n〔本轮修正〕") {
			t.Fatalf("prompt missing 〔本轮修正〕 segment:\n%s", prompt)
		}
		if !strings.Contains(prompt, "进度条太粗") {
			t.Fatalf("correction segment missing the note text:\n%s", prompt)
		}
	})

	t.Run("all-ok marks produce no correction segment", func(t *testing.T) {
		marks := []PrototypeMark{
			{DetailID: "d1", Verdict: "ok"},
			{DetailID: "d2", Verdict: "ok", Note: "不错"},
		}
		prompt := AssemblePrototypePrompt(prototypeIssue(), "payments-service.git", outputPath, "", marks)
		if strings.Contains(prompt, "\n\n〔本轮修正〕") {
			t.Fatalf("all-ok marks must not produce 〔本轮修正〕:\n%s", prompt)
		}
	})

	t.Run("a no-mark without a note does not flow back", func(t *testing.T) {
		marks := []PrototypeMark{
			{DetailID: "d3", Verdict: "no", Note: ""},
		}
		prompt := AssemblePrototypePrompt(prototypeIssue(), "payments-service.git", outputPath, "", marks)
		if strings.Contains(prompt, "\n\n〔本轮修正〕") {
			t.Fatalf("note-less ✗ must not produce 〔本轮修正〕:\n%s", prompt)
		}
	})

	t.Run("extra prompt append is included verbatim", func(t *testing.T) {
		prompt := AssemblePrototypePrompt(prototypeIssue(), "payments-service.git", outputPath, "主色换成品牌蓝", nil)
		if !strings.Contains(prompt, "主色换成品牌蓝") {
			t.Fatalf("prompt missing the appended segment:\n%s", prompt)
		}
	})
}

func TestPrototypeOutputPath(t *testing.T) {
	cases := []struct {
		identifier, title, want string
	}{
		{"SIRI-29", "Refund Async Flow", "docs/prototypes/SIRI-29-refund-async-flow.html"},
		{"MUL-123", "积分体系重构", "docs/prototypes/MUL-123-积分体系重构.html"},
		{"MUL-7", "  ", "docs/prototypes/MUL-7-prototype.html"},
	}
	for _, c := range cases {
		if got := PrototypeOutputPath(c.identifier, c.title); got != c.want {
			t.Errorf("PrototypeOutputPath(%q, %q) = %q, want %q", c.identifier, c.title, got, c.want)
		}
	}
}
