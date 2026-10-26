package handler

import (
	"strings"
	"testing"
)

func TestFormatProjectChatIndexListsOpenWorkAndResources(t *testing.T) {
	got := formatProjectChatIndex(
		"Desk",
		"Ship the chat composer.",
		[]ProjectResourceData{{
			ResourceType: "github_repo",
			ResourceRef:  []byte(`{"url":"https://github.com/example/desk"}`),
			Label:        "Desk repo",
		}},
		[]projectChatIssue{{
			Number:        7,
			Title:         "Composer project picker",
			Status:        "todo",
			Goal:          "Show existing projects",
			IsRequirement: true,
		}},
		3,
		1,
	)
	for _, want := range []string{
		`Project index for "Desk"`,
		".multica/project/index.md",
		"Description:\nShip the chat composer.",
		"github_repo https://github.com/example/desk — Desk repo",
		"Open work (3 open, 1 closed, showing 1 newest):",
		"- req_7 · todo · Composer project picker — Show existing projects",
		"Do not run `multica issue list`",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("index missing %q\n%s", want, got)
		}
	}
}

func TestFormatProjectChatIndexEmptyProject(t *testing.T) {
	got := formatProjectChatIndex("Empty", "", nil, nil, 0, 4)
	for _, want := range []string{
		"Resources:\n- none",
		"Open work (0 open, 4 closed):",
		"- none",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("index missing %q\n%s", want, got)
		}
	}
}
