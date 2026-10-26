package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// multica archive sync — 档案同步 CLI（spec: 2026-09-05-project-archive-design.md
// §8 Phase 2；原型 #f2）。管道五阶段：扫描 → 路径契约解析（projects_mgmt/CONTRACT.md
// §1）→ blob_sha 差量上传 → 全量清单 POST /projects/{id}/artifacts/sync → 分阶段
// 诊断上报 /archive/sync-diagnostics（migration 461）。
//
// 不变量（CONTRACT.md §0/§4）：
//   - server 只见全量清单；增量/全量的差异只在扫描端（incremental 复用 server 已知
//     blob_sha 跳过未变文件的重哈希，清单仍是全量，purge 语义安全）。
//   - 失败项不阻塞其余入库，逐条进 sync_diagnostics。
//   - 写回优先于改库：source='manual' 的行由 server 侧保护，CLI 不需要感知。

var archiveCmd = &cobra.Command{
	Use:   "archive",
	Short: "Init and sync the projects_mgmt document archive into multica",
}

var archiveSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Scan the archive repo and sync artifact manifests to the server",
	RunE:  runArchiveSync,
}

func init() {
	archiveSyncCmd.Flags().String("project", "", "only sync the given project key (default: all projects found in the archive)")
	archiveSyncCmd.Flags().String("path", "", "archive repo root (default: MULTICA_ARCHIVE_ROOT or ~/Documents/workspace/projects_mgmt)")
	archiveSyncCmd.Flags().String("mode", "manual", "incremental (reuse server-known blob_sha for git-clean files) | full | manual (= full)")
	archiveSyncCmd.Flags().Bool("dry-run", false, "scan and parse only; print the manifest without uploading or syncing")
	archiveInitCmd.Flags().String("project", "", "project key to scaffold (required; must match projects.yaml key)")
	archiveInitCmd.Flags().String("path", "", "archive repo root (default: MULTICA_ARCHIVE_ROOT or ~/Documents/workspace/projects_mgmt)")
	archiveInitCmd.Flags().String("name", "", "display name written into PROJECT.md (default: --project)")
	archiveInitCmd.Flags().Bool("with-prd", false, "also write overview/product-design/PRD.md from the shared template")
	archiveInitCmd.Flags().Bool("with-mrd", false, "also write overview/research/MRD.md from the shared template")
	archiveInitCmd.Flags().Bool("force", false, "overwrite existing scaffold files")
	archiveInitCmd.Flags().Bool("dry-run", false, "print the files that would be written")
	archiveInitReqCmd.Flags().String("project", "", "project key (required)")
	archiveInitReqCmd.Flags().String("path", "", "archive repo root")
	archiveInitReqCmd.Flags().String("key", "", "REQ-YYYYMMDD-NN (default: next for today)")
	archiveInitReqCmd.Flags().String("issue", "", "multica issue id written into frontmatter")
	archiveInitReqCmd.Flags().String("title", "", "requirement title")
	archiveInitReqCmd.Flags().Bool("force", false, "overwrite existing requirement.md")
	archiveCmd.AddCommand(archiveSyncCmd)
	archiveCmd.AddCommand(archiveInitCmd)
	archiveCmd.AddCommand(archiveInitReqCmd)
	rootCmd.AddCommand(archiveCmd)
}

func resolveArchiveRoot(explicit string) (string, error) {
	archiveRoot := explicit
	if archiveRoot == "" {
		archiveRoot = os.Getenv("MULTICA_ARCHIVE_ROOT")
	}
	if archiveRoot == "" {
		home, _ := os.UserHomeDir()
		archiveRoot = filepath.Join(home, "Documents", "workspace", "projects_mgmt")
	}
	if st, err := os.Stat(archiveRoot); err != nil || !st.IsDir() {
		return "", fmt.Errorf("档案仓库根不存在: %s（用 --path 或 MULTICA_ARCHIVE_ROOT 指定）", archiveRoot)
	}
	return archiveRoot, nil
}

func mustFlagString(cmd *cobra.Command, name string) string {
	value, _ := cmd.Flags().GetString(name)
	return value
}

