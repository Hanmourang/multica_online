package execenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Room audience belongs to the per-turn message, not the cached brief. The
// original implementation added a long `## Conversation Channel` section and
// pinned its full prose, including pointers to conditionally rendered
// `## Task Initiator` / `## Requesting User` sections. Those pins were retired
// because they duplicated platform context and made dangling pointers pass.
// The semantic audience boundaries are pinned in daemon/prompt_test.go instead.
func TestBriefChatWorkflowDoesNotAssertAudience(t *testing.T) {
	t.Parallel()

	out := buildMetaSkillContent("claude", TaskContextForEnv{
		ChatSessionID:   "8d154f4b-8a7d-4f10-99ef-c1a16e2e7868",
		ChatChannelType: ChannelTypeSlack,
		AgentID:         "9df55bf2-67de-4ae6-803f-4de2fbd45df1",
		AgentName:       "Eve",
	})
	if !strings.Contains(out, "**You are in chat mode.**") {
		t.Fatal("chat brief must still identify chat mode")
	}
	if !strings.Contains(out, ".multica/chat/shared-issues.md") {
		t.Fatal("chat brief must point agents at the attached-issue file")
	}
	if !strings.Contains(out, ".multica/project/index.md") {
		t.Fatal("chat brief must point agents at the project index")
	}
	if !strings.Contains(out, "Shared resources document body") {
		t.Fatal("chat brief must tell the agent to answer from an attached document body")
	}
	if strings.Contains(out, "You have full access to the `multica` CLI to look up issues") {
		t.Fatal("chat brief must not send every issue question through the CLI")
	}
	for _, retired := range []string{
		"## Conversation Channel",
		"Audience:",
		"messaging you directly",
		"group room",
		"direct room",
	} {
		if strings.Contains(out, retired) {
			t.Errorf("cached brief must not contain per-session audience text %q", retired)
		}
	}
}

func TestWriteProjectIndex(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := writeProjectIndex(dir, TaskContextForEnv{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".multica", "project", "index.md")); !os.IsNotExist(err) {
		t.Fatalf("empty index wrote a file: %v", err)
	}
	if err := writeProjectIndex(dir, TaskContextForEnv{ProjectIndex: "Project index for \"Desk\""}, nil); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, ".multica", "project", "index.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `Project index for "Desk"`) {
		t.Fatalf("index file = %q", body)
	}
}

func TestWriteChatSharedIssues(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := writeChatSharedIssues(dir, TaskContextForEnv{}, nil); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".multica", "chat", "shared-issues.md")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("empty record created %s: %v", path, err)
	}
	if err := writeChatSharedIssues(dir, TaskContextForEnv{ChatIssueRecord: "issue:abc — task_14 done"}, nil); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "task_14 done") {
		t.Fatalf("shared issue file missing the record:\n%s", body)
	}
}

func TestAudienceOf(t *testing.T) {
	t.Parallel()

	if got := ChatAudience(0); got != ChatAudienceUnknown {
		t.Fatalf("zero-value audience = %v, want unknown", got)
	}

	cases := []struct {
		name        string
		channelType string
		chatType    string
		want        ChatAudience
	}{
		{name: "group binding", channelType: ChannelTypeSlack, chatType: ChatTypeGroup, want: ChatAudienceGroup},
		{name: "direct binding", channelType: ChannelTypeFeishu, chatType: ChatTypeP2P, want: ChatAudienceDirect},
		{name: "web chat", want: ChatAudienceDirect},
		{name: "old server", channelType: ChannelTypeSlack, want: ChatAudienceUnknown},
		{name: "future discriminator", channelType: ChannelTypeSlack, chatType: "broadcast", want: ChatAudienceUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AudienceOf(tc.channelType, tc.chatType); got != tc.want {
				t.Errorf("AudienceOf(%q, %q) = %v, want %v", tc.channelType, tc.chatType, got, tc.want)
			}
		})
	}
}
