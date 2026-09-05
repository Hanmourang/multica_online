package handler

import (
        "context"
        "encoding/json"
        "fmt"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

// TestDecomposeRequirement covers POST /api/issues/{id}/decompose (spec §8/§9):
// confirm/auto modes materialize the stage-2 PM child task from the roster
// snapshot; manual mode returns the draft template schema without creating
// anything. The PM must have an enabled roster row, and decomposition is
// one-shot — a second start is a 409.
func TestDecomposeRequirement(t *testing.T) {
        ctx := context.Background()
        suffix := fmt.Sprintf("%d", time.Now().UnixNano())

        insertRequirement := func(t *testing.T, decomposeMode, goal string, repoResourceID *string) string {
                t.Helper()
                // 走 workspace.issue_counter 分配号段，与 IssueService.Create 的
                // AllocateIssueNumber 同源，避免子任务建号撞唯一约束。
                var number int
                if err := testPool.QueryRow(ctx, `
                        UPDATE workspace
                        SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
                        WHERE id = $1 RETURNING issue_counter
                `, testWorkspaceID).Scan(&number); err != nil {
                        t.Fatalf("next issue number: %v", err)
                }
                var id string
                if err := testPool.QueryRow(ctx, `
                        INSERT INTO issue (
                                workspace_id, title, status, priority, creator_type, creator_id,
                                number, position, goal, decompose_mode, repo_resource_id
                        )
                        VALUES (
                                $1, $2, 'todo', 'none', 'member', $3,
                                $4, 100, $5, $6, $7
                        )
                        RETURNING id
                `, testWorkspaceID, "Decompose "+suffix, testUserID, number, goal, decomposeMode, repoResourceID).Scan(&id); err != nil {
                        t.Fatalf("insert requirement: %v", err)
                }
                t.Cleanup(func() {
                        testPool.Exec(context.Background(), `DELETE FROM issue_role_assignment WHERE issue_id = $1`, id)
                        testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1 OR parent_issue_id = $1`, id)
                })
                return id
        }

        insertRosterRow := func(t *testing.T, issueID, role, assigneeType, assigneeID string, enabled bool) {
                t.Helper()
                if _, err := testPool.Exec(ctx, `
                        INSERT INTO issue_role_assignment (issue_id, workspace_id, role, assignee_type, assignee_id, enabled, ordinal)
                        VALUES ($1, $2, $3, $4, $5, $6, 0)
                `, issueID, testWorkspaceID, role, assigneeType, assigneeID, enabled); err != nil {
                        t.Fatalf("insert roster row: %v", err)
                }
        }

        setupProjectWithRepo := func(t *testing.T, repoLabel string) (projectID, repoResourceID string) {
                t.Helper()
                if err := testPool.QueryRow(ctx, `
                        INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id
                `, testWorkspaceID, "Decompose project "+suffix).Scan(&projectID); err != nil {
                        t.Fatalf("insert project: %v", err)
                }
                t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID) })
                if err := testPool.QueryRow(ctx, `
                        INSERT INTO project_resource (project_id, workspace_id, resource_type, resource_ref, label)
                        VALUES ($1, $2, 'repo', '{}'::jsonb, $3)
                        RETURNING id
                `, projectID, testWorkspaceID, repoLabel).Scan(&repoResourceID); err != nil {
                        t.Fatalf("insert repo resource: %v", err)
                }
                return projectID, repoResourceID
        }

        t.Run("confirm mode creates the stage-2 PM task with goal and repo in the brief", func(t *testing.T) {
                _, repoID := setupProjectWithRepo(t, "multica/app")
                issueID := insertRequirement(t, "confirm", "把积分规则引擎化", &repoID)
                insertRosterRow(t, issueID, "pm", "member", testUserID, true)
                insertRosterRow(t, issueID, "developer", "member", testUserID, true)

                w := httptest.NewRecorder()
                req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
                req = withURLParam(req, "id", issueID)
                testHandler.DecomposeRequirement(w, req)
                if w.Code != http.StatusCreated {
                        t.Fatalf("DecomposeRequirement: expected 201, got %d: %s", w.Code, w.Body.String())
                }
                var resp IssueResponse
                if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
                        t.Fatalf("decode response: %v", err)
                }

                var stage int32
                var parentID, assigneeID, description string
                if err := testPool.QueryRow(ctx, `
                        SELECT stage, parent_issue_id::text, assignee_id::text, COALESCE(description, '')
                        FROM issue WHERE id = $1
                `, resp.ID).Scan(&stage, &parentID, &assigneeID, &description); err != nil {
                        t.Fatalf("read created child: %v", err)
                }
                if stage != 2 {
                        t.Fatalf("expected stage=2, got %d", stage)
                }
                if parentID != issueID {
                        t.Fatalf("expected parent %s, got %s", issueID, parentID)
                }
                if assigneeID != testUserID {
                        t.Fatalf("expected pm assignee %s, got %s", testUserID, assigneeID)
                }
                if !strings.Contains(description, "把积分规则引擎化") {
                        t.Fatalf("expected goal in the brief, got: %s", description)
                }
                if !strings.Contains(description, "multica/app") {
                        t.Fatalf("expected repo label in the brief, got: %s", description)
                }
        })

        t.Run("no enabled pm in the roster is a 409", func(t *testing.T) {
                issueID := insertRequirement(t, "confirm", "目标", nil)
                insertRosterRow(t, issueID, "pm", "member", testUserID, false)

                w := httptest.NewRecorder()
                req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
                req = withURLParam(req, "id", issueID)
                testHandler.DecomposeRequirement(w, req)
                if w.Code != http.StatusConflict {
                        t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
                }
                if !strings.Contains(w.Body.String(), "pm role") {
                        t.Fatalf("expected pm role message, got %s", w.Body.String())
                }
        })

        t.Run("a second start is rejected once a stage-2 task exists", func(t *testing.T) {
                issueID := insertRequirement(t, "confirm", "目标", nil)
                insertRosterRow(t, issueID, "pm", "member", testUserID, true)

                first := httptest.NewRecorder()
                req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
                req = withURLParam(req, "id", issueID)
                testHandler.DecomposeRequirement(first, req)
                if first.Code != http.StatusCreated {
                        t.Fatalf("first decompose: expected 201, got %d: %s", first.Code, first.Body.String())
                }

                second := httptest.NewRecorder()
                req2 := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
                req2 = withURLParam(req2, "id", issueID)
                testHandler.DecomposeRequirement(second, req2)
                if second.Code != http.StatusConflict {
                        t.Fatalf("second decompose: expected 409, got %d: %s", second.Code, second.Body.String())
                }
        })

        t.Run("manual mode returns the draft template schema and creates nothing", func(t *testing.T) {
                issueID := insertRequirement(t, "manual", "目标", nil)
                insertRosterRow(t, issueID, "pm", "member", testUserID, true)

                w := httptest.NewRecorder()
                req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
                req = withURLParam(req, "id", issueID)
                testHandler.DecomposeRequirement(w, req)
                if w.Code != http.StatusOK {
                        t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
                }
                if !strings.Contains(w.Body.String(), "feature_points") ||
                        !strings.Contains(w.Body.String(), "acceptance_spec") {
                        t.Fatalf("expected template schema keys, got %s", w.Body.String())
                }

                var childCount int
                if err := testPool.QueryRow(ctx,
                        `SELECT COUNT(*) FROM issue WHERE parent_issue_id = $1`, issueID,
                ).Scan(&childCount); err != nil {
                        t.Fatalf("count children: %v", err)
                }
                if childCount != 0 {
                        t.Fatalf("manual mode must not create children, found %d", childCount)
                }
        })

        t.Run("auto mode with an agent pm also enqueues the run", func(t *testing.T) {
                var agentID string
                if err := testPool.QueryRow(ctx, `
                        INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config,
                                runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id,
                                instructions, custom_env, custom_args)
                        VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'private', 'public_to', 1, $4,
                                '', '{}'::jsonb, '[]'::jsonb)
                        RETURNING id
                `, testWorkspaceID, "decompose-pm-"+suffix, handlerTestRuntimeID(t), testUserID).Scan(&agentID); err != nil {
                        t.Fatalf("insert agent: %v", err)
                }
                t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID) })

                issueID := insertRequirement(t, "auto", "自动拆解目标", nil)
                insertRosterRow(t, issueID, "pm", "agent", agentID, true)

                w := httptest.NewRecorder()
                req := newRequest("POST", "/api/issues/"+issueID+"/decompose", nil)
                req = withURLParam(req, "id", issueID)
                testHandler.DecomposeRequirement(w, req)
                if w.Code != http.StatusCreated {
                        t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
                }
                var resp IssueResponse
                if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
                        t.Fatalf("decode response: %v", err)
                }

                var queued int
                if err := testPool.QueryRow(ctx,
                        `SELECT COUNT(*) FROM agent_task_queue WHERE issue_id = $1 AND agent_id = $2`,
                        resp.ID, agentID,
                ).Scan(&queued); err != nil {
                        t.Fatalf("count queued tasks: %v", err)
                }
                if queued != 1 {
                        t.Fatalf("expected 1 queued agent task, got %d", queued)
                }
        })
}