// ── 路径契约解析（CONTRACT.md §1，纯函数，cmd_archive_test.go 锁死）─────────────

// archiveParsedFile 是一个通过契约解析的档案文件。
type archiveParsedFile struct {
	AbsPath        string
	RelPath        string // 相对档案根，斜杠分隔
	ProjectKey     string
	Scope          string // shared | project | requirement
	Stage          *int32
	DocType        string
	Version        int32
	RequirementKey string
	IssueID        string // frontmatter multica_issue_id（可空）
	SizeBytes      int64
	BlobSha        string
	AttachmentID   string
}

// archiveParseError 表示契约违规（拒绝入库，进 diagnostics）。
type archiveParseError struct{ reason string }

func (e *archiveParseError) Error() string { return e.reason }

// parseArchiveRelPath 按 CONTRACT.md §1 规则表解析相对路径。
// 返回 ok=false + *archiveParseError 表示契约违规（如 stage 越界）。
func parseArchiveRelPath(rel string) (*archiveParsedFile, error) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 2 {
		return nil, &archiveParseError{"路径过浅，不在任何契约目录内（CONTRACT.md §1 行1）"}
	}
	p := &archiveParsedFile{RelPath: filepath.ToSlash(rel), Version: 1}

	switch parts[0] {
	case "_attic":
		return nil, &archiveParseError{"_attic 硬跳过不索引（CONTRACT.md §1 行7）"}
	case "_shared":
		p.Scope = "shared"
		p.ProjectKey = "" // 归「个人档案库」，由调用方按配置解析
	case "change_logs":
		if err := parseChangeLogs(p, parts[1:]); err != nil {
			return nil, err
		}
	case "projects":
		if len(parts) < 3 {
			return nil, &archiveParseError{"projects/ 下缺项目目录（CONTRACT.md §1 行1）"}
		}
		p.ProjectKey = parts[1]
		rest := parts[2:]
		if len(rest) == 1 && strings.EqualFold(rest[0], "PROJECT.md") {
			p.Scope = "project"
			p.DocType = "project"
			break
		}
		if err := parseProjectScoped(p, rest); err != nil {
			return nil, err
		}
	default:
		return nil, &archiveParseError{"一级目录不在契约内：" + parts[0] + "（CONTRACT.md §1 行1/7）"}
	}
	return p, nil
}

// parseProjectScoped 解析 projects/<key>/ 之下的部分：overview / requirements / filing。
func parseProjectScoped(p *archiveParsedFile, rest []string) error {
	switch rest[0] {
	case "overview":
		// overview/<cat>/… → scope=project, stage=NULL（CONTRACT.md §1 行2）
		if len(rest) < 3 {
			return &archiveParseError{"overview/ 下缺类别目录（CONTRACT.md §1 行2）"}
		}
		cat := rest[1]
		switch cat {
		case "research", "product-design", "architecture", "retrospective", "iteration":
		default:
			return &archiveParseError{"未知 overview 类别 " + cat + "（CONTRACT.md §1 行2）"}
		}
		p.Scope = "project"
		p.DocType = cat
	case "requirements":
		// requirements/<REQ-KEY>/… → scope=requirement（CONTRACT.md §1 行3）
		if len(rest) < 3 {
			return &archiveParseError{"requirements/ 下缺 REQ-KEY 目录（CONTRACT.md §1 行3）"}
		}
		key := rest[1]
		if !validRequirementKey(key) {
			return &archiveParseError{"非法 requirement_key " + key + "，须为 REQ-YYYYMMDD-NN（CONTRACT.md §1 行3）"}
		}
		p.Scope = "requirement"
		p.RequirementKey = key
		// s<N>-<slug>/ → stage（CONTRACT.md §1 行4）；缺省不报错（阶段可选）
		if len(rest) >= 4 {
			if stage, ok := parseStageDir(rest[2]); ok {
				p.Stage = &stage
			} else if strings.HasPrefix(rest[2], "s") {
				return &archiveParseError{"未知 stage 目录 " + rest[2] + "，stage 必须 ∈ 1..5（CONTRACT.md §1 行4）"}
			}
		}
	case "filing":
		// filing/<cat>/… → doc_type=filing-<cat>（CONTRACT.md §1 行6）
		if len(rest) < 3 {
			return &archiveParseError{"filing/ 下缺类别目录（CONTRACT.md §1 行6）"}
		}
		cat := rest[1]
		switch cat {
		case "software-copyright", "patent":
		default:
			return &archiveParseError{"未知 filing 类别 " + cat + "（CONTRACT.md §1 行6）"}
		}
		p.Scope = "project"
		p.DocType = "filing-" + cat
	case "change_logs":
		return parseChangeLogs(p, rest[1:])
	default:
		return &archiveParseError{"projects/" + p.ProjectKey + "/ 下未知目录 " + rest[0] + "（CONTRACT.md §2）"}
	}
	return nil
}

