package scheduler

import (
	"context"
	"testing"
	"time"
)

// TestTriggerPreflight pins the trigger preflight decision table (open
// question #10 in the phase-1 plan): v1 preflight is exactly
// "decomposition confirmed + dependency DAG acyclic + acceptance spec
// present + module mutex window free". Order matters — the first failing
// gate wins so the audit reason is stable across sweeps.
func TestTriggerPreflight(t *testing.T) {
	ok := triggerPreflightInput{
		DecompositionConfirmed: true,
		DependencyAcyclic:      true,
		AcceptanceSpecPresent:  true,
		ModuleWindowFree:       true,
	}
	cases := []struct {
		name       string
		mutate     func(*triggerPreflightInput)
		wantPass   bool
		wantReason string
	}{
		{"all green passes", func(*triggerPreflightInput) {}, true, ""},
		{"decomposition not confirmed", func(in *triggerPreflightInput) { in.DecompositionConfirmed = false }, false, "decomposition_not_confirmed"},
		{"dependency cycle", func(in *triggerPreflightInput) { in.DependencyAcyclic = false }, false, "dependency_cycle"},
		{"acceptance spec missing", func(in *triggerPreflightInput) { in.AcceptanceSpecPresent = false }, false, "acceptance_spec_missing"},
		{"module window busy", func(in *triggerPreflightInput) { in.ModuleWindowFree = false }, false, "module_window_busy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := ok
			tc.mutate(&in)
			pass, reason := triggerPreflight(in)
			if pass != tc.wantPass || reason != tc.wantReason {
				t.Fatalf("triggerPreflight(%+v) = (%v,%q), want (%v,%q)", in, pass, reason, tc.wantPass, tc.wantReason)
			}
		})
	}
}

// TestDependencyGraphAcyclic covers the three-colour DFS used to reject
// requirement groups whose stage-3 children form a blocked_by cycle.
// A cyclic group must never be triggered: the 451 claim gate would keep
// every child queued forever, silently stalling the requirement.
func TestDependencyGraphAcyclic(t *testing.T) {
	acyclic := [][2]string{{"a", "b"}, {"b", "c"}, {"a", "c"}}
	if !dependencyGraphAcyclic(acyclic) {
		t.Fatal("expected acyclic graph to report true")
	}
	cyclic := [][2]string{{"a", "b"}, {"b", "c"}, {"c", "a"}}
	if dependencyGraphAcyclic(cyclic) {
		t.Fatal("expected cyclic graph to report false")
	}
	if !dependencyGraphAcyclic(nil) {
		t.Fatal("empty edge set is trivially acyclic")
	}
	selfLoop := [][2]string{{"a", "a"}}
	if dependencyGraphAcyclic(selfLoop) {
		t.Fatal("self-loop is a cycle")
	}
	disconnected := [][2]string{{"a", "b"}, {"c", "d"}, {"d", "c"}}
	if dependencyGraphAcyclic(disconnected) {
		t.Fatal("cycle in a disconnected component must still be detected")
	}
}

// TestAcceptanceSpecNonEmpty pins the JSONB "actually filled" heuristic:
// column default '{}' / 'null' / empty bytes all count as absent so the
// acceptance_spec_missing preflight reason fires on freshly-decomposed
// groups that never wrote criteria.
func TestAcceptanceSpecNonEmpty(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
		want bool
	}{
		{"nil bytes", nil, false},
		{"empty bytes", []byte(""), false},
		{"whitespace", []byte("   \n"), false},
		{"json null", []byte("null"), false},
		{"empty object (column default)", []byte("{}"), false},
		{"empty object with space", []byte(" { } "), false},
		{"empty array", []byte("[]"), false},
		{"filled object", []byte(`{"criteria":["x"]}`), true},
		{"filled array", []byte(`[{"id":1}]`), true},
		{"scalar string", []byte(`"pass"`), true},
		{"invalid json is treated as absent", []byte(`{oops`), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := acceptanceSpecNonEmpty(tc.raw); got != tc.want {
				t.Fatalf("acceptanceSpecNonEmpty(%q) = %v, want %v", string(tc.raw), got, tc.want)
			}
		})
	}
}

// TestRequirementTriggerJobSpec pins the cadence contract from spec §7.1
// (30s sweep) and the lease/retry shape shared with the other global jobs.
// Also asserts the spec satisfies JobSpec.validate invariants — a
// regression here would silently disable the whole trigger loop at
// manager.Register time.
func TestRequirementTriggerJobSpec(t *testing.T) {
	job := RequirementTriggerJob(nil, nil, nil)
	if job.Name != JobNameRequirementTrigger {
		t.Fatalf("unexpected job name %q", job.Name)
	}
	if job.Cadence != 30*time.Second {
		t.Fatalf("spec §7.1 pins a 30s sweep cadence, got %s", job.Cadence)
	}
	if !job.AllowStaleReentry {
		t.Fatal("stale reentry must stay on: MarkRequirementTriggered's execrows guard makes re-sweeping safe")
	}
	if job.CatchUpMode != CatchUpLatestOnly {
		t.Fatalf("expected CatchUpLatestOnly (one sweep catches up all past-due rows), got %s", job.CatchUpMode)
	}
	if job.Handler == nil {
		t.Fatal("handler must be non-nil")
	}
	if job.Scopes == nil {
		t.Fatal("scopes provider must be non-nil")
	}
	scopes, err := job.Scopes(context.Background(), time.Now())
	if err != nil || len(scopes) != 1 || scopes[0] != ScopeGlobal {
		t.Fatalf("expected the singleton global scope, got %v, %v", scopes, err)
	}
	// JobSpec.validate is package-private; assert the same invariants it
	// enforces so a spec drift is caught here rather than at register time.
	if job.RunTimeout <= 0 || job.StaleTimeout <= job.RunTimeout {
		t.Fatalf("timeout ordering broken: run=%s stale=%s", job.RunTimeout, job.StaleTimeout)
	}
	if job.HeartbeatInterval <= 0 || job.HeartbeatInterval >= job.StaleTimeout {
		t.Fatalf("heartbeat ordering broken: hb=%s stale=%s", job.HeartbeatInterval, job.StaleTimeout)
	}
	if job.MaxAttempts < 1 {
		t.Fatalf("MaxAttempts must be >= 1, got %d", job.MaxAttempts)
	}
}
