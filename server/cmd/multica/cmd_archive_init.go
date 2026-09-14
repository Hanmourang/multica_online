package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// multica archive init — 按 CONTRACT §2 与 _shared/format/templates 搭项目档案骨架。
// 只写磁盘，不调 server。禁止 overview/prd、overview/mrd、page-navigator。

var archiveInitCmd = &cobra.Command{
	Use:   "init",
	Short: "Scaffold projects/<key> from the shared archive contract",
	RunE:  runArchiveInit,
}

var archiveInitReqCmd = &cobra.Command{
	Use:   "init-req",
	Short: "Scaffold requirements/<REQ-KEY>/requirement.md and stage dirs",
	RunE:  runArchiveInitReq,
}

var archiveProjectKeyRE = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,62}$`)

var archiveForbiddenNames = map[string]bool{
	"page-navigator": true,
	"node_modules":   true,
	"dist":           true,
	"overview":       true,
	"requirements":   true,
	"_shared":        true,
	"_attic":         true,
}

type archiveInitFile struct {
	Rel     string
	Content string
	DirOnly bool
}

func runArchiveInit(cmd *cobra.Command, _ []string) error {
	key := strings.TrimSpace(mustFlagString(cmd, "project"))
	if err := validateArchiveProjectKey(key); err != nil {
		return err
	}
	archiveRoot, err := resolveArchiveRoot(mustFlagString(cmd, "path"))
	if err != nil {
		return err
	}
	name := strings.TrimSpace(mustFlagString(cmd, "name"))
	if name == "" {
		name = key
	}
	withPRD, _ := cmd.Flags().GetBool("with-prd")
	withMRD, _ := cmd.Flags().GetBool("with-mrd")
	force, _ := cmd.Flags().GetBool("force")
	dryRun, _ := cmd.Flags().GetBool("dry-run")

	files, err := planArchiveInit(archiveRoot, key, name, withPRD, withMRD)
	if err != nil {
		return err
	}

	fmt.Printf("档案仓库  %s\n", archiveRoot)
	fmt.Printf("项目骨架  projects/%s%s\n", key, map[bool]string{true: "（dry-run）", false: ""}[dryRun])

	created, skipped := 0, 0
	for _, file := range files {
		abs := filepath.Join(archiveRoot, filepath.FromSlash(file.Rel))
		if file.DirOnly {
			if !dryRun {
				if err := os.MkdirAll(abs, 0o755); err != nil {
					return err
				}
			}
			fmt.Printf("  + dir  %s\n", file.Rel)
			created++
			continue
		}
		exists := false
		if st, err := os.Stat(abs); err == nil && st.Mode().IsRegular() {
			exists = true
		}
		if exists && !force {
			fmt.Printf("  = keep %s\n", file.Rel)
			skipped++
			continue
		}
		if dryRun {
			fmt.Printf("  + file %s\n", file.Rel)
			created++
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(abs, []byte(file.Content), 0o644); err != nil {
			return err
		}
		if exists {
			fmt.Printf("  ~ over %s\n", file.Rel)
		} else {
			fmt.Printf("  + file %s\n", file.Rel)
		}
		created++
	}

	fmt.Printf("➜ 完成 · 写入/创建 %d · 保留已有 %d\n", created, skipped)
	fmt.Printf("下一步：Desktop 绑定 projects/%s ，然后 multica archive sync --project %s\n", key, key)
	return nil
}

func validateArchiveProjectKey(key string) error {
	if key == "" {
		return fmt.Errorf("--project 必填")
	}
	if strings.ContainsAny(key, `/\`) || strings.Contains(key, "..") {
		return fmt.Errorf("非法项目 key：%q", key)
	}
	if archiveForbiddenNames[strings.ToLower(key)] {
		return fmt.Errorf("项目 key 不可为保留名 %q", key)
	}
	if !archiveProjectKeyRE.MatchString(key) {
		return fmt.Errorf("项目 key 须为字母开头的 [A-Za-z0-9_-]，最长 63：%q", key)
	}
	return nil
}

func planArchiveInit(archiveRoot, key, name string, withPRD, withMRD bool) ([]archiveInitFile, error) {
	base := "projects/" + key
	out := []archiveInitFile{
		{Rel: base + "/overview/research", DirOnly: true},
		{Rel: base + "/overview/product-design", DirOnly: true},
		{Rel: base + "/overview/architecture", DirOnly: true},
		{Rel: base + "/overview/retrospective", DirOnly: true},
		{Rel: base + "/requirements", DirOnly: true},
		{Rel: base + "/filing/software-copyright", DirOnly: true},
		{Rel: base + "/filing/patent", DirOnly: true},
		{Rel: base + "/PROJECT.md", Content: renderProjectMD(key, name)},
		{Rel: base + "/overview/architecture/architecture.md", Content: loadSharedTemplate(archiveRoot, "architecture.md", name)},
		{Rel: base + "/overview/research/.gitkeep", Content: ""},
		{Rel: base + "/overview/product-design/.gitkeep", Content: ""},
		{Rel: base + "/overview/retrospective/.gitkeep", Content: ""},
		{Rel: base + "/requirements/.gitkeep", Content: ""},
		{Rel: base + "/filing/software-copyright/.gitkeep", Content: ""},
		{Rel: base + "/filing/patent/.gitkeep", Content: ""},
	}
	if withMRD {
		out = append(out, archiveInitFile{
			Rel:     base + "/overview/research/MRD.md",
			Content: loadSharedTemplate(archiveRoot, "mrd.md", name),
		})
	}
	if withPRD {
		out = append(out, archiveInitFile{
			Rel:     base + "/overview/product-design/PRD.md",
			Content: loadSharedTemplate(archiveRoot, "prd.md", name),
		})
	}
	for _, file := range out {
		if strings.Contains(file.Rel, "/overview/prd/") || strings.Contains(file.Rel, "/overview/mrd/") {
			return nil, fmt.Errorf("禁止生成 overview/prd 或 overview/mrd")
		}
		if strings.Contains(file.Rel, "page-navigator") {
			return nil, fmt.Errorf("禁止生成 page-navigator")
		}
	}
	return out, nil
}

func renderProjectMD(key, name string) string {
	return strings.TrimSpace(fmt.Sprintf(`---
