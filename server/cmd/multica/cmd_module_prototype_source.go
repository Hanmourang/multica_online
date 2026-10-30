package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/prototypeimport"
)

// 原型正文有两个可能的家，agent 侧必须两个都认：
//
//   - 本地文件：html_path 落在档案根 / change_logs / 工作区目录之内时（原型画在
//     用户自己机器上、按路径共享）。
//   - 服务端附件：界面上「上传本地 HTML」登记的原型**根本不写这份路径**——字节
//     进的是 attachment 存储，html_path 只是按模块名 + 版本号拼出来的虚拟路径。
//     这条分支里磁盘上永远没有文件，只能 project_artifact → attachment 把正文取回。
//
// 少了第二条分支，agent 在远端 runtime 里读任何「上传」的原型都只会得到
// FILE missing，而文件其实好好地躺在服务器上。
type prototypeBody struct {
	Kind         string // local | server
	Path         string // 本地绝对路径，或服务端的 artifact.rel_path
	Bytes        int
	ArtifactID   string
	AttachmentID string
	HTML         string
}

// loadPrototypeBody 按「本地 → 服务端」的顺序取正文，并返回本地找过的绝对路径
// （没命中时用来如实说明试过哪里，而不是只丢一句 does not exist）。
func loadPrototypeBody(ctx context.Context, client *cli.APIClient, module moduleRecord, htmlPath string, version int32) (*prototypeBody, []string, error) {
	abs, candidates := resolveModulePrototypePath(htmlPath)
	if abs == "" && fileExists(htmlPath) {
		// --html-path 常常是相对于当前目录的稿子路径，候选根之外也要认它。
		abs = filepath.Clean(htmlPath)
		candidates = append(candidates, abs)
	}
	if abs != "" {
		data, err := os.ReadFile(abs)
		if err != nil {
			return nil, candidates, fmt.Errorf("read prototype file %s: %w", abs, err)
		}
		return &prototypeBody{Kind: "local", Path: abs, Bytes: len(data), HTML: string(data)}, candidates, nil
	}

	ref, err := loadPrototypeArtifact(ctx, client, module, htmlPath, version)
	if err != nil {
		return nil, candidates, err
	}
	data, err := client.DownloadFile(ctx, "/api/attachments/"+url.PathEscape(ref.AttachmentID)+"/content")
	if err != nil {
		return nil, candidates, fmt.Errorf(
			"artifact %s points at attachment %s but its bytes could not be read: %w",
			ref.ID, ref.AttachmentID, err)
	}
	return &prototypeBody{
		Kind:         "server",
		Path:         ref.RelPath,
		Bytes:        len(data),
		ArtifactID:   ref.ID,
		AttachmentID: ref.AttachmentID,
		HTML:         string(data),
	}, candidates, nil
}

// loadPrototypeArtifact 在项目档案里找回 html_path 对应的那一行。
//
// 先按 doc_type=prototype 找；没命中再拉全量——从「资产管理」上传的 HTML 落的是
// doc_type=asset 的档案行，只认 prototype 会把这种真实存在的正文误判为没有。
//
// 失败文案要能直接指向下一步动作：这条链路唯一缺的就是 attachment 绑定，而附件
// 只有「重新上传登记」或「修指针」两种修法，所以把两条命令名写出来。
func loadPrototypeArtifact(ctx context.Context, client *cli.APIClient, module moduleRecord, htmlPath string, version int32) (prototypeimport.ArtifactRef, error) {
	refs, err := fetchProjectArtifacts(ctx, client, module.ProjectID, "prototype")
	if err != nil {
		return prototypeimport.ArtifactRef{}, fmt.Errorf(
			"prototype %s is not on this machine and the project archive could not be listed: %w", htmlPath, err)
	}
	if ref, ok := prototypeimport.MatchArtifact(refs, htmlPath, module.Name, version); ok {
		return ref, nil
	}
	if wider, err := fetchProjectArtifacts(ctx, client, module.ProjectID, ""); err == nil && len(wider) > len(refs) {
		if ref, ok := prototypeimport.MatchArtifact(wider, htmlPath, module.Name, version); ok {
			return ref, nil
		}
		refs = wider
	}
	return prototypeimport.ArtifactRef{}, fmt.Errorf(
		"prototype of module %q v%d is neither on this machine nor readable from the server.\n"+
			"  html_path: %s\n"+
			"  project artifact rows checked: %d (none carried a matching attachment)\n"+
			"%s"+
			"An uploaded prototype lives in attachment storage; the archive row must carry attachment_id. "+
			"Re-register the version, or point it at a real file with `multica module prototype update <module> %d --html-path <path>`.",
		module.Name, version, htmlPath, len(refs), artifactHint(refs), version)
}

// artifactHint 把档案里实际存在的原型列出来：登记路径写错时，一眼就能看出该改成
// 什么（而不是只被告知 not found）。
func artifactHint(refs []prototypeimport.ArtifactRef) string {
	lines := prototypeimport.DescribeArtifacts(refs, 5)
	if len(lines) == 0 {
		return ""
	}
	return "  candidates in the archive:\n    " + strings.Join(lines, "\n    ") + "\n"
}

// projectArtifactRow 是 GET /api/projects/{id}/artifacts 里本命令用到的字段。
type projectArtifactRow struct {
	ID           string  `json:"id"`
	RelPath      string  `json:"rel_path"`
	DocType      string  `json:"doc_type"`
	DocModule    *string `json:"doc_module"`
	Version      int32   `json:"version"`
	AttachmentID *string `json:"attachment_id"`
}

// fetchProjectArtifacts 拉项目的档案行；docType 为空时拉全量（从资产管理上传的
// HTML 落的是 doc_type=asset，不会出现在 prototype 子集里）。
func fetchProjectArtifacts(ctx context.Context, client *cli.APIClient, projectID, docType string) ([]prototypeimport.ArtifactRef, error) {
	if strings.TrimSpace(projectID) == "" {
		return nil, fmt.Errorf("module carries no project_id; pass --project to scope the lookup")
	}
	params := url.Values{}
	if docType != "" {
		params.Set("doc_type", docType)
	}
	if client.WorkspaceID != "" {
		params.Set("workspace_id", client.WorkspaceID)
	}
	path := "/api/projects/" + url.PathEscape(projectID) + "/artifacts"
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var envelope struct {
		Artifacts []projectArtifactRow `json:"artifacts"`
	}
	if err := client.GetJSON(ctx, path, &envelope); err != nil {
		return nil, err
	}
	rows := envelope.Artifacts
	refs := make([]prototypeimport.ArtifactRef, 0, len(rows))
	for _, row := range rows {
		refs = append(refs, prototypeimport.ArtifactRef{
			ID:           row.ID,
			RelPath:      row.RelPath,
			DocType:      row.DocType,
			DocModule:    stringOrEmpty(row.DocModule),
			Version:      row.Version,
			AttachmentID: stringOrEmpty(row.AttachmentID),
		})
	}
	return refs, nil
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
