package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/service"
)

// The Skills page lists platform skills from /api/builtin-skills, which carries
// name + description only. Reading what a skill actually tells an agent (and
// previewing its supporting files) needs the detail endpoint; these tests pin
// the two things that make that preview trustworthy: the body is really the
// embedded SKILL.md, and the file list matches what the runtime ships.
func TestGetBuiltinSkillReturnsBodyAndFiles(t *testing.T) {
	if testHandler == nil {
		t.Skip("requires DB")
	}
	if testHandler.TaskService == nil {
		t.Skip("handler has no task service")
	}

	builtins := testHandler.TaskService.BuiltinSkills()
	if len(builtins) == 0 {
		t.Fatal("no builtin skills embedded in the binary")
	}

	// Pick a skill that actually ships a supporting file so the file list is
	// exercised rather than always answering `[]`.
	var target service.AgentSkillData
	for _, s := range builtins {
		if len(s.Files) > 0 {
			target = s
			break
		}
	}
	if target.Name == "" {
		t.Fatal("no builtin skill ships a supporting file")
	}

	// Routed through a real mux rather than injecting the URL param: chi matches
	// on r.URL.RawPath whenever it differs from the decoded path, so the ref id
	// arrives still percent-encoded (`builtin%3A<name>`, what encodeURIComponent
	// sends). Handing the param in directly hid exactly that and the Skills page
	// 404'd on every platform skill.
	fetch := func(t *testing.T, id string) (*httptest.ResponseRecorder, builtinSkillDetail) {
		t.Helper()
		mux := chi.NewRouter()
		mux.Get("/api/builtin-skills/{id}", testHandler.GetBuiltinSkill)
		w := httptest.NewRecorder()
		target := "/api/builtin-skills/" + strings.ReplaceAll(id, ":", "%3A")
		mux.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		var body builtinSkillDetail
		if w.Code == http.StatusOK {
			if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
				t.Fatalf("decode body: %v", err)
			}
		}
		return w, body
	}

	t.Run("by ref id", func(t *testing.T) {
		w, body := fetch(t, service.BuiltinSkillID(target.Name))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
		}
		if body.ID != service.BuiltinSkillID(target.Name) {
			t.Fatalf("id = %q, want %q", body.ID, service.BuiltinSkillID(target.Name))
		}
		if body.Name != target.Name {
			t.Fatalf("name = %q, want %q", body.Name, target.Name)
		}
		if body.Content == "" {
			t.Fatal("content is empty; the viewer would show a blank page")
		}
		if body.Content != target.Content {
			t.Fatal("content differs from the SKILL.md the runtime receives")
		}
		if len(body.Files) != len(target.Files) {
			t.Fatalf("files = %d, want %d", len(body.Files), len(target.Files))
		}
		for i, f := range target.Files {
			if body.Files[i].Path != f.Path || body.Files[i].Content != f.Content {
				t.Fatalf("file %d = %+v, want path %q", i, body.Files[i], f.Path)
			}
		}
	})

	t.Run("bare name is accepted", func(t *testing.T) {
		w, body := fetch(t, target.Name)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
		}
		if body.ID != service.BuiltinSkillID(target.Name) {
			t.Fatalf("id = %q, want %q", body.ID, service.BuiltinSkillID(target.Name))
		}
	})

	t.Run("unknown name", func(t *testing.T) {
		w, _ := fetch(t, "builtin:not-a-skill")
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", w.Code)
		}
	})

	t.Run("empty id", func(t *testing.T) {
		w, _ := fetch(t, "builtin:")
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", w.Code)
		}
	})
}
