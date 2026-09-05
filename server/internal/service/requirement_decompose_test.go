// 拆解确认（spec: 2026-09-04-requirement-calendar-design.md §8/§9）：
// PM 产出的子任务草稿经确认后批量生效为 stage 3/4 子任务。本文件覆盖：
//   - 校验三类错误（功能点缺 kind / 执行人不在班底或角色停用 / 依赖跨模块）
//   - 批量生效（parent/stage/assignee/module/root/三要素落列 + 依赖链写边）
//   - decomposition_confirmed_at 写入与重复确认 409 幂等
package service

import (
        "context"
        "encoding/json"
        "errors"
        "fmt"
        "strings"
        "testing"
        "time"

        "github.com/jackc/pgx/v5/pgtype"
        "github.com/jackc/pgx/v5/pgxpool"
        db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// decomposeFixture 是一次确认测试所需的最小实体图：独立 workspace + owner
// + 项目双模块 + 需求（挂 moduleA）+ 班底（pm/dev/tester enabled，data 停用）
// + 班底外成员 + moduleB 里的跨模块 issue。全部经 t.Cleanup 清理。
type decomposeFixture struct {
        workspaceID       string
        ownerID           string
        pmUserID          string
        devUserID         string
        testerUserID      string
        disabledDataID    string
        outsiderUserID    string
        projectID         string
        moduleAID         string
        moduleBID         string
        requirementID     string
        crossModuleTaskID string
}

func seedDecomposeFixture(t *testing.T, pool *pgxpool.Pool) decomposeFixture {
        t.Helper()
        ctx := context.Background()
        suffix := fmt.Sprintf("%d", time.Now().UnixNano())
        var f decomposeFixture

        newUser := func(label string) string {
                t.Helper()
                var id string
                if err := pool.QueryRow(ctx, `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
                        label+" "+suffix, fmt.Sprintf("%s-%s@multica.test", label, suffix)).Scan(&id); err != nil {
                        t.Fatalf("seed user %s: %v", label, err)
                }
                t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id) })
                return id
        }
        f.ownerID = newUser("owner")
        f.pmUserID = newUser("pm")
        f.devUserID = newUser("dev")
        f.testerUserID = newUser("tester")
        f.disabledDataID = newUser("data")
        f.outsiderUserID = newUser("outsider")

        if err := pool.QueryRow(ctx, `INSERT INTO workspace (name, slug) VALUES ('decomp ws', $1) RETURNING id`,
                "decomp-"+suffix).Scan(&f.workspaceID); err != nil {
                t.Fatalf("seed workspace: %v", err)
        }
        t.Cleanup(func() { pool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, f.workspaceID) })
        if _, err := pool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
                f.workspaceID, f.ownerID); err != nil {
                t.Fatalf("seed member: %v", err)
        }

        if err := pool.QueryRow(ctx, `
                INSERT INTO project (workspace_id, title, status, priority)
                VALUES ($1, 'Decomp P', 'planned', 'none') RETURNING id
        `, f.workspaceID).Scan(&f.projectID); err != nil {
                t.Fatalf("seed project: %v", err)
        }
        newModule := func(name string) string {
                t.Helper()
                var id string
                if err := pool.QueryRow(ctx, `
                        INSERT INTO project_module (project_id, workspace_id, name, color)
                        VALUES ($1, $2, $3, '#888888') RETURNING id
                `, f.projectID, f.workspaceID, name).Scan(&id); err != nil {
                        t.Fatalf("seed module %s: %v", name, err)
                }
                return id
        }
        f.moduleAID = newModule("内核")
        f.moduleBID = newModule("Flow 编排")

        // issue_counter 与直插号段同源（见 handler 包既有模式）。
        nextNumber := func() int {
                t.Helper()
                var n int
                if err := pool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, f.workspaceID).Scan(&n); err != nil {
                        t.Fatalf("next issue number: %v", err)
                }
                return n
        }

        if err := pool.QueryRow(ctx, `
                INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
                        number, position, project_id, module_id, decompose_mode)
                VALUES ($1, '积分体系重构', 'todo', 'none', 'member', $2, $3, 100, $4, $5, 'confirm')
                RETURNING id
        `, f.workspaceID, f.ownerID, nextNumber(), f.projectID, f.moduleAID).Scan(&f.requirementID); err != nil {
                t.Fatalf("seed requirement: %v", err)
        }
        if err := pool.QueryRow(ctx, `
                INSERT INTO issue (workspace_id, title, status, priority, creator_type, creator_id,
                        number, position, project_id, module_id)
                VALUES ($1, 'Flow 侧老任务', 'todo', 'none', 'member', $2, $3, 100, $4, $5)
                RETURNING id
        `, f.workspaceID, f.ownerID, nextNumber(), f.projectID, f.moduleBID).Scan(&f.crossModuleTaskID); err != nil {
                t.Fatalf("seed cross-module issue: %v", err)
        }
        t.Cleanup(func() {
                pool.Exec(context.Background(), `DELETE FROM issue_dependency WHERE issue_id IN
                        (SELECT id FROM issue WHERE workspace_id = $1) OR depends_on_issue_id IN
                        (SELECT id FROM issue WHERE workspace_id = $1)`, f.workspaceID)
                pool.Exec(context.Background(), `DELETE FROM issue_role_assignment WHERE workspace_id = $1`, f.workspaceID)
                pool.Exec(context.Background(), `DELETE FROM issue WHERE workspace_id = $1`, f.workspaceID)
        })

        addRole := func(role, userID string, enabled bool) {
                t.Helper()
                if _, err := pool.Exec(ctx, `
                        INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
                        VALUES ($1, $2, $3, 'member', $4, $5, 0)
                `, f.requirementID, f.workspaceID, role, userID, enabled); err != nil {
                        t.Fatalf("seed roster %s: %v", role, err)
                }
        }
        addRole("pm", f.pmUserID, true)
        addRole("developer", f.devUserID, true)
        addRole("tester", f.testerUserID, true)
        addRole("data", f.disabledDataID, false)
        return f
}

func newDecomposeService(pool *pgxpool.Pool) *IssueService {
        return &IssueService{Queries: db.New(pool), TxStarter: pool}
}

func draftExec(tempID, title, assigneeID string, dependsOn ...string) DecomposeDraftTask {
        return DecomposeDraftTask{
                TempID:       tempID,
                Title:        title,
                Stage:        3,
                AssigneeType: "member",
                AssigneeID:   assigneeID,
                FeaturePoints: []DecomposeFeaturePoint{
                        {Title: title + " fp", Kind: "modify", CodeObjects: []string{"server/internal/x.go"}},
                },
                GraphContext:   json.RawMessage(`{"nodes":["n1"]}`),
                AcceptanceSpec: json.RawMessage(`{"version":1,"cases":[{"name":"c1"}]}`),
                DependsOn:      dependsOn,
        }
}

func TestConfirmDecompositionValidates(t *testing.T) {
        pool := newResolveOriginatorPool(t)
        ctx := context.Background()

        cases := []struct {
                name    string
                mutate  func(f decomposeFixture) []DecomposeDraftTask
                wantErr string
                want400 bool // true=400 参数错误；false=409 状态冲突
        }{
                {"功能点缺 kind", func(f decomposeFixture) []DecomposeDraftTask {
                        d := draftExec("t1", "账户模型", f.devUserID)
                        d.FeaturePoints = []DecomposeFeaturePoint{{Title: "账户模型"}}
                        return []DecomposeDraftTask{d}
                }, "feature_point kind required", true},
                {"kind 取值非法", func(f decomposeFixture) []DecomposeDraftTask {
                        d := draftExec("t1", "账户模型", f.devUserID)
                        d.FeaturePoints[0].Kind = "unknown"
                        return []DecomposeDraftTask{d}
                }, "feature_point kind required", true},
                {"执行人不在班底", func(f decomposeFixture) []DecomposeDraftTask {
                        return []DecomposeDraftTask{draftExec("t1", "账户模型", f.outsiderUserID)}
                }, "assignee not in roster", false},
                {"执行人角色已停用", func(f decomposeFixture) []DecomposeDraftTask {
                        return []DecomposeDraftTask{draftExec("t1", "账户模型", f.disabledDataID)}
                }, "assignee role disabled", false},
                {"依赖跨模块", func(f decomposeFixture) []DecomposeDraftTask {
                        return []DecomposeDraftTask{draftExec("t1", "账户模型", f.devUserID, f.crossModuleTaskID)}
                }, "dependency module mismatch", false},
        }
        for _, tc := range cases {
                t.Run(tc.name, func(t *testing.T) {
                        f := seedDecomposeFixture(t, pool)
                        svc := newDecomposeService(pool)
                        _, err := svc.ConfirmDecomposition(ctx, ConfirmDecompositionParams{
                                RequirementID: parseUUIDOrFail(t, f.requirementID),
                                Drafts:        tc.mutate(f),
                                CreatorType:   "member",
                                CreatorID:     parseUUIDOrFail(t, f.ownerID),
                        })
                        if err == nil {
                                t.Fatalf("expected error containing %q, got nil", tc.wantErr)
                        }
                        if got := err.Error(); !contains(got, tc.wantErr) {
                                t.Fatalf("error %q does not contain %q", got, tc.wantErr)
                        }
                        var valErr *DecompositionValidationError
                        var conErr *DecompositionConflictError
                        if tc.want400 {
                                if !errors.As(err, &valErr) {
                                        t.Fatalf("expected DecompositionValidationError (400), got %T: %v", err, err)
                                }
                        } else if !errors.As(err, &conErr) {
                                t.Fatalf("expected DecompositionConflictError (409), got %T: %v", err, err)
                        }
                        // 校验失败不得留下任何子任务。
                        var n int
                        if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM issue WHERE parent_issue_id = $1`,
                                f.requirementID).Scan(&n); err != nil {
                                t.Fatalf("count children: %v", err)
                        }
                        if n != 0 {
                                t.Fatalf("validation failure must not create children, got %d", n)
                        }
                })
        }
}