var changeLogSkipDirs = map[string]bool{
	"qoder_backup":   true,
	"db_backups":     true,
	"wiki_snapshots": true,
}

// parseChangeLogs 解析工作区或项目内的 change_logs 树。
// 变更日志 / 工作计划不是 S2 阶段门文档：stage 恒为空，doc_type 为 change-log 或 work-plan。
func parseChangeLogs(p *archiveParsedFile, rest []string) error {
	for _, part := range rest {
		if changeLogSkipDirs[part] {
			return &archiveParseError{"change_logs 备份区硬跳过不索引（CONTRACT.md §1 行8）"}
		}
	}
	if len(rest) == 0 {
		p.Scope = "project"
		p.DocType = "change-log"
		return nil
	}
	head := rest[0]
	switch head {
	case "0.overview":
		p.Scope = "shared"
		p.DocType = "change-log"
		return nil
	case "qoder-plans":
		p.Scope = "project"
		if p.ProjectKey == "" {
			p.ProjectKey = "qoder-plans"
		}
		p.DocType = "work-plan"
		return nil
	case "daily_logs":
		p.Scope = "project"
		p.DocType = "change-log"
		return nil
	}
	if p.ProjectKey == "" {
		p.ProjectKey = head
	}
	p.Scope = "project"
	p.DocType = changeLogDocType(rest)
	return nil
}

func changeLogDocType(parts []string) string {
	joined := strings.ToLower(strings.Join(parts, "/"))
	if strings.Contains(joined, "qoder-plans") || strings.Contains(joined, "/plans/") {
		return "work-plan"
	}
	if strings.HasSuffix(joined, ".html") {
		return "prototype"
	}
	return "change-log"
}

// validRequirementKey 校验 REQ-YYYYMMDD-NN。
func validRequirementKey(key string) bool {
	segs := strings.Split(key, "-")
	if len(segs) != 3 || segs[0] != "REQ" || len(segs[1]) != 8 {
		return false
	}
	if _, err := strconv.Atoi(segs[1]); err != nil {
		return false
	}
	if _, err := strconv.Atoi(segs[2]); err != nil {
		return false
	}
	return true
}

// parseStageDir 解析 s<N>-<slug>；ok=false 表示不是 stage 目录或 N 越界。
func parseStageDir(seg string) (int32, bool) {
	if len(seg) < 2 || seg[0] != 's' {
		return 0, false
	}
	n := int(seg[1] - '0')
	if n < 1 || n > 5 || (len(seg) > 2 && seg[2] != '-') {
		return 0, false
	}
	return int32(n), true
}

