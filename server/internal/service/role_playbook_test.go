package service

import (
	"strings"
	"testing"
)

func TestBuiltinRolePlaybooksCoverAllRoles(t *testing.T) {
	for _, role := range RolePlaybookRoles {
		p := BuiltinRolePlaybook(role)
		if p.Role != role {
			t.Fatalf("%s: role = %q", role, p.Role)
		}
		if strings.TrimSpace(p.Background) == "" || strings.TrimSpace(p.Standards) == "" ||
			strings.TrimSpace(p.Process) == "" || strings.TrimSpace(p.InitContent) == "" {
			t.Fatalf("%s: builtin playbook has empty required field: %+v", role, p)
		}
		if p.InitMode != "brief" && p.InitMode != "checklist" {
			t.Fatalf("%s: invalid init_mode %q", role, p.InitMode)
		}
	}
}

func TestMergeRolePlaybookFieldLevel(t *testing.T) {
	base := BuiltinRolePlaybook("developer")
	got := MergeRolePlaybook(base, RolePlaybook{
		Standards: "只改 server/internal/foo.go",
		InitMode:  "checklist",
	})
	if got.Background != base.Background {
		t.Fatalf("empty override must keep builtin background")
	}
	if got.Standards != "只改 server/internal/foo.go" {
		t.Fatalf("standards override lost: %q", got.Standards)
	}
	if got.InitMode != "checklist" {
		t.Fatalf("init_mode override lost: %q", got.InitMode)
	}
}

func TestResolveRolePlaybookSource(t *testing.T) {
	builtin := ResolveRolePlaybook("pm", RolePlaybook{})
	if builtin.Source != "builtin" {
		t.Fatalf("empty override should be builtin, got %q", builtin.Source)
	}
	custom := ResolveRolePlaybook("pm", RolePlaybook{Background: "本项目 PM 必须先写风险"})
	if custom.Source != "custom" {
		t.Fatalf("non-empty override should be custom, got %q", custom.Source)
	}
	if !strings.Contains(custom.Background, "本项目 PM") {
		t.Fatalf("custom background missing: %q", custom.Background)
	}
	if custom.Standards == "" {
		t.Fatalf("unoverridden standards should fall back to builtin")
	}
}

func TestRolePlaybookHasOverride(t *testing.T) {
	if RolePlaybookHasOverride(RolePlaybook{}) {
		t.Fatal("empty playbook is not an override")
	}
	if RolePlaybookHasOverride(RolePlaybook{InitMode: "brief"}) {
		t.Fatal("default init_mode alone is not an override")
	}
	if !RolePlaybookHasOverride(RolePlaybook{InitMode: "checklist"}) {
		t.Fatal("checklist init_mode is an override")
	}
	if !RolePlaybookHasOverride(RolePlaybook{Process: "1. 只做拆解"}) {
		t.Fatal("process text is an override")
	}
}

func TestFormatAndPrependRolePlaybook(t *testing.T) {
	p := ResolveRolePlaybook("tester", RolePlaybook{})
	block := FormatRolePlaybookBlock(p)
	for _, want := range []string{
		"角色执行标准",
		"角色背景",
		"交付标准",
		"执行流程",
		"初始化清单",
		"压过你自身的自由发挥",
	} {
		if !strings.Contains(block, want) {
			t.Fatalf("block missing %q:\n%s", want, block)
		}
	}
	got := PrependRolePlaybook(p, "## 验收依据\n已确认原型")
	if !strings.HasPrefix(got, "# 角色执行标准") {
		t.Fatalf("playbook must lead the brief:\n%s", got)
	}
	if !strings.Contains(got, "## 验收依据") {
		t.Fatalf("original body lost:\n%s", got)
	}
	if PrependRolePlaybook(RolePlaybook{}, "body") != "body" {
		t.Fatal("empty playbook must not wrap body")
	}
}
