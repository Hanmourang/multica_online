package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// DM 垂直切片的真实 DB 测试（plan 20261025 §3.1 / §4）。四个测试全部用真实
// test DB + 直接调用 handler，不用 mock 替代唯一索引与参与者门控。每个用例先
// 因路由/存储未实现而 FAIL，再实现到 PASS；禁止 t.Skip 代替断言。

// dmNewMember 在测试工作区内新建一名普通成员，返回其 user id。
func dmNewMember(t *testing.T, tag string) string {
	t.Helper()
	ctx := context.Background()
	var userID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email)
		VALUES ($1, $2)
		RETURNING id
	`, "dm-"+tag, fmt.Sprintf("dm-%s@multica.test", tag)).Scan(&userID); err != nil {
		t.Fatalf("create dm user %s: %v", tag, err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM chat_participant WHERE participant_id = $1::uuid`, userID)
		testPool.Exec(context.Background(), `DELETE FROM member WHERE user_id = $1`, userID)
		testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, userID)
	})
	if _, err := testPool.Exec(ctx, `
		INSERT INTO member (workspace_id, user_id, role)
		VALUES ($1, $2, 'member')
	`, testWorkspaceID, userID); err != nil {
		t.Fatalf("add dm member %s: %v", tag, err)
	}
	return userID
}

// dmNewOutsideUser 在另一个工作区建一名用户，对本工作区而言是非成员（跨工作区目标）。
func dmNewOutsideUser(t *testing.T, tag string) string {
	t.Helper()
	ctx := context.Background()
	var userID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email)
		VALUES ($1, $2)
		RETURNING id
	`, "dm-out-"+tag, fmt.Sprintf("dm-out-%s@multica.test", tag)).Scan(&userID); err != nil {
		t.Fatalf("create outside user %s: %v", tag, err)
	}
	var otherWs string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ($1, $2, '', 'DMO')
		RETURNING id
	`, "dm-out-ws-"+tag, fmt.Sprintf("dm-out-ws-%s", tag)).Scan(&otherWs); err != nil {
		t.Fatalf("create other workspace: %v", err)
	}
	if _, err := testPool.Exec(ctx, `INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, otherWs, userID); err != nil {
		t.Fatalf("add outside member: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM member WHERE user_id = $1`, userID)
		testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, otherWs)
		testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, userID)
	})
	return userID
}

// dmAsRequest 构造以指定用户身份发起、并注入该用户在工作区成员上下文的请求，
// 复刻 workspace middleware 正常会设置的 ctx member/workspace。
func dmAsRequest(t *testing.T, method, path string, body any, asUserID, urlKey, urlVal string) *http.Request {
	t.Helper()
	req := newRequest(method, path, body)
	if asUserID != "" {
		req.Header.Set("X-User-ID", asUserID)
	}
	if urlKey != "" {
		req = withURLParam(req, urlKey, urlVal)
	}
	memberRow, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(), db.GetMemberByUserAndWorkspaceParams{
		UserID:      parseUUID(asUserID),
		WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load member ctx for %s: %v", asUserID, err)
	}
	return req.WithContext(middleware.SetMemberContext(req.Context(), testWorkspaceID, memberRow))
}

func dmCreateSession(t *testing.T, caller, target string) (int, string) {
	t.Helper()
	req := dmAsRequest(t, "POST", "/api/chat/sessions/dm", map[string]any{"member_id": target}, caller, "", "")
	w := httptest.NewRecorder()
	testHandler.CreateDMChatSession(w, req)
	if w.Code != http.StatusCreated && w.Code != http.StatusOK {
		return w.Code, w.Body.String()
	}
	var resp ChatSessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode dm resp: %v", err)
	}
	return w.Code, resp.ID
}

func TestCreateDMChatSessionConcurrentPairIsIdempotent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for DM test")
	}
	a := dmNewMember(t, "pairA")
	b := dmNewMember(t, "pairB")

	const n = 20
	codes := make([]int, n)
	ids := make([]string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		caller, target := a, b
		if i%2 == 1 {
			caller, target = b, a // B→A 与 A→B 混半，验证无序 pair key 命中同一会话
		}
		wg.Add(1)
		go func(i int, caller, target string) {
			defer wg.Done()
			req := dmAsRequest(t, "POST", "/api/chat/sessions/dm", map[string]any{"member_id": target}, caller, "", "")
			w := httptest.NewRecorder()
			testHandler.CreateDMChatSession(w, req)
			codes[i] = w.Code
			var resp ChatSessionResponse
			_ = json.Unmarshal(w.Body.Bytes(), &resp)
			ids[i] = resp.ID
		}(i, caller, target)
	}
	wg.Wait()

	seen := map[string]bool{}
	for i := 0; i < n; i++ {
		if codes[i] != http.StatusCreated && codes[i] != http.StatusOK {
			t.Fatalf("concurrent dm create #%d code=%d body=%s", i, codes[i], ids[i])
		}
		if ids[i] == "" {
			t.Fatalf("concurrent dm create #%d returned empty session id", i)
		}
		seen[ids[i]] = true
	}
	if len(seen) != 1 {
		t.Fatalf("expected exactly one dm session across concurrent pair, got %d distinct: %v", len(seen), seen)
	}
	sessionID := ""
	for id := range seen {
		sessionID = id
	}

	ctx := context.Background()
	var kindRows int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM chat_session WHERE kind='dm' AND id=$1`, sessionID).Scan(&kindRows); err != nil || kindRows != 1 {
		t.Fatalf("dm session rows=%d err=%v", kindRows, err)
	}
	var memberParts int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='member'`, sessionID).Scan(&memberParts); err != nil || memberParts != 2 {
		t.Fatalf("dm participants=%d (want 2) err=%v", memberParts, err)
	}
	var agentParts int
	testPool.QueryRow(ctx, `SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='agent'`, sessionID).Scan(&agentParts)
	if agentParts != 0 {
		t.Fatalf("dm must have no agent participant, got %d", agentParts)
	}
	// 清理本次会话，避免污染其它用例（迁移唯一索引 per-workspace）。
	t.Cleanup(func() { dmCleanupSession(context.Background(), sessionID) })
}

