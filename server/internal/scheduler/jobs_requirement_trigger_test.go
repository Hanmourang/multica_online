package scheduler

import (
	"context"
	"errors"
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

// TestRequirementTriggerSweepJobSpec pins the cadence contract from spec §7.1
// (30s loop) and the lease/retry shape shared with the other global jobs.
func TestRequirementTriggerSweepJobSpec(t *testing.T) {
	job := RequirementTriggerSweepJob(stubRequirementTriggerSweeper{})
	if job.Name != JobNameRequirementTriggerSweep {
		t.Fatalf("unexpected job name %q", job.Name)
	}
	if job.Cadence != 30*time.Second {
		t.Fatalf("spec §7.1 pins a 30s sweep cadence, got %s", job.Cadence)
	}
	if !job.AllowStaleReentry {
		t.Fatal("stale reentry must stay on: the execrows guard makes re-sweeping safe")
	}
	scopes, err := job.Scopes(context.Background(), time.Now())
	if err != nil || len(scopes) != 1 || scopes[0] != ScopeGlobal {
		t.Fatalf("expected the singleton global scope, got %v, %v", scopes, err)
	}
}

// TestRequirementTriggerSweepHandler maps the sweeper's triggered count onto
// RowsAffected and propagates failures so the manager records a FAILED attempt
// (the next tick re-sweeps; the triggered_at guard keeps that idempotent).
func TestRequirementTriggerSweepHandler(t *testing.T) {
	handler := makeRequirementTriggerSweepHandler(stubRequirementTriggerSweeper{triggered: 2})
	res, err := handler(context.Background(), HandlerInput{})
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if res.RowsAffected != 2 {
		t.Fatalf("expected RowsAffected=2, got %d", res.RowsAffected)
	}

	wantErr := errors.New("db down")
	handler = makeRequirementTriggerSweepHandler(stubRequirementTriggerSweeper{err: wantErr})
	if _, err := handler(context.Background(), HandlerInput{}); !errors.Is(err, wantErr) {
		t.Fatalf("expected the sweeper error to propagate, got %v", err)
	}
}

type stubRequirementTriggerSweeper struct {
	triggered int
	err       error
}

func (s stubRequirementTriggerSweeper) SweepRequirementTriggers(context.Context) (int, error) {
	return s.triggered, s.err
}
