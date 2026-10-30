package main

import (
	"testing"

	"github.com/spf13/cobra"
)

// 第二轮补齐的模块命令组必须挂在根命令上：少一个，agent 就只能退回
// `project tab get`（只读），或者干脆去猜端点。
func TestSecondRoundCommandGroupsAreRegistered(t *testing.T) {
	got := map[string]bool{}
	for _, child := range rootCmd.Commands() {
		got[child.Name()] = true
	}
	for _, name := range []string{"artifact", "attachment", "filing", "graph", "issue", "module", "workflow"} {
		if !got[name] {
			t.Fatalf("%s command group is missing; commands are %v", name, commandNames(got))
		}
	}
}

// 每个模块的写面：读之外至少要有 create/update/delete（或等价动作），
// 否则「全模块 CRUD」只是读的通路。
func TestModuleCommandGroupsExposeWriteSurface(t *testing.T) {
	cases := map[string]struct {
		root *cobra.Command
		want []string
	}{
		"module":     {moduleCmd, []string{"create", "delete", "get", "list", "prototype", "update"}},
		"artifact":   {artifactCmd, []string{"bind", "create", "delete", "get", "list", "matrix", "unbind", "unbound", "update"}},
		"filing":     {filingCmd, []string{"check", "cross-project", "export", "items", "patch", "readiness", "writeback"}},
		"graph":      {graphCmd, []string{"alerts", "changes", "detail", "drilldown", "latest", "matrix", "modules", "neighborhood", "objects", "strategies", "timeline"}},
		"workflow":   {workflowCmd, []string{"gate", "instance", "stage", "template"}},
		"issue":      {issueCmd, []string{"delete"}},
		"attachment": {attachmentCmd, []string{"delete", "download", "upload"}},
	}
	for group, tc := range cases {
		got := map[string]bool{}
		for _, child := range tc.root.Commands() {
			got[child.Name()] = true
		}
		for _, name := range tc.want {
			if !got[name] {
				t.Fatalf("%s %s is missing; commands are %v", group, name, commandNames(got))
			}
		}
	}
}

// 第二轮新增的每条破坏性命令都必须挂上 --yes 闸门，否则非终端执行时无法拒绝。
func TestSecondRoundDestructiveCommandsExposeYesFlag(t *testing.T) {
	paths := [][]string{
		{"attachment", "delete"},
		{"artifact", "delete"},
		{"artifact", "unbind"},
		{"filing", "writeback"},
		{"issue", "delete"},
		{"module", "delete"},
		{"sprint", "delete"},
		{"workflow", "instance", "cancel"},
	}
	for _, path := range paths {
		cmd := findCommandByPath(t, rootCmd, path...)
		if cmd.Flags().Lookup("yes") == nil {
			t.Fatalf("%v has no --yes flag, so an agent run could not be refused", path)
		}
	}
}

// 第三轮补齐的模块（收件箱、看板控件、用量看板、工作区管理）同样必须能在根命令
// 下找到，否则内置 skill 里写的命令对 agent 就是不可达的。
func TestThirdRoundCommandGroupsAreRegistered(t *testing.T) {
	got := map[string]bool{}
	for _, child := range rootCmd.Commands() {
		got[child.Name()] = true
	}
	for _, name := range []string{
		"chat", "dashboard", "inbox", "issue-status", "issue-view", "issue-workflow",
		"notification", "pin", "quick-action", "workspace",
	} {
		if !got[name] {
			t.Fatalf("%s command group is missing; commands are %v", name, commandNames(got))
		}
	}
}

