package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequirementCreateSendsStartAt(t *testing.T) {
	var body map[string]any
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "req-1", "identifier": "req_1", "title": "Ship calendar",
		})
	}))
	defer srv.Close()

	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	cmd := requirementCreateCmd
	_ = cmd.Flags().Set("title", "Ship calendar")
	_ = cmd.Flags().Set("start-at", "2026-11-02T09:00:00Z")
	_ = cmd.Flags().Set("goal", "Agents can file requirements")
	if err := runRequirementCreate(cmd, nil); err != nil {
		t.Fatalf("runRequirementCreate: %v", err)
	}
	if method != http.MethodPost || path != "/api/issues" {
		t.Fatalf("request = %s %s", method, path)
	}
	if body["start_at"] != "2026-11-02T09:00:00Z" || body["goal"] != "Agents can file requirements" {
		t.Fatalf("body = %#v", body)
	}
	if body["decompose_mode"] != "confirm" {
		t.Fatalf("decompose_mode = %#v, want confirm", body["decompose_mode"])
	}
}

func TestRequirementCommandTreeOmitsDelete(t *testing.T) {
	for _, cmd := range requirementCmd.Commands() {
		if cmd.Name() == "delete" {
			t.Fatalf("requirement command must not expose delete")
		}
	}
}

// resetRequirementCreateFlags clears the global command's string flags so a
// neighbouring test that set them cannot leak into this one (cobra keeps flag
// values on the package-level command).
func resetRequirementCreateFlags(t *testing.T) {
	t.Helper()
	for _, name := range []string{"title", "start-at", "start-date", "due-date", "goal"} {
		if err := requirementCreateCmd.Flags().Set(name, ""); err != nil {
			t.Fatalf("reset --%s: %v", name, err)
		}
	}
}

// A day-granularity caller must still get a scheduled requirement: the day
// flags are what the requirements skill speaks in, so they have to carry the
// promoting start_at instead of erroring out.
func TestRequirementCreateDerivesStartAtFromDays(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]any{"id": "req-1", "identifier": "req_1"})
	}))
	defer srv.Close()

	t.Setenv("MULTICA_SERVER_URL", srv.URL)
	t.Setenv("MULTICA_WORKSPACE_ID", "ws-1")
	t.Setenv("MULTICA_TOKEN", "test-token")

	resetRequirementCreateFlags(t)
	cmd := requirementCreateCmd
	_ = cmd.Flags().Set("title", "数据分析需求")
	_ = cmd.Flags().Set("start-date", "2026-10-27")
	_ = cmd.Flags().Set("due-date", "2026-11-03")
	if err := runRequirementCreate(cmd, nil); err != nil {
		t.Fatalf("runRequirementCreate: %v", err)
	}

	startAt, _ := body["start_at"].(string)
	if !strings.HasPrefix(startAt, "2026-10-27T09:00:00") {
		t.Fatalf("start_at = %q, want the --start-date day at 09:00 local", startAt)
	}
	if body["start_date"] != "2026-10-27" || body["due_date"] != "2026-11-03" {
		t.Fatalf("body = %#v, want the day fields carried through", body)
	}
}

// No anchor at all stays a hard error — silently defaulting to "now" here would
// put an unplanned requirement on the calendar.
func TestRequirementCreateRejectsMissingStart(t *testing.T) {
	resetRequirementCreateFlags(t)
	cmd := requirementCreateCmd
	_ = cmd.Flags().Set("title", "No schedule")
	err := runRequirementCreate(cmd, nil)
	if err == nil {
		t.Fatal("want an error when no start_at / start_date / due_date is given")
	}
	if !strings.Contains(err.Error(), "--start-date") {
		t.Fatalf("error = %q, want it to name the day flags", err)
	}
}