func TestConfirmDecompositionBatchEffect(t *testing.T) {
        pool := newResolveOriginatorPool(t)
        ctx := context.Background()
        f := seedDecomposeFixture(t, pool)
        svc := newDecomposeService(pool)

        drafts := []DecomposeDraftTask{
                draftExec("t1", "账户模型扩展", f.devUserID),
                draftExec("t2", "积分规则引擎", f.devUserID, "t1"),
                draftExec("t3", "订单对接", f.pmUserID, "t2"),
                draftExec("t4", "对账任务", f.devUserID),
                {
                        TempID:  "t5",
                        Title:   "整体验收",
                        Stage:   4,
                        DependsOn: []string{"t3", "t4"},
                        AcceptanceSpec: json.RawMessage(`{"version":1,"cases":[{"name":"全链路"}]}`),
                },
        }
        created, err := svc.ConfirmDecomposition(ctx, ConfirmDecompositionParams{
                RequirementID: parseUUIDOrFail(t, f.requirementID),
                Drafts:        drafts,
                CreatorType:   "member",
                CreatorID:     parseUUIDOrFail(t, f.ownerID),
        })
        if err != nil {
                t.Fatalf("confirm: %v", err)
        }
        if len(created) != 5 {
                t.Fatalf("expected 5 materialized issues, got %d", len(created))
        }

        // parent/stage/module/root/assignee 逐条生效。
        byTitle := map[string]db.Issue{}
        for _, iss := range created {
                byTitle[iss.Title] = iss
                if uuidToStringSvc(iss.ParentIssueID) != f.requirementID {
                        t.Errorf("%s: parent = %v, want requirement", iss.Title, iss.ParentIssueID)
                }
                if uuidToStringSvc(iss.ModuleID) != f.moduleAID {
                        t.Errorf("%s: module = %v, want moduleA", iss.Title, iss.ModuleID)
                }
                if uuidToStringSvc(iss.RootRequirementID) != f.requirementID {
                        t.Errorf("%s: root = %v, want requirement id", iss.Title, iss.RootRequirementID)
                }
        }
        for _, title := range []string{"账户模型扩展", "积分规则引擎", "订单对接", "对账任务"} {
                if byTitle[title].Stage.Int32 != 3 {
                        t.Errorf("%s: stage = %v, want 3", title, byTitle[title].Stage)
                }
        }
        acc := byTitle["整体验收"]
        if acc.Stage.Int32 != 4 {
                t.Errorf("acceptance: stage = %v, want 4", acc.Stage)
        }
        if uuidToStringSvc(acc.AssigneeID) != f.testerUserID || acc.AssigneeType.String != "member" {
                t.Errorf("acceptance assignee = %v/%v, want tester member %s", acc.AssigneeType, acc.AssigneeID, f.testerUserID)
        }
        if uuidToStringSvc(byTitle["账户模型扩展"].AssigneeID) != f.devUserID {
                t.Errorf("t1 assignee = %v, want dev", byTitle["账户模型扩展"].AssigneeID)
        }

        // 三要素原样落列。
        var fps []map[string]any
        if err := json.Unmarshal(byTitle["账户模型扩展"].FeaturePoints, &fps); err != nil || len(fps) != 1 || fps[0]["kind"] != "modify" {
                t.Errorf("feature_points round-trip failed: %s err=%v", byTitle["账户模型扩展"].FeaturePoints, err)
        }

        // 依赖链写边（type='blocked_by'）：t2→t1, t3→t2, t5→t3, t5→t4。
        rows, err := pool.Query(ctx, `
                SELECT i.title, d.title FROM issue_dependency dep
                JOIN issue i ON i.id = dep.issue_id
                JOIN issue d ON d.id = dep.depends_on_issue_id
                WHERE dep.type = 'blocked_by' AND i.parent_issue_id = $1
        `, f.requirementID)
        if err != nil {
                t.Fatalf("list dependency edges: %v", err)
        }
        edges := map[string]string{}
        for rows.Next() {
                var issueTitle, depTitle string
                if err := rows.Scan(&issueTitle, &depTitle); err != nil {
                        t.Fatalf("scan edge: %v", err)
                }
                edges[issueTitle] = edges[issueTitle] + depTitle + ";"
        }
        rows.Close()
        wantEdges := map[string][]string{
                "积分规则引擎": {"账户模型扩展"},
                "订单对接":   {"积分规则引擎"},
                "整体验收":   {"订单对接", "对账任务"},
        }
        for issueTitle, deps := range wantEdges {
                for _, depTitle := range deps {
                        if !contains(edges[issueTitle], depTitle) {
                                t.Errorf("missing edge %s -> %s (have: %v)", issueTitle, depTitle, edges)
                        }
                }
        }

        // 验收子任务 description 汇总执行子任务的验收依据。
        if acc.Description.String == "" || !contains(acc.Description.String, "账户模型扩展") {
                t.Errorf("acceptance description should aggregate exec-task specs, got %q", acc.Description.String)
        }

        // decomposition_confirmed_at 已写；重复确认 409 幂等。
        var confirmedAt pgtype.Timestamptz
        if err := pool.QueryRow(ctx, `SELECT decomposition_confirmed_at FROM issue WHERE id = $1`,
                f.requirementID).Scan(&confirmedAt); err != nil {
                t.Fatalf("read requirement: %v", err)
        }
        if !confirmedAt.Valid {
                t.Fatal("decomposition_confirmed_at should be set")
        }
        if _, err := svc.ConfirmDecomposition(ctx, ConfirmDecompositionParams{
                RequirementID: parseUUIDOrFail(t, f.requirementID),
                Drafts:        []DecomposeDraftTask{draftExec("x1", "再来一个", f.devUserID)},
                CreatorType:   "member",
                CreatorID:     parseUUIDOrFail(t, f.ownerID),
        }); !errors.Is(err, ErrDecompositionAlreadyConfirmed) {
                t.Fatalf("second confirm should be ErrDecompositionAlreadyConfirmed, got %v", err)
        }
}

func parseUUIDOrFail(t *testing.T, s string) pgtype.UUID {
        t.Helper()
        var u pgtype.UUID
        if err := u.Scan(s); err != nil {
                t.Fatalf("parse uuid %q: %v", s, err)
        }
        return u
}

func uuidToStringSvc(u pgtype.UUID) string {
        if !u.Valid {
                return ""
        }
        b, _ := u.Value()
        return b.(string)
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