// 第三轮新增的每个模块都要能从命令行完成整套增删改查，而不只是读。
func TestThirdRoundModuleSurfaceExposesCRUD(t *testing.T) {
	cases := map[string]struct {
		root *cobra.Command
		want []string
	}{
		"inbox":          {inboxCmd, []string{"archive", "archive-all", "archive-completed", "archive-read", "archived", "list", "mark-all-read", "mark-unread", "read", "summary", "unarchive", "unread"}},
		"notification":   {notificationCmd, []string{"get", "set"}},
		"chat":           {chatCmd, []string{"history", "messages", "participant", "pending", "react", "read", "reply", "send", "session", "thread"}},
		"dashboard":      {dashboardCmd, []string{"agent-runtime", "failures", "failures-by-agent", "overview", "runtime", "usage", "usage-by-agent"}},
		"pin":            {pinCmd, []string{"add", "list", "remove", "reorder"}},
		"issue-view":     {issueViewCmd, []string{"create", "delete", "get", "list", "preference", "update"}},
		"quick-action":   {quickActionCmd, []string{"create", "delete", "list", "update"}},
		"issue-status":   {issueStatusCatalogCmd, []string{"archive", "create", "list", "reorder", "update"}},
		"issue-workflow": {issueWorkflowCmd, []string{"brief", "create", "delete", "get", "handoff", "list", "update"}},
		"workspace":      {workspaceCmd, []string{"create", "delete", "get", "invitation", "list", "mcp", "member", "share-link", "switch", "update"}},
	}
	for group, tc := range cases {
		got := map[string]bool{}
		for _, child := range tc.root.Commands() {
			got[child.Name()] = true
		}
		for _, name := range tc.want {
			if !got[name] {
				t.Fatalf("%s %s is missing; commands are %v", group, name, commandNames(got))
			}
		}
	}
}

// 第三轮新增的破坏性与准入类命令同样必须有 --yes 闸门。
func TestThirdRoundDestructiveCommandsExposeYesFlag(t *testing.T) {
	paths := [][]string{
		{"chat", "session", "delete"},
		{"issue-status", "archive"},
		{"issue-view", "delete"},
		{"issue-workflow", "delete"},
		{"quick-action", "delete"},
		{"workspace", "delete"},
		{"workspace", "invitation", "revoke"},
		{"workspace", "member", "remove"},
		{"workspace", "share-link", "revoke"},
	}
	for _, path := range paths {
		cmd := findCommandByPath(t, rootCmd, path...)
		if cmd.Flags().Lookup("yes") == nil {
			t.Fatalf("%v has no --yes flag, so an agent run could not be refused", path)
		}
	}
}

// 列表默认打印 8 位前缀，写命令再把前缀解析回 UUID；漏了 --full-id 就没法把长
// id 传给日志或其它系统，漏了解析器就只能贴全量 UUID。
func TestThirdRoundListCommandsExposeFullID(t *testing.T) {
	paths := [][]string{
		{"inbox", "list"},
		{"inbox", "archived"},
		{"issue-status", "list"},
		{"issue-view", "list"},
		{"issue-workflow", "list"},
		{"pin", "list"},
		{"quick-action", "list"},
		{"workspace", "invitation", "list"},
		{"workspace", "invitation", "mine"},
		{"workspace", "member", "list"},
		{"workspace", "share-link", "list"},
	}
	for _, path := range paths {
		cmd := findCommandByPath(t, rootCmd, path...)
		if cmd.Flags().Lookup("full-id") == nil {
			t.Fatalf("%v has no --full-id flag; ids copied from its table cannot be used verbatim", path)
		}
	}
}

// 第四轮：看板批量操作与插件。插件在 feature flag 关闭时整体 404，但命令本身
// 必须存在，否则 agent 无从判断是“没有这个能力”还是“没开关”。
func TestFourthRoundModuleSurfaceExposesCRUD(t *testing.T) {
	cases := map[string]struct {
		root *cobra.Command
		want []string
	}{
		"issue":  {issueCmd, []string{"batch"}},
		"plugin": {pluginCmd, []string{"config", "disable", "enable", "install", "invocations", "list", "mcp", "package", "preview", "surface", "token", "uninstall"}},
	}
	for group, tc := range cases {
		got := map[string]bool{}
		for _, child := range tc.root.Commands() {
			got[child.Name()] = true
		}
		for _, name := range tc.want {
			if !got[name] {
				t.Fatalf("%s %s is missing; commands are %v", group, name, commandNames(got))
			}
		}
	}

	batch := map[string]bool{}
	for _, child := range issueBatchCmd.Commands() {
		batch[child.Name()] = true
	}
	for _, name := range []string{"delete", "update"} {
		if !batch[name] {
			t.Fatalf("issue batch %s is missing; commands are %v", name, commandNames(batch))
		}
	}
}

func TestFourthRoundDestructiveCommandsExposeYesFlag(t *testing.T) {
	paths := [][]string{
		{"issue", "batch", "delete"},
		{"plugin", "package", "delete"},
		{"plugin", "token", "revoke"},
		{"plugin", "uninstall"},
	}
	for _, path := range paths {
		cmd := findCommandByPath(t, rootCmd, path...)
		if cmd.Flags().Lookup("yes") == nil {
			t.Fatalf("%v has no --yes flag, so an agent run could not be refused", path)
		}
	}
}

