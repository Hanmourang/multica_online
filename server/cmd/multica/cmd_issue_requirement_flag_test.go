package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

// newRequirementFlagCmd mirrors the create/update flag set that
// applyRequirementFields inspects, so the derivation rules can be exercised
// without the global command (whose flag.Changed state leaks between tests).
func newRequirementFlagCmd(t *testing.T) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{}
	cmd.Flags().String("goal", "", "")
	cmd.Flags().String("start-at", "", "")
	cmd.Flags().String("start-date", "", "")
	cmd.Flags().String("due-date", "", "")
	cmd.Flags().Bool("requirement", false, "")
	cmd.Flags().String("repo-resource", "", "")
	cmd.Flags().String("decompose-mode", "", "")
	cmd.Flags().Bool("auto-trigger", false, "")
	return cmd
}

func setFlag(t *testing.T, cmd *cobra.Command, name, value string) {
	t.Helper()
	if err := cmd.Flags().Set(name, value); err != nil {
		t.Fatalf("set --%s: %v", name, err)
	}
}

func TestRequirementFlagDerivesStartAtFromStartDate(t *testing.T) {
	cmd := newRequirementFlagCmd(t)
	setFlag(t, cmd, "requirement", "true")
	setFlag(t, cmd, "start-date", "2026-10-27")

	body := map[string]any{"start_date": "2026-10-27"}
	if err := applyRequirementFields(cmd, body); err != nil {
		t.Fatalf("applyRequirementFields: %v", err)
	}
	got, _ := body["start_at"].(string)
	if !strings.HasPrefix(got, "2026-10-27T09:00:00") {
		t.Fatalf("start_at = %q, want it to land on 2026-10-27 09:00 local", got)
	}
	parsed, err := time.Parse(time.RFC3339, got)
	if err != nil {
		t.Fatalf("derived start_at is not RFC3339: %v", err)
	}
	if parsed.Hour() != 9 {
		t.Fatalf("derived hour = %d, want 9", parsed.Hour())
	}
}

func TestRequirementFlagFallsBackToDueDate(t *testing.T) {
	cmd := newRequirementFlagCmd(t)
	setFlag(t, cmd, "requirement", "true")
	setFlag(t, cmd, "due-date", "2026-11-03")

	body := map[string]any{"due_date": "2026-11-03"}
	if err := applyRequirementFields(cmd, body); err != nil {
		t.Fatalf("applyRequirementFields: %v", err)
	}
	got, _ := body["start_at"].(string)
	if !strings.HasPrefix(got, "2026-11-03T09:00:00") {
		t.Fatalf("start_at = %q, want the due-date fallback 2026-11-03T09:00:00", got)
	}
}

func TestRequirementFlagKeepsExplicitStartAt(t *testing.T) {
	cmd := newRequirementFlagCmd(t)
	setFlag(t, cmd, "requirement", "true")
	setFlag(t, cmd, "start-date", "2026-10-27")
	setFlag(t, cmd, "start-at", "2026-10-30T14:30:00+08:00")

	body := map[string]any{}
	if err := applyRequirementFields(cmd, body); err != nil {
		t.Fatalf("applyRequirementFields: %v", err)
	}
	if got, _ := body["start_at"].(string); got != "2026-10-30T14:30:00+08:00" {
		t.Fatalf("start_at = %q, want the explicit --start-at value", got)
	}
}

// The task path must stay byte-for-byte unchanged: dates alone are plain
// scheduling and never promote an issue.
func TestDatesWithoutRequirementFlagLeaveStartAtUnset(t *testing.T) {
	cmd := newRequirementFlagCmd(t)
	setFlag(t, cmd, "start-date", "2026-10-27")
	setFlag(t, cmd, "due-date", "2026-11-03")

	body := map[string]any{"start_date": "2026-10-27", "due_date": "2026-11-03"}
	if err := applyRequirementFields(cmd, body); err != nil {
		t.Fatalf("applyRequirementFields: %v", err)
	}
	if got, ok := body["start_at"]; ok {
		t.Fatalf("start_at = %v, want it absent so the issue stays a task", got)
	}
}

func TestRequirementFlagRejectsBadStartDate(t *testing.T) {
	cmd := newRequirementFlagCmd(t)
	setFlag(t, cmd, "requirement", "true")
	setFlag(t, cmd, "start-date", "2026/10/27")

	body := map[string]any{}
	if err := applyRequirementFields(cmd, body); err == nil {
		t.Fatal("want an error for a non YYYY-MM-DD --start-date")
	}
}

func TestWarnTaskNotOnCalendar(t *testing.T) {
	taskBody := map[string]any{"start_date": "2026-10-27", "due_date": "2026-11-03"}
	var out bytes.Buffer
	cmd := newRequirementFlagCmd(t)
	cmd.SetErr(&out)
	warnTaskNotOnCalendar(cmd, taskBody)
	if !strings.Contains(out.String(), "--requirement") {
		t.Fatalf("stderr = %q, want a hint that --requirement puts it on the calendar", out.String())
	}

	// A scheduled requirement, a sub-issue, and a dateless issue all stay quiet.
	quiet := []map[string]any{
		{"start_at": "2026-10-27T09:00:00+08:00", "start_date": "2026-10-27"},
		{"start_date": "2026-10-27", "parent_issue_id": "01a17458-d466-72e6-949b-07bcd8db569d"},
		{"title": "no dates"},
	}
	for _, body := range quiet {
		var buf bytes.Buffer
		c := newRequirementFlagCmd(t)
		c.SetErr(&buf)
		warnTaskNotOnCalendar(c, body)
		if buf.Len() != 0 {
			t.Fatalf("body %v produced stderr %q, want silence", body, buf.String())
		}
	}
}