// docTypeFromName 由文件名/阶段推导 doc_type（frontmatter 可覆盖）。
// 优先级：basename 命中已知类型 > stage 默认 > overview/filing 已定值。
func docTypeFromName(p *archiveParsedFile) string {
	rel := strings.ToLower(filepath.ToSlash(p.RelPath))
	if strings.Contains(rel, "change_logs/") || strings.Contains(rel, "/daily_logs/") {
		if p.DocType != "" {
			return p.DocType
		}
		return changeLogDocType(strings.Split(rel, "/"))
	}
	base := strings.ToLower(filepath.Base(p.RelPath))
	base = strings.TrimSuffix(base, filepath.Ext(base))
	// 去版本后缀（v2 / -r2），再匹配。
	if v := versionFromName(base); v > 1 {
		base = strings.TrimSuffix(strings.TrimSuffix(base, fmt.Sprintf("v%d", v)), fmt.Sprintf("-r%d", v))
		base = strings.TrimSuffix(base, "-")
	}
	known := map[string]string{
		"prototype": "prototype", "plan": "plan", "decomposition": "decomposition",
		"design": "design", "test-plan": "test-plan", "testplan": "test-plan",
		"deliverables": "deliverables", "acceptance": "acceptance", "report": "report",
	}
	if dt, ok := known[base]; ok {
		return dt
	}
	// report-r2 这类：版本后缀剥掉后剩 report。
	if strings.HasPrefix(base, "report") {
		return "report"
	}
	if p.DocType != "" {
		return p.DocType // overview 类别 / filing-*
	}
	if p.Stage != nil {
		switch *p.Stage {
		case 1:
			return "prototype"
		case 2:
			return "plan"
		case 3:
			return "design"
		case 4:
			return "report"
		case 5:
			// 五阶段对齐 plan §4.7：S5 需求迭代默认 doc_type 与后端映射表取值一致。
			return "iteration"
		}
	}
	return base
}

// versionFromName 取 v<N> 或 -r<N> 版本号；缺省 1（CONTRACT.md §1 行5）。
func versionFromName(base string) int32 {
	if strings.HasPrefix(base, "v") && len(base) > 1 {
		if n, err := strconv.Atoi(base[1:]); err == nil && n > 0 {
			return int32(n)
		}
	}
	if idx := strings.LastIndex(base, "-r"); idx >= 0 && idx+2 < len(base) {
		if n, err := strconv.Atoi(base[idx+2:]); err == nil && n > 0 {
			return int32(n)
		}
	}
	return 1
}

type archiveFrontmatter struct {
	IssueID   string
	DocType   string
	DocClass  string
	DocModule string
}

// parseFrontmatter 提取 YAML frontmatter 的子集（issue / doc_type / doc_class / doc_module）。
func parseFrontmatter(abs string) archiveFrontmatter {
	var out archiveFrontmatter
	f, err := os.Open(abs)
	if err != nil {
		return out
	}
	defer f.Close()
	head := make([]byte, 4096)
	n, _ := f.Read(head)
	text := string(head[:n])
	if !strings.HasPrefix(text, "---\n") {
		return out
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return out
	}
	for _, line := range strings.Split(text[4:4+end], "\n") {
		kv := strings.SplitN(line, ":", 2)
		if len(kv) != 2 {
			continue
		}
		key := strings.TrimSpace(kv[0])
		val := strings.Trim(strings.TrimSpace(kv[1]), `"'`)
		switch key {
		case "multica_issue_id":
			out.IssueID = val
		case "doc_type":
			out.DocType = val
		case "doc_class":
			out.DocClass = val
		case "doc_module":
			out.DocModule = val
		}
	}
	return out
}

func normalizeCLIDocClass(explicit, docType, relPath string) string {
	c := strings.ToLower(strings.TrimSpace(explicit))
	switch c {
	case "prd", "mrd", "brd", "roadmap":
		return c
	}
	base := strings.ToLower(filepath.Base(filepath.ToSlash(relPath)))
	name := strings.TrimSuffix(strings.TrimSuffix(base, ".md"), ".html")
	if name == "prd" || strings.HasPrefix(name, "prd-") || name == "requirement" {
		return "prd"
	}
	if name == "mrd" || strings.HasPrefix(name, "mrd-") {
		return "mrd"
	}
	if name == "brd" || strings.HasPrefix(name, "brd-") {
		return "brd"
	}
	if docType == "requirement" {
		return "prd"
	}
	if docType == "work-plan" {
		return "roadmap"
	}
	return ""
}

