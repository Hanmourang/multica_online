// Package prototypeimport 把「原型上真实画出来的东西」抽成功能点清单。
//
// 同一份解析口径服务两个入口，且必须逐条同结果：
//
//   - CLI `multica module spec import`：读本地 HTML 文件（agent 机器上）。
//   - MCP `modules_spec_import`：HTML 内联传入——服务端读不到 agent 的文件，
//     所以只能把正文一起传上来。
//
// 两个入口对同一份原型导出不同的编号是实现缺陷：reconcile 按 code 精确匹配，
// 编号一偏就是满屏「空位」。所以这里只放纯函数，不碰 HTTP、数据库与时钟。
package prototypeimport

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 抽取用的正则。与 packages/views/.../module-feature-stats.ts 同构：
// 前端算出来的锚点缓存与服务端导入的候选必须是同一批区块。
var (
	anchorTagRe   = regexp.MustCompile(`(?is)<[a-z][a-z0-9]*\b[^>]*\bdata-fp=["']([^"']+)["'][^>]*>`)
	anchorTitleRe = regexp.MustCompile(`(?is)data-title=["']([^"']*)["']`)
	headingTagRe  = regexp.MustCompile(`(?is)<h([1-3])[^>]*>([\s\S]*?)</h[1-3]>`)
	tagStripRe    = regexp.MustCompile(`(?is)<[^>]+>`)
	spaceRunRe    = regexp.MustCompile(`\s+`)
	scriptRe      = regexp.MustCompile(`(?is)<script\b[\s\S]*?</script>`)
	styleRe       = regexp.MustCompile(`(?is)<style\b[\s\S]*?</style>`)
	commentRe     = regexp.MustCompile(`(?is)<!--[\s\S]*?-->`)
	noscriptRe    = regexp.MustCompile(`(?is)<noscript\b[\s\S]*?</noscript>`)

	navBlockRe   = regexp.MustCompile(`(?is)<nav\b[\s\S]*?</nav>`)
	anchorLinkRe = regexp.MustCompile(`(?is)<a\b[^>]*>([\s\S]*?)</a>`)
	// 行内标签（加粗、高亮）在图上是连着的字，去掉时不能补空格，
	// 否则「群<span>设置</span>」会变成「群 设置」，与原型上看到的名字不一致。
	inlineTagRe = regexp.MustCompile(`(?is)</?(span|b|strong|i|em|code|small|sub|sup|br)\b[^>]*>`)

	htmlEscapes = strings.NewReplacer(
		"&nbsp;", " ", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&#039;", "'", "&amp;", "&",
	)
)

// Candidate 是原型里「长得像功能点」的一块。
type Candidate struct {
	// Code 只在 data-fp 分支有值：那就是原型自己声明的编号，必须原样落到 spec，
	// 否则 reconcile 按 code 精确匹配会对不上。
	Code  string
	Title string
	Group string
	// Section 为真时表示这是一个 h2 区块标题：只做分组，不单独成为功能点。
	Section bool
}

// Anchor 是 data-fp 锚点的缓存行，与 handler 侧 service.ProtoAnchor 同一形状
// （POST /prototype-versions/{version}/parse 的 body）。
type Anchor struct {
	Count int    `json:"count"`
	Title string `json:"title,omitempty"`
}

