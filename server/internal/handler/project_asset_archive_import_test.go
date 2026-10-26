package handler

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestPlanArchiveImportName(t *testing.T) {
	taken := map[string]bool{"readme.md": true}

	// 常规：文件名直接可用。
	if name, ok := planArchiveImportName("overview/research/调研报告.md", taken); !ok || name != "调研报告.md" {
		t.Fatalf("fresh name: got %q ok=%v", name, ok)
	}
	// 文件名撞库内已有 → 退到 rel_path（档案内唯一）。
	if name, ok := planArchiveImportName("a/readme.md", taken); !ok || name != "a/readme.md" {
		t.Fatalf("collision fallback: got %q ok=%v", name, ok)
	}
	// 文件名与 rel_path 都被占用 → 放弃该条（skipped）。
	both := map[string]bool{"readme.md": true, "a/readme.md": true}
	if _, ok := planArchiveImportName("a/readme.md", both); ok {
		t.Fatal("expected unusable when both taken")
	}
	// 异常 rel_path 兜底不为空名。
	if name, ok := planArchiveImportName("/", taken); !ok || name != "/" {
		t.Fatalf("odd path: got %q ok=%v", name, ok)
	}
}

func TestArchiveImportTags(t *testing.T) {
	// doc_class + doc_module + doc_type 归并去重。
	d := archiveImportDoc{
		docType:   "research",
		docClass:  pgtype.Text{String: "prd", Valid: true},
		docModule: pgtype.Text{String: "架构", Valid: true},
	}
	tags := archiveImportTags(d)
	if len(tags) != 3 || tags[0] != "prd" || tags[1] != "架构" || tags[2] != "research" {
		t.Fatalf("merged tags: got %v", tags)
	}
	// 空段与重复段剔除；全空 → nil（落库 NULL）。
	dup := archiveImportDoc{docType: "design", docClass: pgtype.Text{String: " design ", Valid: true}}
	if tags := archiveImportTags(dup); len(tags) != 1 || tags[0] != "design" {
		t.Fatalf("dedup tags: got %v", tags)
	}
	if tags := archiveImportTags(archiveImportDoc{}); tags != nil {
		t.Fatalf("empty tags should be nil, got %v", tags)
	}
}
