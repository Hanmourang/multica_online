package scheduler

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestRequirementTriggerWorkflowGate 覆盖需求触发首门强门控的真实库决策链
// （CoCo 对标 plan 20261024 §4 / §10）：resolveWorkflowGate 在三种数据状态下
// 返回的 (required, satisfied, err)：
//  1. 项目无 published+enforce 模板 → (false,false,nil) —— 零回归；
//  2. 有 enforce 模板但需求实例未过首门 → (true,false,nil) —— 触发应被拦（409）；
//  3. 有 enforce 模板且实例已有 decided(exit) 门 → (true,true,nil) —— 放行。
//
// 走 integrationPool（真实 PG@DATABASE_URL），无库时自动 skip。
func TestRequirementTriggerWorkflowGate(t *testing.T) {
	pool := integrationPool(t)
	q := db.New(pool)
	ctx := context.Background()
	suffix := "wfgate-" + uniqueSuffix()

	var wsID pgtype.UUID
	mustScan(t, pool.QueryRow(ctx,
		`INSERT INTO workspace (name, slug) VALUES ($1, $1) RETURNING id`, suffix), &wsID)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, wsID)
	})

	var projID pgtype.UUID
	mustScan(t, pool.QueryRow(ctx,
		`INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id`, wsID, "gate project "+suffix), &projID)

	// 需求 issue 归属该项目（creator_type/creator_id NOT NULL 无 FK，可任意 uuid）。
	var req db.Issue
	var reqID pgtype.UUID
	mustScan(t, pool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, project_id, title, creator_type, creator_id)
		VALUES ($1, $2, $3, 'member', gen_random_uuid()) RETURNING id`, wsID, projID, "requirement "+suffix), &reqID)
	var err error
	req, err = q.GetIssue(ctx, reqID)
	if err != nil {
		t.Fatalf("load seeded issue: %v", err)
	}

	t.Run("no enforce template is zero-regression", func(t *testing.T) {
		required, satisfied, err := resolveWorkflowGate(ctx, q, req)
		if err != nil {
			t.Fatalf("resolveWorkflowGate: %v", err)
		}
		if required || satisfied {
			t.Fatalf("no enforce: got (required=%v,satisfied=%v), want (false,false)", required, satisfied)
		}
	})

	// 建一张 published+enforce 模板挂到项目上。
	var tplID pgtype.UUID
	mustScan(t, pool.QueryRow(ctx, `
		INSERT INTO workflow_template (workspace_id, project_id, name, status, definition, enforce, created_by_type, created_by_id)
		VALUES ($1, $2, $3, 'published', '{}'::jsonb, true, 'member', gen_random_uuid()) RETURNING id`,
		wsID, projID, "enforced tpl "+suffix), &tplID)

	t.Run("enforce template without cleared gate blocks", func(t *testing.T) {
		required, satisfied, err := resolveWorkflowGate(ctx, q, req)
		if err != nil {
			t.Fatalf("resolveWorkflowGate: %v", err)
		}
		if !required {
			t.Fatal("required = false, want true (project has published+enforce template)")
		}
		if satisfied {
			t.Fatal("satisfied = true before any gate decided, want false")
		}
	})

	// 为该需求发起一个实例，并让首个门 decided(exit) → 视为已过首门。
	seedGateClearedInstance(t, pool, ctx, wsID, projID, tplID, reqID)

	t.Run("enforce template with cleared gate passes", func(t *testing.T) {
		required, satisfied, err := resolveWorkflowGate(ctx, q, req)
		if err != nil {
			t.Fatalf("resolveWorkflowGate: %v", err)
		}
		if !required {
			t.Fatal("required = false, want true")
		}
		if !satisfied {
			t.Fatal("satisfied = false after first gate decided(exit), want true")
		}
	})
}

// seedGateClearedInstance 建一条 root_issue=reqID 的实例 + 一个 stage_run + 一个
// decided(exit) 的 human 门，使 CountRequirementWorkflowGateCleared 返回 >0。
func seedGateClearedInstance(t *testing.T, pool *pgxpool.Pool, ctx context.Context, wsID, projID, tplID, reqID pgtype.UUID) {
	t.Helper()
	var instID pgtype.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO workflow_instance (workspace_id, project_id, template_id, template_version, root_issue_id, started_by_type, started_by_id)
		VALUES ($1, $2, $3, 1, $4, 'member', gen_random_uuid()) RETURNING id`,
		wsID, projID, tplID, reqID).Scan(&instID); err != nil {
		t.Fatalf("seed instance: %v", err)
	}
	var stageID pgtype.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO workflow_stage_run (instance_id, workspace_id, seq, node_id, name, mode)
		VALUES ($1, $2, 1, 's1', '编写', 'human') RETURNING id`, instID, wsID).Scan(&stageID); err != nil {
		t.Fatalf("seed stage_run: %v", err)
	}
	var gateID pgtype.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO workflow_gate_run (instance_id, stage_run_id, workspace_id, mode, state, decision)
		VALUES ($1, $2, $3, 'human', 'decided', 'exit') RETURNING id`, instID, stageID, wsID).Scan(&gateID); err != nil {
		t.Fatalf("seed gate_run: %v", err)
	}
}