// gitBlobSHA 计算 git blob 对象 sha1（"blob <len>\0<content>"），与 git hash-object 一致。
// 注意：SHA-1 在此处是刻意的兼容性选择——blob_sha 是 git 内容寻址的指纹，
// 用于与仓库历史对账和差量判定，不承担任何安全/签名职责。
func gitBlobSHA(data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// ── 扫描（CONTRACT.md §4 跳过规则）────────────────────────────────────────────

var archiveSkipDirs = map[string]bool{
	"_attic": true, "assets": true, "node_modules": true, ".git": true,
	"qoder_backup": true, "db_backups": true, "wiki_snapshots": true,
	"dist": true, "vendor": true, "build": true, ".next": true,
	"coverage": true, "page-navigator": true,
}

// scanArchiveFiles 递归收集档案文件（跳过 _attic/assets/node_modules/.git/*.zip）。
// WalkDir 保证返回路径均位于 root 之内（filepath 包契约），rel_path 仅由
// filepath.Rel(root, abs) 派生，不接受外部输入拼接，无路径逃逸面。
func siblingChangeLogsRoot(archiveRoot string) string {
	if filepath.Base(archiveRoot) == "change_logs" {
		return archiveRoot
	}
	return filepath.Clean(filepath.Join(archiveRoot, "..", "change_logs"))
}

func scanSiblingChangeLogs(archiveRoot, changeLogsRoot string) ([]string, error) {
	if changeLogsRoot == "" {
		return nil, nil
	}
	absRoot, err := filepath.Abs(archiveRoot)
	if err != nil {
		return nil, err
	}
	absLogs, err := filepath.Abs(changeLogsRoot)
	if err != nil {
		return nil, err
	}
	if absRoot == absLogs {
		return nil, nil
	}
	st, err := os.Stat(absLogs)
	if err != nil || !st.IsDir() {
		return nil, err
	}
	return scanArchiveFiles(absLogs)
}

func archiveRelPath(archiveRoot, changeLogsRoot, abs string) (string, bool) {
	if rel, ok := relInside(archiveRoot, abs); ok {
		if filepath.Base(archiveRoot) == "change_logs" && !strings.HasPrefix(rel, "change_logs/") {
			return "change_logs/" + rel, true
		}
		return rel, true
	}
	if rel, ok := relInside(changeLogsRoot, abs); ok {
		if !strings.HasPrefix(rel, "change_logs/") {
			return "change_logs/" + rel, true
		}
		return rel, true
	}
	return "", false
}

func relInside(root, abs string) (string, bool) {
	if root == "" {
		return "", false
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func scanArchiveFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != root && archiveSkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(strings.ToLower(d.Name()), ".zip") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files, err
}

// scopeFilterAllowed 应用 sync_config.scope_filter 的 include/exclude 前缀（§4.9.7）。
func scopeFilterAllowed(filter json.RawMessage, rel string) bool {
	if len(filter) == 0 || string(filter) == "{}" {
		return true
	}
	var f struct {
		Include []string `json:"include"`
		Exclude []string `json:"exclude"`
	}
	if err := json.Unmarshal(filter, &f); err != nil {
		return true
	}
	for _, ex := range f.Exclude {
		if strings.HasPrefix(rel, ex) {
			return false
		}
	}
	if len(f.Include) == 0 {
		return true
	}
	for _, in := range f.Include {
		if strings.HasPrefix(rel, in) {
			return true
		}
	}
	return false
}

// gitCleanRelPaths 返回 git 工作区中干净的相对路径集合（incremental 模式用：
// 干净文件复用 server 已知 blob_sha，跳过重哈希）。非 git 仓库返回 nil。
func gitCleanRelPaths(root string, all []string) map[string]bool {
	cmd := exec.Command("git", "-C", root, "status", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	dirty := make(map[string]bool)
	for _, line := range strings.Split(string(out), "\n") {
		if len(line) > 3 {
			dirty[strings.TrimSpace(line[3:])] = true
		}
	}
	clean := make(map[string]bool, len(all))
	for _, abs := range all {
		rel, err := filepath.Rel(root, abs)
		if err != nil {
			continue
		}
		if !dirty[filepath.ToSlash(rel)] {
			clean[filepath.ToSlash(rel)] = true
		}
	}
	return clean
}

// ── 诊断收集（migration 461 sync_diagnostics）────────────────────────────────

type diagEntry struct {
	Stage   string         `json:"stage"`
	RelPath *string        `json:"rel_path"`
	Level   string         `json:"level"`
	Message string         `json:"message"`
	Detail  map[string]any `json:"detail,omitempty"`
}

type diagCollector struct {
	runID   string
	entries []diagEntry
}

func (d *diagCollector) add(stage, level, relPath, message string, detail map[string]any) {
	e := diagEntry{Stage: stage, Level: level, Message: message, Detail: detail}
	if relPath != "" {
		e.RelPath = &relPath
	}
	d.entries = append(d.entries, e)
}

const maxArtifactSnapshotBytes = 100 << 20 // 100MB：仅索引不上传快照（CONTRACT.md §4）

// ── 主流水线 ─────────────────────────────────────────────────────────────────

func runArchiveSync(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	archiveRoot, err := resolveArchiveRoot(mustFlagString(cmd, "path"))
	if err != nil {
		return err
	}
	mode, _ := cmd.Flags().GetString("mode")
	if mode != "incremental" && mode != "full" && mode != "manual" {
		return fmt.Errorf("--mode 必须是 incremental|full|manual")
	}
	dryRun, _ := cmd.Flags().GetBool("dry-run")
	onlyProject, _ := cmd.Flags().GetString("project")
	runID := fmt.Sprintf("cli-%d", os.Getpid())

	fmt.Printf("档案仓库  %s   模式 %s%s\n", archiveRoot, mode, map[bool]string{true: "（dry-run）", false: ""}[dryRun])

	// ① 扫描与解析 ────────────────────────────────────────────────────────────
	fmt.Println("① 扫描与解析")
	files, err := scanArchiveFiles(archiveRoot)
	if err != nil {
		return fmt.Errorf("扫描失败: %w", err)
	}
	changeLogsRoot := siblingChangeLogsRoot(archiveRoot)
	if extra, extraErr := scanSiblingChangeLogs(archiveRoot, changeLogsRoot); extraErr == nil {
		files = append(files, extra...)
	}
	diag := &diagCollector{runID: runID}
	diag.add("scan", "info", "", fmt.Sprintf("scanned %d files", len(files)), nil)

	var clean map[string]bool
	if mode == "incremental" {
		clean = gitCleanRelPaths(archiveRoot, files)
	}

	parsed := make(map[string][]*archiveParsedFile) // projectKey -> files
	var unclassified []string
	for _, abs := range files {
		rel, ok := archiveRelPath(archiveRoot, changeLogsRoot, abs)
		if !ok {
			continue
		}
		p, perr := parseArchiveRelPath(rel)
		if perr != nil {
			unclassified = append(unclassified, filepath.ToSlash(rel))
			diag.add("parse", "warning", filepath.ToSlash(rel), perr.Error(), nil)
			continue
		}
		p.AbsPath = abs
		parsed[p.ProjectKey] = append(parsed[p.ProjectKey], p)
	}
	fmt.Printf("  ✓ 扫描 %d 个文件（跳过 _attic/ · assets/ · *.zip · node_modules）\n", len(files))
	if len(unclassified) > 0 {
		fmt.Printf("  ! %d 个文件无法归类，进待人工归置（见 diagnostics）\n", len(unclassified))
	}

	// 项目解析：title（大小写不敏感）↔ project_key。
	projects, err := listWorkspaceProjects(ctx, client)
	if err != nil {
		return err
	}

	keys := make([]string, 0, len(parsed))
	for k := range parsed {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	totalUpserted := 0
	for _, key := range keys {
		if onlyProject != "" && !strings.EqualFold(key, onlyProject) {
			continue
		}
		if key == "" {
			fmt.Printf("  - _shared：%d 个文件（个人档案库，待绑定 project 后入库）\n", len(parsed[key]))
			continue
		}
		proj, ok := projects[strings.ToLower(key)]
		if !ok {
			fmt.Printf("  ✕ 项目 %q 未注册，请先 multica project create（%d 个文件跳过）\n", key, len(parsed[key]))
			diag.add("parse", "error", "", fmt.Sprintf("project key %q not registered", key), nil)
			continue
		}
		n, err := syncOneProject(ctx, client, proj.ID, key, parsed[key], archiveRoot, clean, dryRun, diag)
		if err != nil {
			fmt.Printf("  ✕ 项目 %s 同步失败: %v\n", key, err)
			diag.add("index", "error", "", fmt.Sprintf("project %s sync failed: %v", key, err), nil)
			continue
		}
		totalUpserted += n
	}

	// ⑤ 诊断上报（失败不阻塞主流程——diagnostics 本身是观测层）。
	if !dryRun && len(diag.entries) > 0 {
		for _, key := range keys {
			proj, ok := projects[strings.ToLower(key)]
			if !ok || (onlyProject != "" && !strings.EqualFold(key, onlyProject)) || key == "" {
				continue
			}
			body := map[string]any{"sync_run_id": runID, "entries": diag.entries}
			var out map[string]any
			if err := client.PostJSON(ctx, "/api/projects/"+proj.ID+"/archive/sync-diagnostics", body, &out); err != nil {
				fmt.Printf("  ! 诊断上报失败（不影响同步结果）: %v\n", err)
			}
			break // 诊断按项目归属；多项目运行时归到第一个项目（v1 简化）
		}
	}

	fmt.Printf("➜ 完成 · upsert %d 个档案条目\n", totalUpserted)
	return nil
}

// workspaceProject 是 GET /api/projects 返回项的最小字段集。
type workspaceProject struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func listWorkspaceProjects(ctx context.Context, client *cli.APIClient) (map[string]workspaceProject, error) {
	params := url.Values{}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	path := "/api/projects"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}
	var result map[string]any
	if err := client.GetJSON(ctx, path, &result); err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	raw, _ := result["projects"].([]any)
	out := make(map[string]workspaceProject, len(raw))
	for _, item := range raw {
		b, _ := json.Marshal(item)
		var p workspaceProject
		if err := json.Unmarshal(b, &p); err == nil && p.ID != "" {
			out[strings.ToLower(p.Title)] = p
		}
	}
	return out, nil
}

// syncOneProject 跑单项目的 ②上传 → ③索引同步 阶段，返回 upsert 条目数。
func syncOneProject(ctx context.Context, client *cli.APIClient, projectID, key string, files []*archiveParsedFile, archiveRoot string, clean map[string]bool, dryRun bool, diag *diagCollector) (int, error) {
	// 同步配置（scope_filter / conflict_policy；缺省容忍 404——461 之前的 server 没有该端点）。
	var scopeFilter json.RawMessage
	conflictPolicy := "path_first"
	var cfg struct {
		ScopeFilter    json.RawMessage `json:"scope_filter"`
		ConflictPolicy string          `json:"conflict_policy"`
	}
	if err := client.GetJSON(ctx, "/api/projects/"+projectID+"/archive/sync-config", &cfg); err == nil {
		scopeFilter = cfg.ScopeFilter
		if cfg.ConflictPolicy != "" {
			conflictPolicy = cfg.ConflictPolicy
		}
	}

	// server 侧既有 blob_sha（差量判定的基准）。
	existing := map[string]string{}
	var artList struct {
		Artifacts []struct {
			RelPath string `json:"rel_path"`
			BlobSha string `json:"blob_sha"`
		} `json:"artifacts"`
	}
	if err := client.GetJSON(ctx, "/api/projects/"+projectID+"/artifacts?limit=1000", &artList); err == nil {
		for _, a := range artList.Artifacts {
			existing[a.RelPath] = a.BlobSha
		}
	}

	// ② 解析 + 哈希 + 差量上传 ────────────────────────────────────────────────
	fmt.Printf("  ② 项目 %s（%d 个文件）\n", key, len(files))
	uploaded, skipped, indexOnly := 0, 0, 0
	items := make([]map[string]any, 0, len(files))
	for _, p := range files {
		relSlash := filepath.ToSlash(p.RelPath)
		if !scopeFilterAllowed(scopeFilter, relSlash) {
			continue
		}
		fm := parseFrontmatter(p.AbsPath)
		p.IssueID = fm.IssueID
		if fm.DocType != "" {
			p.DocType = fm.DocType
		} else {
			p.DocType = docTypeFromName(p)
		}
		p.Version = versionFromName(strings.TrimSuffix(strings.ToLower(filepath.Base(p.RelPath)), filepath.Ext(p.RelPath)))

		info, err := os.Stat(p.AbsPath)
		if err != nil {
			diag.add("parse", "error", relSlash, err.Error(), nil)
			continue
		}
		p.SizeBytes = info.Size()

		// incremental：git 干净文件复用 server 已知 sha，跳过重哈希。
		known, serverHas := existing[relSlash]
		if clean != nil && clean[relSlash] && serverHas {
			p.BlobSha = known
		} else {
			data, err := os.ReadFile(p.AbsPath)
			if err != nil {
				diag.add("parse", "error", relSlash, err.Error(), nil)
				continue
			}
			p.BlobSha = gitBlobSHA(data)
		}

		// 差量上传：blob_sha 未变 → 跳过（attachment 复用）；>100MB → 仅索引。
		if serverHas && existing[relSlash] == p.BlobSha {
			skipped++
		} else if p.SizeBytes > maxArtifactSnapshotBytes {
			indexOnly++
			diag.add("upload", "warning", relSlash, "exceeds 100MB, index only", map[string]any{"size_bytes": p.SizeBytes})
		} else if !dryRun {
			data, err := os.ReadFile(p.AbsPath)
			if err != nil {
				diag.add("upload", "error", relSlash, err.Error(), nil)
				continue
			}
			attachmentID, err := client.UploadFile(ctx, data, filepath.Base(p.AbsPath), "")
			if err != nil {
				// 上传失败不阻塞入库：无快照的指针行仍保留 diff 价值。
				diag.add("upload", "error", relSlash, "upload failed: "+err.Error(), nil)
			} else {
				p.AttachmentID = attachmentID
				uploaded++
			}
		} else {
			uploaded++
		}

		item := map[string]any{
			"rel_path":   relSlash,
			"blob_sha":   p.BlobSha,
			"scope":      p.Scope,
			"doc_type":   p.DocType,
			"version":    p.Version,
			"size_bytes": p.SizeBytes,
		}
		if p.Stage != nil {
			item["stage"] = *p.Stage
		}
		if p.RequirementKey != "" {
			item["requirement_key"] = p.RequirementKey
		}
		// anno② review_queue：frontmatter 与路径双信号并存时不自作主张，落待绑定。
		if p.IssueID != "" && (conflictPolicy == "path_first" || p.RequirementKey == "") {
			item["issue_id"] = p.IssueID
		}
		if p.AttachmentID != "" {
			item["attachment_id"] = p.AttachmentID
		}
		if class := normalizeCLIDocClass(fm.DocClass, p.DocType, relSlash); class != "" {
			item["doc_class"] = class
		}
		if module := strings.TrimSpace(fm.DocModule); module != "" {
			item["doc_module"] = module
		}
		items = append(items, item)
	}
	fmt.Printf("     快照上传：变更 %d · 未变 %d · >100MB 仅索引 %d\n", uploaded, skipped, indexOnly)

	if dryRun {
		fmt.Printf("     （dry-run）将向 /projects/%s/artifacts/sync 提交 %d 条清单\n", projectID, len(items))
		return len(items), nil
	}

	// ③ 索引同步（全量清单 diff）──────────────────────────────────────────────
	body := map[string]any{"artifacts": items}
	var syncResult map[string]any
	if err := client.PostJSON(ctx, "/api/projects/"+projectID+"/artifacts/sync", body, &syncResult); err != nil {
		return 0, fmt.Errorf("artifacts sync: %w", err)
	}
	fmt.Printf("     索引同步：新建 %v · 更新 %v · 软删 %v\n",
		syncResult["created_count"], syncResult["updated_count"], syncResult["deleted_count"])
	diag.add("index", "info", "", fmt.Sprintf("manifest synced: %d items", len(items)), nil)
	return len(items), nil
}
