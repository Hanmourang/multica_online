package handler

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestSplitIdentifierKindAndLegacy(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in     string
		prefix string
		number int32
	}{
		{"req_12", "req", 12},
		{"task_3", "task", 3},
		{"REQ_99", "REQ", 99},
		{"MUL-1745", "MUL", 1745},
	}
	for _, tc := range cases {
		got := splitIdentifier(tc.in)
		if got == nil {
			t.Fatalf("splitIdentifier(%q) = nil", tc.in)
		}
		if got.prefix != tc.prefix || got.number != tc.number {
			t.Fatalf("splitIdentifier(%q) = %+v, want %s/%d", tc.in, got, tc.prefix, tc.number)
		}
	}
}

func TestFormatKindIdentifier(t *testing.T) {
	t.Parallel()
	if got := formatKindIdentifier(true, 12); got != "req_12" {
		t.Fatalf("requirement = %q", got)
	}
	if got := formatKindIdentifier(false, 3); got != "task_3" {
		t.Fatalf("task = %q", got)
	}
}

func TestIssueKindIsRequirement(t *testing.T) {
	t.Parallel()
	var start pgtype.Timestamptz
	start.Valid = true
	if !issueKindIsRequirement(false, start, pgtype.Timestamptz{}, pgtype.Timestamptz{}, pgtype.UUID{}) {
		t.Fatal("top-level with start_at should be a requirement")
	}
	if issueKindIsRequirement(true, start, pgtype.Timestamptz{}, pgtype.Timestamptz{}, pgtype.UUID{}) {
		t.Fatal("child issue should stay a task even with start_at")
	}
	if issueKindIsRequirement(false, pgtype.Timestamptz{}, pgtype.Timestamptz{}, pgtype.Timestamptz{}, pgtype.UUID{}) {
		t.Fatal("standalone task without pipeline fields should not be a requirement")
	}
}