doc_type: project
project_key: %s
title: %s
---

# %s

> 档案根由 `+"`multica archive init`"+` 创建。C2 只认 research / product-design / architecture / retrospective。
> 下一步：Desktop 绑定本目录，然后 `+"`multica archive sync --project %s`"+`。
`, key, name, name, key)) + "\n"
}

func loadSharedTemplate(archiveRoot, filename, title string) string {
	candidates := []string{
		filepath.Join(archiveRoot, "_shared", "format", "templates", filename),
		filepath.Join(archiveRoot, "projects_mgmt", "_shared", "format", "templates", filename),
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		return fillArchiveTemplate(string(data), title)
	}
	if fallback, ok := archiveTemplateFallback[filename]; ok {
		return fillArchiveTemplate(fallback, title)
	}
	return fillArchiveTemplate(archiveTemplateFallback["architecture.md"], title)
}

func fillArchiveTemplate(raw, title string) string {
	if title == "" {
		return raw
	}
	out := raw
	out = strings.Replace(out, "【待填写：技术主题】", title, 2)
	out = strings.Replace(out, "【待填写：PRD 标题】", title, 1)
	out = strings.Replace(out, "【待填写：产品/模块】", title, 1)
	out = strings.Replace(out, "【待填写：MRD 标题】", title, 1)
	out = strings.Replace(out, "【待填写：主题】", title, 1)
	out = strings.Replace(out, "【待填写：功能名】", title, 2)
	return out
}

// 当 --path 下没有 _shared/format/templates 时使用，章节必须与手册同构。
var archiveTemplateFallback = map[string]string{
	"architecture.md": `---
doc_type: architecture
title: 【待填写：技术主题】
version: 1
---

# 技术方案：【待填写：技术主题】

> 放置位置：` + "`projects/<key>/overview/architecture/`" + `（scope=project，无需 multica_issue_id）。
> 项目架构总纲（checklist 必备项）也在本目录。

## 背景与约束

【待填写：业务背景、技术约束（性能/兼容/依赖现状）】

## 方案对比与决策理由

【待填写：候选方案对比表 + 最终选择与理由（为何淘汰其余方案）】

## 架构设计

【待填写：模块划分、数据流、关键接口、存储设计】

## 影响面

【待填写：受影响的模块/功能/数据；风险点与等级】

## 回退策略

【待填写：出问题时的回退步骤与降级方案】
`,
	"prd.md": `---