// Anchors 抽 data-fp 锚点：code → {count, title}。输入按传入原样处理——
// 两个既有调用方（diff 用去脚本后的 body、prototype parse 用原始 html）行为不变。
func Anchors(html string) map[string]Anchor {
	out := map[string]Anchor{}
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

// VisibleHTML 去掉脚本、样式、注释与 noscript：它们里面的字符串也是「文本」，
// 但那是渲染模板而不是页面区块。
func VisibleHTML(html string) string {
	html = commentRe.ReplaceAllString(html, " ")
	html = scriptRe.ReplaceAllString(html, " ")
	html = styleRe.ReplaceAllString(html, " ")
	return noscriptRe.ReplaceAllString(html, " ")
}

// CleanText 把一段 HTML 压成单行文本。
func CleanText(raw string) string {
	text := inlineTagRe.ReplaceAllString(raw, "")
	text = tagStripRe.ReplaceAllString(text, " ")
	text = htmlEscapes.Replace(text)
	return strings.TrimSpace(spaceRunRe.ReplaceAllString(text, " "))
}

// Candidates 按出现顺序抽候选功能点。
// 有锚点就只用锚点（标题优先 data-title）；一个锚点都没有才退到 h2/h3 区块。
func Candidates(html string) []Candidate {
	body := VisibleHTML(html)
	if anchors := anchorRows(body); len(anchors) > 0 {
		return anchors
	}
	return headingRows(body)
}

// anchorRows 保序抽 data-fp（正则 FindAll 保序，map 不保序，故不复用 Anchors）。
func anchorRows(body string) []Candidate {
	var out []Candidate
	seen := map[string]bool{}
	for _, match := range anchorTagRe.FindAllStringSubmatch(body, -1) {
		code := strings.TrimSpace(match[1])
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		title := ""
		if titleMatch := anchorTitleRe.FindStringSubmatch(match[0]); len(titleMatch) > 1 {
			title = CleanText(titleMatch[1])
		}
		if title == "" {
			title = code
		}
		out = append(out, Candidate{Code: code, Title: title})
	}
	return out
}

// headingRows 把 h2 当分组、h3 当条目；h1 是页面大标题，不是功能点。
func headingRows(body string) []Candidate {
	var out []Candidate
	group := ""
	for _, match := range headingTagRe.FindAllStringSubmatch(body, -1) {
		level := match[1]
		title := CleanText(match[2])
		if title == "" {
			continue
		}
		switch level {
		case "2":
			out = append(out, Candidate{Title: title, Section: true})
			group = title
		case "3":
			out = append(out, Candidate{Title: title, Group: group})
		}
	}
	return out
}

// NavFlow 抽导航栏顺序（保序去重），用来补 brief.flow。
func NavFlow(html string) []string {
	var out []string
	seen := map[string]bool{}
	for _, nav := range navBlockRe.FindAllString(VisibleHTML(html), -1) {
		for _, link := range anchorLinkRe.FindAllStringSubmatch(nav, -1) {
			text := CleanText(link[1])
			if text == "" || seen[text] {
				continue
			}
			seen[text] = true
			out = append(out, text)
		}
	}
	return out
}

// SectionTitles 读 h2 区块名。锚点路径下候选里没有 Section（只报锚点），
// 所以 brief.scope 的素材得单独从标题里抽。
func SectionTitles(html string) []string {
	var out []string
	seen := map[string]bool{}
	for _, match := range headingTagRe.FindAllStringSubmatch(VisibleHTML(html), -1) {
		if match[1] != "2" {
			continue
		}
		title := CleanText(match[2])
		if title == "" || seen[title] {
			continue
		}
		seen[title] = true
		out = append(out, title)
	}
	return out
}

// Sequence 取已有序号的最大尾号（"FP-07" → 7，"fp.graph.list" → 0）。
func Sequence(codes []string) int {
	max := 0
	for _, code := range codes {
		idx := len(code)
		for idx > 0 && code[idx-1] >= '0' && code[idx-1] <= '9' {
			idx--
		}
		if idx == len(code) {
			continue
		}
		if n, err := strconv.Atoi(code[idx:]); err == nil && n > max {
			max = n
		}
	}
	return max
}

// FormatCode 与前端 formatFeatureCode 同一形状：FP-01、FP-101。
func FormatCode(sequence int) string {
	return fmt.Sprintf("FP-%02d", sequence)
}

// Merge 把候选并入已有功能点列表。
//
// 两条去重规则同时生效：编号已存在就跳过（锚点路径），标题已存在就跳过（区块
// 标题路径）。所以同一份原型跑两次，第二次什么也不新增——这正是「从原型导入」
// 可重复调用的前提。
//
// existing 直接吃 spec["features"] 解码后的 []any，未知字段原样保留在每个
// feature 里（本函数只读 code / title，不重建行）。
func Merge(existing []any, candidates []Candidate) (added []map[string]any, skipped []map[string]string) {
	codes := make([]string, 0, len(existing))
	titles := map[string]bool{}
	used := map[string]bool{}
	for _, row := range existing {
		feature, ok := row.(map[string]any)
		if !ok {
			continue
		}
		code, _ := feature["code"].(string)
		code = strings.TrimSpace(code)
		codes = append(codes, code)
		used[code] = true
		if title, _ := feature["title"].(string); strings.TrimSpace(title) != "" {
			titles[strings.ToLower(strings.TrimSpace(title))] = true
		}
	}

	added = make([]map[string]any, 0, len(candidates))
	skipped = make([]map[string]string, 0)
	sequence := Sequence(codes)
	nextCode := func() string {
		for {
			sequence++
			code := FormatCode(sequence)
			if !used[code] {
				used[code] = true
				return code
			}
		}
	}
	for _, candidate := range candidates {
		if candidate.Section {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(candidate.Title))
		if key == "" {
			continue
		}
		if titles[key] {
			skipped = append(skipped, map[string]string{"title": candidate.Title, "reason": "title already in the spec"})
			continue
		}
		code := strings.TrimSpace(candidate.Code)
		if code != "" && used[code] {
			skipped = append(skipped, map[string]string{"code": code, "title": candidate.Title, "reason": "code already in the spec"})
			continue
		}
		if code == "" {
			code = nextCode()
		} else {
			used[code] = true
		}
		feature := map[string]any{"code": code, "title": candidate.Title, "kind": "core"}
		if candidate.Group != "" {
			feature["group"] = candidate.Group
		}
		added = append(added, feature)
		titles[key] = true
	}
	return added, skipped
}

// BriefFields 用原型的区块与导航顺序合成 brief.scope（A · B · C）与 brief.flow
// （A → B → C）。current 是这两个字段当前已渲染的值（RenderScalar），只有空着的
// 才补——导入不该覆盖人写过的说明。
func BriefFields(sections, flow []string, current map[string]string) map[string]any {
	fields := map[string]any{}
	blank := func(key string) bool { return strings.TrimSpace(current[key]) == "" }
	if len(sections) > 1 && blank("brief.scope") {
		fields["brief.scope"] = strings.Join(sections[:min(len(sections), 12)], " · ")
	}
	if len(flow) > 1 && blank("brief.flow") {
		fields["brief.flow"] = strings.Join(flow[:min(len(flow), 12)], " → ")
	}
	return fields
}

// RenderScalar 判断一个 brief 字段值「是不是已经有内容」，口径与右栏一致。
func RenderScalar(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := RenderScalar(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "、")
	case map[string]any:
		if text, ok := typed["text"].(string); ok {
			return text
		}
		// 结构体值兜底用 JSON 原文：那正是右栏展开后看到的形状。
		raw, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(raw)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// SortedKeys 给提示文案用，保输出可读。
func SortedKeys(fields map[string]any) []string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