func TestCreateDMChatSessionRejectsSelf(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for DM test")
	}
	a := dmNewMember(t, "selfA")
	before := dmSessionCount(t)
	code, body := dmCreateSession(t, a, a)
	if code != http.StatusBadRequest {
		t.Fatalf("self dm: want 400, got %d: %s", code, body)
	}
	if after := dmSessionCount(t); after != before {
		t.Fatalf("self dm must not create sessions: before=%d after=%d", before, after)
	}
}

func TestCreateDMChatSessionRejectsCrossWorkspaceTarget(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for DM test")
	}
	a := dmNewMember(t, "xwsA")
	outside := dmNewOutsideUser(t, "xwsB")
	code, body := dmCreateSession(t, a, outside)
	if code != http.StatusNotFound {
		t.Fatalf("cross-workspace dm: want 404, got %d: %s", code, body)
	}
	// 404 文案不得泄露对方资料。
	if body == "" {
		t.Fatal("empty body")
	}
}

func TestDMNonparticipantCannotReadMessages(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for DM test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "privA")
	b := dmNewMember(t, "privB")
	c := dmNewMember(t, "privC") // 同工作区但非参与者
	defer func() {
		for _, u := range []string{a, b, c} {
			testPool.Exec(context.Background(), `DELETE FROM chat_participant WHERE participant_id = $1::uuid`, u)
			testPool.Exec(context.Background(), `DELETE FROM member WHERE user_id = $1`, u)
			testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, u)
		}
	}()

	code, sessionID := dmCreateSession(t, a, b)
	if code != http.StatusCreated {
		t.Fatalf("create dm: want 201, got %d: %s", code, sessionID)
	}
	defer dmCleanupSession(ctx, sessionID)

	// 参与者 A 发一条消息成功。
	sendReq := dmAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/messages", map[string]any{"content": "secret hi"}, a, "sessionId", sessionID)
	sendW := httptest.NewRecorder()
	testHandler.SendChatMessage(sendW, sendReq)
	if sendW.Code != http.StatusCreated {
		t.Fatalf("dm send: want 201, got %d: %s", sendW.Code, sendW.Body.String())
	}

	endpoints := []struct {
		name string
		call func(w http.ResponseWriter, r *http.Request)
	}{
		{"GetChatSession", testHandler.GetChatSession},
		{"ListChatMessages", testHandler.ListChatMessages},
		{"ListChatMessagesPage", testHandler.ListChatMessagesPage},
		{"GetChatParticipants", testHandler.GetChatParticipants},
	}
	// 非参与者 C 与工作区 owner（testUserID，非参与者）一律 404，且响应不含正文。
	for _, actor := range []string{c, testUserID} {
		for _, ep := range endpoints {
			req := dmAsRequest(t, "GET", "/api/chat/sessions/"+sessionID, nil, actor, "sessionId", sessionID)
			w := httptest.NewRecorder()
			ep.call(w, req)
			if w.Code != http.StatusNotFound {
				t.Fatalf("actor %s %s: want 404 for non-participant, got %d: %s", actor, ep.name, w.Code, w.Body.String())
			}
			if body := w.Body.String(); containsSecret(body, "secret hi") {
				t.Fatalf("actor %s %s leaked message content: %s", actor, ep.name, body)
			}
		}
	}

	// 参与者 B 可读，作为正向对照（确保门控不是一律 404 的假象）。
	req := dmAsRequest(t, "GET", "/api/chat/sessions/"+sessionID, nil, b, "sessionId", sessionID)
	w := httptest.NewRecorder()
	testHandler.GetChatSession(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("participant B should read its own dm, got %d: %s", w.Code, w.Body.String())
	}
}

func dmSessionCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM chat_session WHERE kind='dm'`).Scan(&n); err != nil {
		t.Fatalf("count dm sessions: %v", err)
	}
	return n
}

func dmCleanupSession(ctx context.Context, sessionID string) {
	testPool.Exec(ctx, `DELETE FROM chat_message WHERE chat_session_id = $1`, sessionID)
	testPool.Exec(ctx, `DELETE FROM chat_participant WHERE chat_session_id = $1`, sessionID)
	testPool.Exec(ctx, `DELETE FROM chat_group_task_input WHERE task_id IN (SELECT id FROM agent_task_queue WHERE chat_session_id = $1)`, sessionID)
	testPool.Exec(ctx, `DELETE FROM chat_session WHERE id = $1`, sessionID)
}

func containsSecret(body, secret string) bool {
	return secret != "" && strings.Contains(body, secret)
}