// 模块能力规格面（spec / plan / reconcile / coverage）必须全部挂上：它们与界面
// 「原型图」子 TAB 同源，也是 multica-feature-modules 技能里写的命令。文档里能写的
// 命令必须真实存在，否则只是把弯路从代码搬到技能里。
func TestModuleSpecSurfaceIsRegistered(t *testing.T) {
	for _, path := range [][]string{
		{"module", "spec", "get"},
		{"module", "spec", "draft"},
		{"module", "spec", "publish"},
		{"module", "plan", "create"},
		{"module", "plan", "get"},
		{"module", "plan", "apply"},
		{"module", "reconcile"},
		{"module", "coverage"},
		{"module", "brief", "get"},
		{"module", "brief", "patch"},
		{"module", "release", "list"},
		{"module", "release", "publish"},
		{"module", "release", "rollback"},
	} {
		findCommandByPath(t, rootCmd, path...)
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "plan", "apply"); cmd.Flags().Lookup("yes") == nil {
		t.Fatalf("module plan apply has no --yes flag, so an agent run could not be refused")
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "release", "publish"); cmd.Flags().Lookup("yes") == nil {
		t.Fatalf("module release publish has no --yes flag, so an agent run could not be refused")
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "release", "rollback"); cmd.Flags().Lookup("yes") == nil {
		t.Fatalf("module release rollback has no --yes flag, so an agent run could not be refused")
	}
}

// 模块内容面（单条功能点、说明字段、需求归属）与原型维护面（登记/修正/确认/
// 删除/解析）必须全部挂上：技能里写了什么命令，命令行就得真有什么命令，否则
// 「agent 自主迭代全部原型图」只是一句口号。
func TestModuleContentAndPrototypeSurfaceIsRegistered(t *testing.T) {
	for _, path := range [][]string{
		{"module", "spec", "feature", "add"},
		{"module", "spec", "feature", "update"},
		{"module", "spec", "feature", "remove"},
		{"module", "requirement", "add"},
		{"module", "requirement", "remove"},
		{"module", "brief", "versions"},
		{"module", "brief", "diff"},
		{"module", "prototype", "register"},
		{"module", "prototype", "update"},
		{"module", "prototype", "confirm"},
		{"module", "prototype", "delete"},
		{"module", "prototype", "parse"},
		{"module", "prototype", "diff"},
	} {
		findCommandByPath(t, rootCmd, path...)
	}

	// 删除必须在非终端环境下可被拒绝。
	if cmd := findCommandByPath(t, rootCmd, "module", "prototype", "delete"); cmd.Flags().Lookup("yes") == nil {
		t.Fatalf("module prototype delete has no --yes flag, so an agent run could not be refused")
	}
	// 登记/修正要能改路径，解析要能指定文件，确认要能移权威指针。
	for _, path := range [][]string{
		{"module", "prototype", "register"},
		{"module", "prototype", "update"},
	} {
		if cmd := findCommandByPath(t, rootCmd, path...); cmd.Flags().Lookup("html-path") == nil {
			t.Fatalf("%v has no --html-path flag; the version could be registered but never corrected", path)
		}
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "prototype", "confirm"); cmd.Flags().Lookup("canonical") == nil {
		t.Fatalf("module prototype confirm has no --canonical flag; a confirmed version could never become the canonical one")
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "prototype", "parse"); cmd.Flags().Lookup("html-path") == nil {
		t.Fatalf("module prototype parse has no --html-path flag; a version whose file is not on disk could not be parsed")
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "brief", "patch"); cmd.Flags().Lookup("base-version") == nil {
		t.Fatalf("module brief patch has no --base-version flag; the optimistic lock cannot be honored")
	}
	if cmd := findCommandByPath(t, rootCmd, "module", "prototype", "diff"); cmd.Flags().Lookup("from") == nil || cmd.Flags().Lookup("to") == nil {
		t.Fatalf("module prototype diff has no --from/--to flags; two arbitrary versions could not be compared")
	}
}

func findCommandByPath(t *testing.T, root *cobra.Command, path ...string) *cobra.Command {
	t.Helper()
	current := root
	for _, name := range path {
		var next *cobra.Command
		for _, child := range current.Commands() {
			if child.Name() == name {
				next = child
				break
			}
		}
		if next == nil {
			t.Fatalf("%v: %q not found under %q", path, name, current.Name())
		}
		current = next
	}
	return current
}
