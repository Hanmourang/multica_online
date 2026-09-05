// 原型提示词组装（spec: 2026-09-04-requirement-calendar-design.md §8 原型师行 +
// 画面 4 提示词卡片）：固定模板五段〔需求〕〔目标〕〔仓库〕〔产出〕〔风格〕；
// 重新生成时把 verdict='no' 且带修正诉求（note 非空）的标记项追加为〔本轮修正〕段。
// 「○ 待定」与 note 为空的 ✗ 不回流——✗ 须先填修正诉求（画面 4 标注 5）。
package service

import (
	"fmt"
	"strings"
	"unicode"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// PrototypeMark 是原型版本上的一条实现细节标记（issue_prototype_version.marks
// JSONB 的元素形状）：detail_id 对应原型里逐屏列出的细节序号，verdict 三态
// ok / no / pending，note 为 ✗ 时用户填写的修正诉求。
type PrototypeMark struct {
	DetailID string `json:"detail_id"`
	Verdict  string `json:"verdict"`
	Note     string `json:"note"`
}

// AssemblePrototypePrompt 组装一键生成原型的完整提示词（画面 4 右侧只读卡片
// 的同一份文本，随版本行落库）。extra 为请求体可携带的 prompt 追加段，
// 非空时原样附在最后。
func AssemblePrototypePrompt(issue db.Issue, repoLabel, outputPath, extra string, marks []PrototypeMark) string {
	var b strings.Builder

	b.WriteString("〔需求〕")
	b.WriteString(issue.Title)
	if issue.Description.Valid && strings.TrimSpace(issue.Description.String) != "" {
		b.WriteString("\n")
		b.WriteString(strings.TrimSpace(issue.Description.String))
	}

	b.WriteString("\n\n〔目标〕")
	if issue.Goal.Valid && strings.TrimSpace(issue.Goal.String) != "" {
		b.WriteString(strings.TrimSpace(issue.Goal.String))
	} else {
		b.WriteString("（未填写目标，按需求描述理解）")
	}

	b.WriteString("\n\n〔仓库〕")
	if repoLabel != "" {
		fmt.Fprintf(&b, "%s —— 先读现有页面结构与 API 契约，原型不得改动对外字段", repoLabel)
	} else {
		b.WriteString("（未指定仓库，按通用 Web 应用处理）")
	}

	fmt.Fprintf(&b, "\n\n〔产出〕单文件 HTML 原型 → %s，并逐屏列出实现细节供用户标记", outputPath)
	b.WriteString("\n\n〔风格〕沿用业务仓现有设计 token，不引入新组件库")

	var corrections []string
	for _, m := range marks {
		if m.Verdict != "no" || strings.TrimSpace(m.Note) == "" {
			continue
		}
		corrections = append(corrections, fmt.Sprintf("%s：%s", m.DetailID, strings.TrimSpace(m.Note)))
	}
	if len(corrections) > 0 {
		b.WriteString("\n\n〔本轮修正〕")
		b.WriteString(strings.Join(corrections, "；"))
	}

	if strings.TrimSpace(extra) != "" {
		b.WriteString("\n\n")
		b.WriteString(strings.TrimSpace(extra))
	}
	return b.String()
}

// PrototypeOutputPath 计算原型 HTML 在业务仓内的约定路径
// docs/prototypes/<KEY>-<slug>.html（spec §5.3）。slug 由标题派生：小写字母/
// 数字/CJK 表意文字保留，其余折叠为连字符；空标题兜底 "prototype"。
func PrototypeOutputPath(identifier, title string) string {
	return "docs/prototypes/" + identifier + "-" + slugifyTitle(title) + ".html"
}

const prototypeSlugMaxRunes = 48

func slugifyTitle(title string) string {
	var b strings.Builder
	lastDash := false
	runes := 0
	for _, r := range strings.ToLower(strings.TrimSpace(title)) {
		if runes >= prototypeSlugMaxRunes {
			break
		}
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) ||
			unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
		if ok {
			b.WriteRune(r)
			lastDash = false
			runes++
			continue
		}
		if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		return "prototype"
	}
	return slug
}
