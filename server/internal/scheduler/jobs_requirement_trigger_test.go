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

// stubSweeper 是 requirementSweeper 的测试替身，用于覆盖 handler 的汇总映射
// 与错误穿透而无需真库（M-8：等价重建被删的 TestRequirementTriggerSweepHandler）。
type stubSweeper struct {
	summary SweepSummary
	err     error
}

func (s stubSweeper) Sweep(context.Context) (SweepSummary, error) { return s.summary, s.err }

// TestRequirementTriggerHandlerRowsAffectedAndError 断言 sweep handler 把
// Triggered 计数映射为 HandlerResult.RowsAffected、把汇总序列化进 Result，
// 并在 Sweep 失败时用 %w 包裹错误向上传递（manager 据此记 FAILED 重试）。
// 这是被删测试的等价覆盖：旧 stub 断言的正是 RowsAffected 映射 + errors.Is 穿透。
func TestRequirementTriggerHandlerRowsAffectedAndError(t *testing.T) {
	h := requirementTriggerHandler(stubSweeper{summary: SweepSummary{
		Scanned:   4,
		Triggered: 2,
		Enqueued:  5,
		Blocked:   map[string]int{"module_window_busy": 1, "error": 1},
	}})
	res, err := h(context.Background(), HandlerInput{})
	if err != nil {
		t.Fatalf("unexpected handler error: %v", err)
	}
	if res.RowsAffected != 2 {
		t.Fatalf("RowsAffected = %d, want triggered count 2", res.RowsAffected)
	}
	if got := res.Result["enqueued"]; got != 5 {
		t.Fatalf("Result[enqueued] = %v, want 5", got)
	}
	blocked, ok := res.Result["blocked"].(map[string]int)
	if !ok || blocked["module_window_busy"] != 1 || blocked["error"] != 1 {
		t.Fatalf("Result[blocked] = %v, want the per-reason tally", res.Result["blocked"])
	}

	wantErr := errors.New("sweep blew up")
	h = requirementTriggerHandler(stubSweeper{err: wantErr})
	if _, err := h(context.Background(), HandlerInput{}); !errors.Is(err, wantErr) {
		t.Fatalf("handler error = %v, want it to wrap %v (errors.Is)", err, wantErr)
	}
}

// TestRequirementTriggerHandlerContextCancel 断言 ctx 已取消时错误仍能穿透
//（manager 的租约心跳/终态写回依赖 handler 如实回传 ctx 错误，而非吞掉）。
func TestRequirementTriggerHandlerContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h := requirementTriggerHandler(contextAwareSweeper{})
	if _, err := h(ctx, HandlerInput{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("handler error = %v, want context.Canceled to propagate", err)
	}
}

// contextAwareSweeper 把 ctx.Err() 如实回传，模拟 ListTriggerableRequirements
// 在 ctx 取消时的行为。
type contextAwareSweeper struct{}

func (contextAwareSweeper) Sweep(ctx context.Context) (SweepSummary, error) {
	if err := ctx.Err(); err != nil {
		return SweepSummary{}, err
	}
	return SweepSummary{}, nil
}
