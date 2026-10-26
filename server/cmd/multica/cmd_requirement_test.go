package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