doc_type: product-design
doc_class: prd
title: 【待填写：PRD 标题】
version: 1
---

# PRD：【待填写：产品/模块】

> **项目级**放置：` + "`projects/<key>/overview/product-design/`" + `（本文默认）。
> **需求级**不要用这份当正本：去写 ` + "`requirements/<REQ-KEY>/requirement.md`" + `，并设 ` + "`doc_class: prd`" + `，用 ` + "`related`" + ` 指回总 PRD。
> ` + "`doc_type`" + ` 必须是 ` + "`product-design`" + `；禁止建 ` + "`overview/prd/`" + `。

## 目标与场景

【待填写：问题、用户、核心场景】

## 范围

| 做 | 不做 |
|---|---|
|  |  |

## 用户动线

【待填写：从进入到完成的步骤】

## 界面与规则

【待填写：页面/状态/权限】

## 验收要点

【待填写：可判定；需求级应落到该 REQ 的 ` + "`acceptance.md`" + `】

## 边界与异常

【待填写】
`,
	"mrd.md": `---
doc_type: research
doc_class: mrd
title: 【待填写：MRD 标题】
version: 1
---

# MRD：【待填写：主题】

> 放置：` + "`projects/<key>/overview/research/`" + `。` + "`doc_type`" + ` 必须是 ` + "`research`" + `（C2 调研卡）；` + "`doc_class: mrd`" + ` 仅供检索。
> 禁止建 ` + "`overview/mrd/`" + `。

## 结论先行

【待填写：做不做、服务谁、为什么是现在】

## 市场与用户

【待填写：细分、规模、竞品、证据】

## 机会与非目标

【待填写：要抓住的机会；明确不做什么】

## 成功指标

【待填写：可度量】

## 遗留问题

【待填写】
`,
}

func runArchiveInitReq(cmd *cobra.Command, _ []string) error {
	projectKey, _ := cmd.Flags().GetString("project")
	root, _ := cmd.Flags().GetString("path")
	key, _ := cmd.Flags().GetString("key")
	issueID, _ := cmd.Flags().GetString("issue")
	title, _ := cmd.Flags().GetString("title")
	force, _ := cmd.Flags().GetBool("force")
	if strings.TrimSpace(projectKey) == "" {
		return fmt.Errorf("--project is required")
	}
	if root == "" {
		root = filepath.Join("projects_mgmt", "projects", projectKey)
	}
	if key == "" {
		key = nextArchiveRequirementKey(root, time.Now().Format("20060102"))
	}
	if !regexp.MustCompile(`^REQ-\d{8}-\d{2,}$`).MatchString(key) {
		return fmt.Errorf("invalid requirement key %q (want REQ-YYYYMMDD-NN)", key)
	}
	if title == "" {
		title = key
	}
	reqRoot := filepath.Join(root, "requirements", key)
	stages := []string{"s1-prototype", "s2-plan", "s3-execution", "s4-acceptance"}
	for _, s := range stages {
		if err := os.MkdirAll(filepath.Join(reqRoot, s), 0o755); err != nil {
			return err
		}
	}
	target := filepath.Join(reqRoot, "requirement.md")
	if _, err := os.Stat(target); err == nil && !force {
		return fmt.Errorf("%s already exists (use --force)", target)
	}
	issueLine := ""
	if strings.TrimSpace(issueID) != "" {
		issueLine = "\nmultica_issue_id: " + strings.TrimSpace(issueID)
	}
	body := fmt.Sprintf(`---
doc_type: requirement
doc_class: prd
title: %s%s
---

# %s

## 背景

【待填写】

## 目标

【待填写】

## 范围

【待填写】

## 验收标准

【待填写】
`, title, issueLine, title)
	if err := os.WriteFile(target, []byte(body), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "wrote %s\n", target)
	return nil
}

func nextArchiveRequirementKey(root, day string) string {
	max := 0
	entries, err := os.ReadDir(filepath.Join(root, "requirements"))
	if err != nil {
		return "REQ-" + day + "-01"
	}
	prefix := "REQ-" + day + "-"
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		n, convErr := strconv.Atoi(strings.TrimPrefix(e.Name(), prefix))
		if convErr == nil && n > max {
			max = n
		}
	}
	return fmt.Sprintf("REQ-%s-%02d", day, max+1)
}
