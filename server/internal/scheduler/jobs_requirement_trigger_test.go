package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"
)

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
