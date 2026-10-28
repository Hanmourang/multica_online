package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Group 垂直切片的真实 DB 测试（plan 20261025 §02 任务 1/2）。复用 DM 测试套件的
// dmNewMember / dmAsRequest / dmCleanupSession（同包），全部走真实 test DB + 直接调
// handler，不用 mock 替代参与者门控与任务不创建的核心不变式。

// groupNewAgent 在测试工作区建一个 workspace 可见、可被成员调用的 Agent，返回其 id。
// 复用 createHandlerTestAgent：它经 agent_runtime 取 runtime、设 visibility='workspace'
// /permission_mode='public_to' 并插 agent_invocation_target(workspace) 行，使
// canAccessPrivateAgent/canInvokeAgent 放行工作区成员，与建群校验一致。
func groupNewAgent(t *testing.T, tag string) string {
	t.Helper()
	return createHandlerTestAgent(t, "grp-agent-"+tag, []byte("{}"))
}

func groupCreate(t *testing.T, caller string, body map[string]any) (int, string) {
	t.Helper()
	req := dmAsRequest(t, "POST", "/api/chat/sessions/group", body, caller, "", "")
	w := httptest.NewRecorder()
	testHandler.CreateGroupChatSession(w, req)
	if w.Code != http.StatusCreated {
		return w.Code, w.Body.String()
	}
	var resp ChatSessionResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode group resp: %v", err)
	}
	return w.Code, resp.ID
}

func groupAgentTaskCount(t *testing.T, sessionID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_task_queue WHERE chat_session_id = $1`, sessionID).Scan(&n); err != nil {
		t.Fatalf("count agent tasks: %v", err)
	}
	return n
}

func TestCreateGroupChatSessionCreatesRoster(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "grpA")
	b := dmNewMember(t, "grpB")
	c := dmNewMember(t, "grpC")
	agent := groupNewAgent(t, "grpAg")

	code, sessionID := groupCreate(t, a, map[string]any{
		"title":      "Release coordination",
		"member_ids": []string{b, c},
		"agent_ids":  []string{agent},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer dmCleanupSession(ctx, sessionID)

	var kind string
	if err := testPool.QueryRow(ctx, `SELECT kind FROM chat_session WHERE id=$1`, sessionID).Scan(&kind); err != nil || kind != "group" {
		t.Fatalf("group kind=%q err=%v", kind, err)
	}
	var memberParts, adminParts int
	if err := testPool.QueryRow(ctx,
		`SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='member'`, sessionID).Scan(&memberParts); err != nil {
		t.Fatalf("count members: %v", err)
	}
	if memberParts != 3 {
		t.Fatalf("group should have 3 human members, got %d", memberParts)
	}
	if err := testPool.QueryRow(ctx,
		`SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='member' AND admin`, sessionID).Scan(&adminParts); err != nil {
		t.Fatalf("count admins: %v", err)
	}
	if adminParts != 1 {
		t.Fatalf("exactly the creator should be admin, got %d", adminParts)
	}
	var agentParts int
	if err := testPool.QueryRow(ctx,
		`SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='agent'`, sessionID).Scan(&agentParts); err != nil || agentParts != 1 {
		t.Fatalf("group agent participants=%d (want 1) err=%v", agentParts, err)
	}
}

func TestCreateGroupChatSessionRejectsCrossWorkspaceMember(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	a := dmNewMember(t, "gxwsA")
	outside := dmNewOutsideUser(t, "gxwsB")
	before := groupSessionCount(t)
	code, body := groupCreate(t, a, map[string]any{
		"title":      "leak attempt",
		"member_ids": []string{outside},
	})
	if code != http.StatusNotFound {
		t.Fatalf("cross-workspace member: want 404, got %d: %s", code, body)
	}
	if after := groupSessionCount(t); after != before {
		t.Fatalf("rejected create must not add a session: before=%d after=%d", before, after)
	}
}

func TestCreateGroupChatSessionRejectsSelfOnlyGroup(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	a := dmNewMember(t, "gselfA")
	before := groupSessionCount(t)
	// Only the creator (member_ids empty or self) → <2 humans → 400.
	code, _ := groupCreate(t, a, map[string]any{"title": "lonely", "member_ids": []string{a}})
	if code != http.StatusBadRequest {
		t.Fatalf("self-only group: want 400, got %d", code)
	}
	if after := groupSessionCount(t); after != before {
		t.Fatalf("rejected create must not add a session: before=%d after=%d", before, after)
	}
}

func TestGroupSendPersistsMemberMessageAndCreatesNoTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gmsgA")
	b := dmNewMember(t, "gmsgB")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "chat room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer dmCleanupSession(ctx, sessionID)

	beforeTasks := groupAgentTaskCount(t, sessionID)
	sendReq := dmAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/messages",
		map[string]any{"content": "hello team"}, a, "sessionId", sessionID)
	sendW := httptest.NewRecorder()
	testHandler.SendChatMessage(sendW, sendReq)
	if sendW.Code != http.StatusCreated {
		t.Fatalf("group send: want 201, got %d: %s", sendW.Code, sendW.Body.String())
	}
	var resp SendChatMessageResponse
	if err := json.Unmarshal(sendW.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode send resp: %v", err)
	}
	if resp.Kind != "group" {
		t.Fatalf("send resp kind=%q, want group", resp.Kind)
	}
	if len(resp.Dispatches) != 0 {
		t.Fatalf("plain group send must not dispatch agents, got %v", resp.Dispatches)
	}
	if after := groupAgentTaskCount(t, sessionID); after != beforeTasks {
		t.Fatalf("plain group send must not create agent tasks: before=%d after=%d", beforeTasks, after)
	}
	// Message persisted with member attribution.
	var authorType, role string
	if err := testPool.QueryRow(ctx,
		`SELECT author_type, role FROM chat_message WHERE id=$1`, resp.MessageID).Scan(&authorType, &role); err != nil {
		t.Fatalf("load persisted message: %v", err)
	}
	if authorType != "member" || role != "user" {
		t.Fatalf("group message attribution author_type=%q role=%q", authorType, role)
	}
}

// ---- @Agent 扇出（plan 02 §4/§5）----

// groupCleanupTasks 清理会话产生的任务与快照链接，避免残留 queued 任务被其他
// 复用同一 runtime 的测试领取。必须在 dmCleanupSession 之前执行。
func groupCleanupTasks(ctx context.Context, sessionID string) {
	testPool.Exec(ctx, `DELETE FROM chat_group_task_input WHERE task_id IN (SELECT id FROM agent_task_queue WHERE chat_session_id = $1)`, sessionID)
	testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE chat_session_id = $1`, sessionID)
}

func groupSend(t *testing.T, caller, sessionID string, body map[string]any) (int, string, SendChatMessageResponse) {
	t.Helper()
	req := dmAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/messages", body, caller, "sessionId", sessionID)
	w := httptest.NewRecorder()
	testHandler.SendChatMessage(w, req)
	var resp SendChatMessageResponse
	if w.Code == http.StatusCreated {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode send resp: %v (%s)", err, w.Body.String())
		}
	}
	return w.Code, w.Body.String(), resp
}

func groupSnapshotRows(t *testing.T, taskID string) (int, int) {
	t.Helper()
	var total, triggers int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*), count(*) FILTER (WHERE is_trigger) FROM chat_group_task_input WHERE task_id=$1`, taskID,
	).Scan(&total, &triggers); err != nil {
		t.Fatalf("count snapshot rows: %v", err)
	}
	return total, triggers
}

func TestGroupMessagesIncludeCurrentTriggerDispatches(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	a := dmNewMember(t, "gdispatchA")
	b := dmNewMember(t, "gdispatchB")
	agent := groupNewAgent(t, "gdispatchAg")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "dispatch history", "member_ids": []string{b}, "agent_ids": []string{agent},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() {
		groupCleanupTasks(context.Background(), sessionID)
		dmCleanupSession(context.Background(), sessionID)
	})
	code, body, sent := groupSend(t, a, sessionID, map[string]any{
		"content":  "[@Bot](mention://agent/" + agent + ") show dispatch",
		"mentions": []map[string]any{{"type": "agent", "id": agent}},
	})
	if code != http.StatusCreated {
		t.Fatalf("send dispatch message: %d %s", code, body)
	}
	req := dmAsRequest(t, http.MethodGet, "/api/chat/sessions/"+sessionID+"/messages", nil, b, "sessionId", sessionID)
	w := httptest.NewRecorder()
	testHandler.ListChatMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list group messages: %d %s", w.Code, w.Body.String())
	}
	var messages []ChatMessageResponse
	if err := json.Unmarshal(w.Body.Bytes(), &messages); err != nil {
		t.Fatalf("decode group messages: %v", err)
	}
	if len(messages) != 1 || len(messages[0].Dispatches) != 1 {
		t.Fatalf("messages = %#v, want one message with one dispatch", messages)
	}
	dispatch := messages[0].Dispatches[0]
	expectedTaskID := sent.Dispatches[0].(map[string]any)["task_id"]
	if dispatch.AgentID != agent || dispatch.TaskID != expectedTaskID || dispatch.Status != "queued" {
		t.Fatalf("dispatch = %#v, want agent %s task %v queued", dispatch, agent, expectedTaskID)
	}
}

func TestGroupSendAgentMentionFansOutSingleTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gfoA")
	b := dmNewMember(t, "gfoB")
	agent := groupNewAgent(t, "gfoAg")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "with agent", "member_ids": []string{b}, "agent_ids": []string{agent},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	content := "[@Bot](mention://agent/" + agent + ") please ship it"
	got, body, resp := groupSend(t, a, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": agent}},
	})
	if got != http.StatusCreated {
		t.Fatalf("@agent send: want 201, got %d: %s", got, body)
	}
	if len(resp.Dispatches) != 1 {
		t.Fatalf("want 1 dispatch, got %v", resp.Dispatches)
	}
	d := resp.Dispatches[0].(map[string]any)
	if d["agent_id"] != agent || d["status"] != "queued" {
		t.Fatalf("dispatch shape wrong: %v", d)
	}
	taskID := d["task_id"].(string)
	// 一条人类消息、恰好一个任务（§4：消息不分叉，任务才分叉）。
	if n := groupAgentTaskCount(t, sessionID); n != 1 {
		t.Fatalf("want 1 task, got %d", n)
	}
	var fresh bool
	var selfOwned int
	if err := testPool.QueryRow(ctx, `SELECT force_fresh_session, (chat_input_task_id = id)::int
		FROM agent_task_queue WHERE id=$1`, taskID).Scan(&fresh, &selfOwned); err != nil {
		t.Fatalf("load task: %v", err)
	}
	if !fresh || selfOwned != 1 {
		t.Fatalf("group task must be force-fresh + self-owned, got fresh=%v self=%d", fresh, selfOwned)
	}
	// 人类消息 task_id=NULL + member 归属。
	var taskBound bool
	var authorType string
	if err := testPool.QueryRow(ctx, `SELECT task_id IS NOT NULL, author_type FROM chat_message WHERE id=$1`,
		resp.MessageID).Scan(&taskBound, &authorType); err != nil {
		t.Fatalf("load message: %v", err)
	}
	if taskBound || authorType != "member" {
		t.Fatalf("human group message must be task_id=NULL + member author, got bound=%v author=%q", taskBound, authorType)
	}
	// 快照恰含触发消息一条。
	total, triggers := groupSnapshotRows(t, taskID)
	if total != 1 || triggers != 1 {
		t.Fatalf("snapshot rows=%d triggers=%d, want 1/1", total, triggers)
	}
}

func TestGroupSendPrivateAgentAllowsOwnerAndRejectsOtherMember(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	owner := dmNewMember(t, "gprivOwn")
	other := dmNewMember(t, "gprivOth")
	agent := createPrivateAgentOwnedBy(t, "grp-private-owner", owner)
	code, sessionID := groupCreate(t, owner, map[string]any{
		"title": "private agent group", "member_ids": []string{other}, "agent_ids": []string{agent},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	content := "[@Bot](mention://agent/" + agent + ") run this"
	got, body, resp := groupSend(t, owner, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": agent}},
	})
	if got != http.StatusCreated {
		t.Fatalf("owner @private agent: want 201, got %d: %s", got, body)
	}
	if len(resp.Dispatches) != 1 {
		t.Fatalf("owner send want 1 dispatch, got %v", resp.Dispatches)
	}

	got, body, _ = groupSend(t, other, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": agent}},
	})
	if got != http.StatusForbidden || !strings.Contains(body, "invocation_revoked") {
		t.Fatalf("other member @private agent: want 403 invocation_revoked, got %d: %s", got, body)
	}
}

func TestGroupSendTwoAgentsShareOneMessageAndSnapshot(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "g2aA")
	ag1 := groupNewAgent(t, "g2aAg1")
	ag2 := groupNewAgent(t, "g2aAg2")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "two agents", "member_ids": []string{dmNewMember(t, "g2aB")},
		"agent_ids": []string{ag1, ag2},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	content := "[@A](mention://agent/" + ag1 + ") [@B](mention://agent/" + ag2 + ") review both"
	got, body, resp := groupSend(t, a, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": ag1}, {"type": "agent", "id": ag2}},
	})
	if got != http.StatusCreated {
		t.Fatalf("@2agents send: want 201, got %d: %s", got, body)
	}
	if len(resp.Dispatches) != 2 {
		t.Fatalf("want 2 dispatches, got %v", resp.Dispatches)
	}
	if n := groupAgentTaskCount(t, sessionID); n != 2 {
		t.Fatalf("want 2 tasks, got %d", n)
	}
	var msgRows int
	testPool.QueryRow(ctx, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1`, sessionID).Scan(&msgRows)
	if msgRows != 1 {
		t.Fatalf("one human message must stay exactly one row, got %d", msgRows)
	}
	// 两个任务共享同一快照内容，各自恰有一个 trigger（互不覆盖）。
	for _, dd := range resp.Dispatches {
		taskID := dd.(map[string]any)["task_id"].(string)
		total, triggers := groupSnapshotRows(t, taskID)
		if total != 1 || triggers != 1 {
			t.Fatalf("task %s snapshot rows=%d triggers=%d, want 1/1", taskID, total, triggers)
		}
	}
}

func TestGroupSendHiddenAgentMentionIsRejectedAndPersistsNothing(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "ghidA")
	agent := groupNewAgent(t, "ghidAg")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "room", "member_ids": []string{dmNewMember(t, "ghidB")}, "agent_ids": []string{agent},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d", code)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	// SEC-07：结构化 mention 未在 content 中出现 mention:// markdown，拒绝且零落库。
	got, body, _ := groupSend(t, a, sessionID, map[string]any{
		"content":  "no visible mention here",
		"mentions": []map[string]any{{"type": "agent", "id": agent}},
	})
	if got != http.StatusBadRequest {
		t.Fatalf("hidden mention: want 400, got %d: %s", got, body)
	}
	var msgRows int
	testPool.QueryRow(ctx, `SELECT count(*) FROM chat_message WHERE chat_session_id=$1`, sessionID).Scan(&msgRows)
	if msgRows != 0 || groupAgentTaskCount(t, sessionID) != 0 {
		t.Fatalf("rejected hidden mention must persist nothing, messages=%d", msgRows)
	}
}

func TestGroupSendMentionNonParticipantAgentRejected(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gnpA")
	inGroup := groupNewAgent(t, "gnpIn")
	outGroup := groupNewAgent(t, "gnpOut")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "room", "member_ids": []string{dmNewMember(t, "gnpB")}, "agent_ids": []string{inGroup},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d", code)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	content := "[@X](mention://agent/" + outGroup + ") hello"
	got, body, _ := groupSend(t, a, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": outGroup}},
	})
	if got != http.StatusBadRequest {
		t.Fatalf("non-participant agent: want 400, got %d: %s", got, body)
	}
	if groupAgentTaskCount(t, sessionID) != 0 {
		t.Fatal("rejected mention must create no task")
	}
}

func TestGroupSnapshotCapsAtTwentyMostRecent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gcapA")
	agent := groupNewAgent(t, "gcapAg")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "room", "member_ids": []string{dmNewMember(t, "gcapB")}, "agent_ids": []string{agent},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d", code)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	// 先叠 25 条普通群聊（无 @Agent），再 @Agent 触发：快照只取最近 19 条历史 +
	// 触发消息 = 20 条，且触发消息在最大 position 上。
	for i := 0; i < 25; i++ {
		got, body, _ := groupSend(t, a, sessionID, map[string]any{"content": "chatter"})
		if got != http.StatusCreated {
			t.Fatalf("plain send %d: %d %s", i, got, body)
		}
	}
	content := "[@Bot](mention://agent/" + agent + ") go"
	got, body, resp := groupSend(t, a, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": agent}},
	})
	if got != http.StatusCreated {
		t.Fatalf("fanout send: %d %s", got, body)
	}
	taskID := resp.Dispatches[0].(map[string]any)["task_id"].(string)
	total, triggers := groupSnapshotRows(t, taskID)
	if total != 20 || triggers != 1 {
		t.Fatalf("snapshot want 20 rows/1 trigger, got %d/%d", total, triggers)
	}
	var triggerPos, maxPos int
	testPool.QueryRow(ctx, `SELECT max(position), max(position) FROM chat_group_task_input WHERE task_id=$1`, taskID).Scan(&maxPos, &maxPos)
	testPool.QueryRow(ctx, `SELECT position FROM chat_group_task_input WHERE task_id=$1 AND is_trigger`, taskID).Scan(&triggerPos)
	if triggerPos != maxPos || triggerPos != 19 {
		t.Fatalf("trigger must be last (position 19), got %d", triggerPos)
	}
	// 最早 5 条历史被丢弃：快照内最早一条是第 6 条 chatter。
	var oldest string
	testPool.QueryRow(ctx, `SELECT m.content FROM chat_group_task_input i
		JOIN chat_message m ON m.id = i.message_id WHERE i.task_id=$1 ORDER BY i.position LIMIT 1`, taskID).Scan(&oldest)
	if oldest != "chatter" {
		t.Fatalf("oldest snapshot row=%q", oldest)
	}
}

func TestGroupSendMemberMentionCreatesInbox(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "ginboxA")
	b := dmNewMember(t, "ginboxB")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer dmCleanupSession(ctx, sessionID)
	defer testPool.Exec(context.Background(), `DELETE FROM inbox_item WHERE details->>'chat_session_id' = $1`, sessionID)

	sendReq := dmAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/messages", map[string]any{
		"content":  "[@B](mention://member/" + b + ") ping",
		"mentions": []map[string]any{{"type": "member", "id": b}},
	}, a, "sessionId", sessionID)
	sendW := httptest.NewRecorder()
	testHandler.SendChatMessage(sendW, sendReq)
	if sendW.Code != http.StatusCreated {
		t.Fatalf("group @member send: want 201, got %d: %s", sendW.Code, sendW.Body.String())
	}
	var inbox int
	if err := testPool.QueryRow(ctx,
		`SELECT count(*) FROM inbox_item WHERE type='chat_mention' AND recipient_id=$1::uuid AND details->>'chat_session_id'=$2`,
		b, sessionID).Scan(&inbox); err != nil {
		t.Fatalf("count inbox: %v", err)
	}
	if inbox != 1 {
		t.Fatalf("@member must notify recipient once, got %d", inbox)
	}
}

func TestGroupNonparticipantCannotRead(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gprivA")
	b := dmNewMember(t, "gprivB")
	c := dmNewMember(t, "gprivC") // same workspace, not a participant
	code, sessionID := groupCreate(t, a, map[string]any{"title": "secret room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer dmCleanupSession(ctx, sessionID)

	sendReq := dmAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/messages",
		map[string]any{"content": "confidential plan"}, a, "sessionId", sessionID)
	sendW := httptest.NewRecorder()
	testHandler.SendChatMessage(sendW, sendReq)
	if sendW.Code != http.StatusCreated {
		t.Fatalf("send: want 201, got %d", sendW.Code)
	}

	for _, ep := range []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
	}{
		{"ListChatMessages", testHandler.ListChatMessages},
		{"GetChatParticipants", testHandler.GetChatParticipants},
	} {
		req := dmAsRequest(t, "GET", "/api/chat/sessions/"+sessionID, nil, c, "sessionId", sessionID)
		w := httptest.NewRecorder()
		ep.call(w, req)
		if w.Code != http.StatusNotFound {
			t.Fatalf("non-participant %s: want 404, got %d: %s", ep.name, w.Code, w.Body.String())
		}
		if body := w.Body.String(); containsSecret(body, "confidential plan") {
			t.Fatalf("non-participant %s leaked content: %s", ep.name, body)
		}
	}
}

func groupSessionCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM chat_session WHERE kind='group'`).Scan(&n); err != nil {
		t.Fatalf("count group sessions: %v", err)
	}
	return n
}

// ---- 群成员管理切片（plan 02 §2.2 / §3.2）----

// groupAsRequest 在 dmAsRequest（注入成员上下文）之上一次性注入 sessionId + 额外 URL 参数。
// 必须用 withURLParams（会拷贝已有参数）而非 withURLParam（每次新建 route ctx、
// 会覆盖上一个参数），否则 sessionId 会被 participantType/Id 覆盖丢失。
func groupAsRequest(t *testing.T, method, path, caller, sessionID string, body any, extra ...[2]string) *http.Request {
	t.Helper()
	req := dmAsRequest(t, method, path, body, caller, "", "")
	kv := make([]string, 0, 2+2*len(extra))
	kv = append(kv, "sessionId", sessionID)
	for _, p := range extra {
		kv = append(kv, p[0], p[1])
	}
	return withURLParams(req, kv...)
}

func groupCall(t *testing.T, req *http.Request, fn func(http.ResponseWriter, *http.Request)) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	fn(w, req)
	return w.Code, w.Body.String()
}

func groupMemberCount(t *testing.T, sessionID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='member'`, sessionID).Scan(&n); err != nil {
		t.Fatalf("count members: %v", err)
	}
	return n
}

func groupAdminCount(t *testing.T, sessionID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM chat_participant WHERE chat_session_id=$1 AND participant_type='member' AND admin`, sessionID).Scan(&n); err != nil {
		t.Fatalf("count admins: %v", err)
	}
	return n
}

func TestGroupNonAdminCannotManage(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gmnA")
	b := dmNewMember(t, "gmnB")
	c := dmNewMember(t, "gmnC")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, sessionID)
	}
	defer dmCleanupSession(ctx, sessionID)
	req := groupAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/participants", b, sessionID, map[string]any{"member_ids": []string{c}})
	if got, body := groupCall(t, req, testHandler.AddGroupParticipants); got != http.StatusForbidden {
		t.Fatalf("non-admin add: want 403, got %d: %s", got, body)
	}
}

func TestGroupAddMemberIdempotentAndNonParticipantRejected(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gaddA")
	b := dmNewMember(t, "gaddB")
	c := dmNewMember(t, "gaddC")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	defer dmCleanupSession(ctx, sessionID)
	// admin 幂等添加 b(已在)+c → 成员数 2→3。
	req := groupAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/participants", a, sessionID, map[string]any{"member_ids": []string{b, c}})
	if got, body := groupCall(t, req, testHandler.AddGroupParticipants); got != http.StatusOK {
		t.Fatalf("add: want 200, got %d: %s", got, body)
	}
	if n := groupMemberCount(t, sessionID); n != 3 {
		t.Fatalf("after add members=%d want 3", n)
	}
	// 跨工作区用户 → 404（validateGroupMembers）。
	outside := dmNewOutsideUser(t, "gaddOut")
	req2 := groupAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/participants", a, sessionID, map[string]any{"member_ids": []string{outside}})
	if got, _ := groupCall(t, req2, testHandler.AddGroupParticipants); got != http.StatusNotFound {
		t.Fatalf("outside member: want 404, got %d", got)
	}
}

func TestGroupRemoveLastAdminBlockedThenAllowedAfterTransfer(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	a := dmNewMember(t, "grmA")
	b := dmNewMember(t, "grmB")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	defer dmCleanupSession(ctx, sessionID)
	// 先提升 b 为 admin → 两名 admin。
	req := groupAsRequest(t, "PATCH", "/api/chat/sessions/"+sessionID+"/participants/member/"+b, a, sessionID,
		map[string]any{"admin": true}, [2]string{"participantType", "member"}, [2]string{"participantId", b})
	if got, body := groupCall(t, req, testHandler.SetGroupParticipantAdmin); got != http.StatusOK {
		t.Fatalf("promote b: want 200, got %d: %s", got, body)
	}
	if n := groupAdminCount(t, sessionID); n != 2 {
		t.Fatalf("admins=%d want 2", n)
	}
	// 现 a 非唯一 admin → 可被移除。
	req = groupAsRequest(t, "DELETE", "/api/chat/sessions/"+sessionID+"/participants/member/"+a, b, sessionID, nil,
		[2]string{"participantType", "member"}, [2]string{"participantId", a})
	if got, body := groupCall(t, req, testHandler.RemoveGroupParticipant); got != http.StatusOK {
		t.Fatalf("remove a after transfer: want 200, got %d: %s", got, body)
	}
	if n := groupAdminCount(t, sessionID); n != 1 {
		t.Fatalf("remaining admins=%d want 1", n)
	}
}

func TestGroupDemoteLastAdminBlocked(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gdmA")
	b := dmNewMember(t, "gdmB")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	defer dmCleanupSession(ctx, sessionID)
	// a 是唯一 admin，尝试把自己降级 → 409。
	req := groupAsRequest(t, "PATCH", "/api/chat/sessions/"+sessionID+"/participants/member/"+a, a, sessionID,
		map[string]any{"admin": false}, [2]string{"participantType", "member"}, [2]string{"participantId", a})
	if got, body := groupCall(t, req, testHandler.SetGroupParticipantAdmin); got != http.StatusConflict {
		t.Fatalf("demote last admin: want 409, got %d: %s", got, body)
	}
	if n := groupAdminCount(t, sessionID); n != 1 {
		t.Fatalf("admins should stay 1, got %d", n)
	}
}

func TestGroupLastAdminCannotLeave(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	a := dmNewMember(t, "glvA")
	b := dmNewMember(t, "glvB")
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	defer dmCleanupSession(ctx, sessionID)
	req := groupAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/participants/leave", a, sessionID, map[string]any{})
	if got, body := groupCall(t, req, testHandler.LeaveGroup); got != http.StatusConflict {
		t.Fatalf("last admin leave: want 409, got %d: %s", got, body)
	}
	// 普通成员 b 可离开。
	req = groupAsRequest(t, "POST", "/api/chat/sessions/"+sessionID+"/participants/leave", b, sessionID, map[string]any{})
	if got, body := groupCall(t, req, testHandler.LeaveGroup); got != http.StatusOK {
		t.Fatalf("normal member leave: want 200, got %d: %s", got, body)
	}
	if n := groupMemberCount(t, sessionID); n != 1 {
		t.Fatalf("members after leave=%d want 1", n)
	}
}

func TestGroupRemoveMemberRejectsLastAdminAndNonParticipant(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	a := dmNewMember(t, "grmbA")
	b := dmNewMember(t, "grmbB")
	c := dmNewMember(t, "grmbC") // 同工作区但非参与者
	code, sessionID := groupCreate(t, a, map[string]any{"title": "room", "member_ids": []string{b}})
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	defer dmCleanupSession(ctx, sessionID)
	// admin a 尝试移除自己（唯一 admin）→ 409。
	req := groupAsRequest(t, "DELETE", "/api/chat/sessions/"+sessionID+"/participants/member/"+a, a, sessionID, nil,
		[2]string{"participantType", "member"}, [2]string{"participantId", a})
	if got, body := groupCall(t, req, testHandler.RemoveGroupParticipant); got != http.StatusConflict {
		t.Fatalf("remove last admin: want 409, got %d: %s", got, body)
	}
	// 非参与者 c 无权管理 → requireGroupAdmin 内 loadChatSessionForActor 先行 404（不泄露）。
	req = groupAsRequest(t, "DELETE", "/api/chat/sessions/"+sessionID+"/participants/member/"+b, c, sessionID, nil,
		[2]string{"participantType", "member"}, [2]string{"participantId", b})
	if got, body := groupCall(t, req, testHandler.RemoveGroupParticipant); got != http.StatusNotFound {
		t.Fatalf("non-participant remove: want 404, got %d: %s", got, body)
	}
	// admin 移除普通成员 b → 200。
	req = groupAsRequest(t, "DELETE", "/api/chat/sessions/"+sessionID+"/participants/member/"+b, a, sessionID, nil,
		[2]string{"participantType", "member"}, [2]string{"participantId", b})
	if got, body := groupCall(t, req, testHandler.RemoveGroupParticipant); got != http.StatusOK {
		t.Fatalf("remove normal member: want 200, got %d: %s", got, body)
	}
	if n := groupMemberCount(t, sessionID); n != 1 {
		t.Fatalf("members after remove=%d want 1", n)
	}
}

// ---- §5 daemon claim：群任务读自己的快照 + 作者前缀 + fail-closed ----

// groupClaimCtx 建一个专属 runtime并把 Agent 绑上去，隔离其他测试在共享
// runtime 上的残留任务，使 claim 可确定性断言。
type groupClaimCtx struct {
	sessionID string
	runtimeID string
	sender    string
	agentID   string
}

func newGroupClaimFixture(t *testing.T, tag string) groupClaimCtx {
	t.Helper()
	ctx := context.Background()
	sender := dmNewMember(t, tag+"Send")
	member2 := dmNewMember(t, tag+"Peer")
	agentID := groupNewAgent(t, tag+"Ag")
	var runtimeID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at)
		VALUES ($1, NULL, 'grp-claim-runtime', 'cloud', 'grp_claim_test', 'online', 'grp claim', '{}'::jsonb, now())
		RETURNING id`, testWorkspaceID).Scan(&runtimeID); err != nil {
		t.Fatalf("create claim runtime: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
	})
	// 同 owner，避免 claim 构建期的 runtime-access 403 干扰群逻辑断言。
	if _, err := testPool.Exec(ctx, `UPDATE agent_runtime SET owner_id = (SELECT owner_id FROM agent WHERE id = $2) WHERE id = $1`,
		runtimeID, agentID); err != nil {
		t.Fatalf("set runtime owner: %v", err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE agent SET runtime_id = $2 WHERE id = $1`, agentID, runtimeID); err != nil {
		t.Fatalf("bind agent runtime: %v", err)
	}
	code, sessionID := groupCreate(t, sender, map[string]any{
		"title": "claim room", "member_ids": []string{member2}, "agent_ids": []string{agentID},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() {
		groupCleanupTasks(context.Background(), sessionID)
		dmCleanupSession(context.Background(), sessionID)
	})
	return groupClaimCtx{sessionID: sessionID, runtimeID: runtimeID, sender: sender, agentID: agentID}
}

// groupFanoutSend 发一条带可见 mention markdown 的 @Agent 消息，返回任务 id。
func groupFanoutSend(t *testing.T, fx groupClaimCtx, text string) string {
	t.Helper()
	content := "[@Bot](mention://agent/" + fx.agentID + ") " + text
	got, body, resp := groupSend(t, fx.sender, fx.sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": fx.agentID}},
	})
	if got != http.StatusCreated {
		t.Fatalf("fanout send %q: %d %s", text, got, body)
	}
	return resp.Dispatches[0].(map[string]any)["task_id"].(string)
}

func groupClaimOne(t *testing.T, fx groupClaimCtx) *db.AgentTaskQueue {
	t.Helper()
	task, err := testHandler.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(fx.runtimeID))
	if err != nil || task == nil {
		t.Fatalf("claim task: task=%v err=%v", task, err)
	}
	return task
}

func groupBuildClaim(t *testing.T, fx groupClaimCtx, task *db.AgentTaskQueue) (AgentTaskResponse, *claimBuildFailure) {
	t.Helper()
	runtime, err := testHandler.Queries.GetAgentRuntimeForWorkspace(context.Background(), db.GetAgentRuntimeForWorkspaceParams{
		ID:          parseUUID(fx.runtimeID),
		WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatalf("load runtime: %v", err)
	}
	req := newDaemonTokenRequest(http.MethodPost, "/api/daemon/runtimes/"+fx.runtimeID+"/claim", nil,
		testWorkspaceID, "grp-claim-"+t.Name())
	resp, _, _, _, failure := testHandler.buildClaimedTaskResponse(req, task, runtime, fx.runtimeID, testWorkspaceID)
	return resp, failure
}

func TestGroupClaimReadsOwnSnapshotWithAuthorPrefixes(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	fx := newGroupClaimFixture(t, "gcl")

	// 第一轮：快照只含触发消息，成员前缀可见。
	task1 := groupFanoutSend(t, fx, "first question")
	claimed1 := groupClaimOne(t, fx)
	resp1, failure1 := groupBuildClaim(t, fx, claimed1)
	if failure1 != nil {
		t.Fatalf("claim build 1: %+v", failure1)
	}
	if !strings.Contains(resp1.ChatMessage, "[Member: dm-gclSend] ") || !strings.Contains(resp1.ChatMessage, "first question") {
		t.Fatalf("claim 1 input missing member prefix: %q", resp1.ChatMessage)
	}
	if resp1.PriorSessionID != "" || resp1.PriorWorkDir != "" {
		t.Fatalf("group claim must never resume, got prior=%q workdir=%q", resp1.PriorSessionID, resp1.PriorWorkDir)
	}
	// 释放 task1 占用的并发额度，否则同 Agent max_concurrent 会拦住下一次 claim。
	if _, err := testHandler.TaskService.CancelTask(ctx, parseUUID(task1)); err != nil {
		t.Fatalf("cancel task1: %v", err)
	}

	// 模拟 Agent 完成回复（assistant + author_type=agent + author_id）。
	if _, err := testPool.Exec(ctx, `INSERT INTO chat_message
		(chat_session_id, role, content, message_kind, author_type, author_id)
		VALUES ($1, 'assistant', 'done in the first turn', 'message', 'agent', $2)`,
		fx.sessionID, fx.agentID); err != nil {
		t.Fatalf("insert assistant row: %v", err)
	}

	// 第二轮：新任务快照包含成员+Agent+新触发，逐行作者前缀。
	task2 := groupFanoutSend(t, fx, "second question")
	if task2 == task1 {
		t.Fatal("second send must create a second task")
	}
	claimed2 := groupClaimOne(t, fx)
	resp2, failure2 := groupBuildClaim(t, fx, claimed2)
	if failure2 != nil {
		t.Fatalf("claim build 2: %+v", failure2)
	}
	if !strings.Contains(resp2.ChatMessage, "[Agent: grp-agent-gclAg] done in the first turn") {
		t.Fatalf("claim 2 snapshot missing agent prefix row: %q", resp2.ChatMessage)
	}
	if !strings.Contains(resp2.ChatMessage, "second question") {
		t.Fatalf("claim 2 snapshot missing trigger: %q", resp2.ChatMessage)
	}
	total2, trig2 := groupSnapshotRows(t, task2)
	if total2 != 3 || trig2 != 1 {
		t.Fatalf("task2 snapshot rows=%d triggers=%d, want 3/1", total2, trig2)
	}
	// 旧任务快照不受后续消息影响（不可变性）。
	total1, _ := groupSnapshotRows(t, task1)
	if total1 != 1 {
		t.Fatalf("task1 snapshot must stay immutable at 1 row, got %d", total1)
	}
}

func TestGroupClaimCancelsWhenAgentRemovedFromGroup(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	fx := newGroupClaimFixture(t, "grm")
	taskID := groupFanoutSend(t, fx, "handle this")

	// 派发后、领取前被移出群 → 取消任务并拒绝 claim（§5）。
	if _, err := testPool.Exec(ctx, `DELETE FROM chat_participant
		WHERE chat_session_id=$1 AND participant_type='agent'`, fx.sessionID); err != nil {
		t.Fatalf("remove agent: %v", err)
	}
	claimed := groupClaimOne(t, fx)
	_, failure := groupBuildClaim(t, fx, claimed)
	if failure == nil || failure.outcome != "invalid_group_chat_task" || failure.status != http.StatusConflict {
		t.Fatalf("removed-agent claim: want invalid_group_chat_task 409, got %+v", failure)
	}
	var status string
	if err := testPool.QueryRow(ctx, `SELECT status FROM agent_task_queue WHERE id=$1`, taskID).Scan(&status); err != nil || status != "cancelled" {
		t.Fatalf("task status=%q err=%v, want cancelled", status, err)
	}
}

func TestGroupClaimCancelsOnCorruptSnapshot(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	fx := newGroupClaimFixture(t, "gcor")
	taskID := groupFanoutSend(t, fx, "corrupt me")

	// 手动破坏快照（模拟损坏状态）：缺 trigger 的派发绝不带着错输入运行。
	if _, err := testPool.Exec(ctx, `DELETE FROM chat_group_task_input WHERE task_id=$1`, taskID); err != nil {
		t.Fatalf("corrupt snapshot: %v", err)
	}
	claimed := groupClaimOne(t, fx)
	_, failure := groupBuildClaim(t, fx, claimed)
	if failure == nil || failure.outcome != "invalid_group_chat_task" {
		t.Fatalf("corrupt snapshot claim: want invalid_group_chat_task, got %+v", failure)
	}
	var status string
	testPool.QueryRow(ctx, `SELECT status FROM agent_task_queue WHERE id=$1`, taskID).Scan(&status)
	if status != "cancelled" {
		t.Fatalf("corrupt task status=%q, want cancelled", status)
	}
}

// ---- §6 pending-task：群会话按 Agent 并行暴露多任务 ----

func TestGroupPendingExposesPerAgentTasks(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	a := dmNewMember(t, "gpdA")
	ag1 := groupNewAgent(t, "gpdAg1")
	ag2 := groupNewAgent(t, "gpdAg2")
	code, sessionID := groupCreate(t, a, map[string]any{
		"title": "pending room", "member_ids": []string{dmNewMember(t, "gpdB")},
		"agent_ids": []string{ag1, ag2},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	content := "[@A](mention://agent/" + ag1 + ") [@B](mention://agent/" + ag2 + ") both run"
	if got, body, resp := groupSend(t, a, sessionID, map[string]any{
		"content":  content,
		"mentions": []map[string]any{{"type": "agent", "id": ag1}, {"type": "agent", "id": ag2}},
	}); got != http.StatusCreated || len(resp.Dispatches) != 2 {
		t.Fatalf("fanout send: %d %s", got, body)
	}

	pendingReq := groupAsRequest(t, "GET", "/api/chat/sessions/"+sessionID+"/pending-task", a, sessionID, nil)
	w := httptest.NewRecorder()
	testHandler.GetPendingChatTask(w, pendingReq)
	if w.Code != http.StatusOK {
		t.Fatalf("pending: want 200, got %d: %s", w.Code, w.Body.String())
	}
	var pending PendingChatTaskResponse
	if err := json.Unmarshal(w.Body.Bytes(), &pending); err != nil {
		t.Fatalf("decode pending: %v", err)
	}
	if pending.SupportsQueue {
		t.Fatal("group must never advertise queue support")
	}
	if len(pending.AgentTasks) != 2 {
		t.Fatalf("want 2 agent tasks, got %+v", pending.AgentTasks)
	}
	seen := map[string]string{}
	for _, at := range pending.AgentTasks {
		seen[at.AgentID] = at.TaskID
		if at.Status != "queued" || at.CreatedAt == "" {
			t.Fatalf("agent task shape wrong: %+v", at)
		}
	}
	if seen[ag1] == "" || seen[ag2] == "" || seen[ag1] == seen[ag2] {
		t.Fatalf("agent task mapping wrong: %+v", pending.AgentTasks)
	}

	// 取消一个 Agent 的任务不影响另一个（多 Agent 独立取消语义）。
	if _, err := testHandler.TaskService.CancelTask(ctx, parseUUID(seen[ag1])); err != nil {
		t.Fatalf("cancel task1: %v", err)
	}
	w2 := httptest.NewRecorder()
	testHandler.GetPendingChatTask(w2, groupAsRequest(t, "GET", "/api/chat/sessions/"+sessionID+"/pending-task", a, sessionID, nil))
	var pending2 PendingChatTaskResponse
	if err := json.Unmarshal(w2.Body.Bytes(), &pending2); err != nil {
		t.Fatalf("decode pending2: %v", err)
	}
	if len(pending2.AgentTasks) != 1 || pending2.AgentTasks[0].AgentID != ag2 {
		t.Fatalf("after cancel want only ag2 pending, got %+v", pending2.AgentTasks)
	}
}

// ---- 终止：群内成员是否都能停掉跑飞的 Agent ----

// TestGroupParticipantCanStopAnyAgentTask 固化「群是共享房间」的取消权限模型：
// 终止权跟着可见性走，而不是跟着发起人走。此前 creator-only 意味着 Alice 派发的
// 任务跑到 100+ 步时，同在群里的 Bob 只能看着，这正是「压根无法终止」的现场。
func TestGroupParticipantCanStopAnyAgentTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for group test")
	}
	ctx := context.Background()
	alice := dmNewMember(t, "gstopA") // 建群并派发任务
	bob := dmNewMember(t, "gstopB")   // 群参与者，但不是派发人
	carol := dmNewMember(t, "gstopC") // 工作区成员，但不在群里
	ag1 := groupNewAgent(t, "gstopAg1")
	ag2 := groupNewAgent(t, "gstopAg2")

	code, sessionID := groupCreate(t, alice, map[string]any{
		"title": "runaway room", "member_ids": []string{bob},
		"agent_ids": []string{ag1, ag2},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: want 201, got %d: %s", code, sessionID)
	}
	defer groupCleanupTasks(ctx, sessionID)
	defer dmCleanupSession(ctx, sessionID)

	// 两个 Agent 各自在跑，复刻 fan-out 之后进入 running 的现场。
	seedRunning := func(agentID string) string {
		t.Helper()
		var taskID string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO agent_task_queue (agent_id, runtime_id, status, priority, issue_id, chat_session_id)
			VALUES ($1, (SELECT runtime_id FROM agent WHERE id = $1), 'running', 0, NULL, $2)
			RETURNING id::text
		`, agentID, sessionID).Scan(&taskID); err != nil {
			t.Fatalf("seed running task for %s: %v", agentID, err)
		}
		return taskID
	}
	ag1Task := seedRunning(ag1)
	ag2Task := seedRunning(ag2)

	// ① 参与者 Bob 停掉 Alice 派发的任务 → 200 且状态真的落到 cancelled。
	w := httptest.NewRecorder()
	testHandler.CancelTaskByUser(w, cancelTaskByUserRequest(t, bob, ag1Task))
	if w.Code != http.StatusOK {
		t.Fatalf("participant stop: want 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := taskStatus(t, ag1Task); got != "cancelled" {
		t.Fatalf("participant stop left status=%q, want cancelled", got)
	}

	// ② 非参与者 Carol 被拒，且任务未被改动（404 而非 403，不泄露会话存在性）。
	w2 := httptest.NewRecorder()
	testHandler.CancelTaskByUser(w2, cancelTaskByUserRequest(t, carol, ag2Task))
	if w2.Code != http.StatusNotFound {
		t.Fatalf("non-participant stop: want 404, got %d: %s", w2.Code, w2.Body.String())
	}
	if got := taskStatus(t, ag2Task); got != "running" {
		t.Fatalf("non-participant stop mutated task: status=%q, want running", got)
	}
}

// TestGroupClaimOffersTheAgentsPreviousWorkDir pins the server half of the
// group-chat latency fix. A group turn still never resumes a provider session
// — its input is the immutable per-agent snapshot — but it does hand the daemon
// the worktree the same agent finished its previous turn in, which is what lets
// the daemon adopt that checkout instead of paying for a full one per message.
func TestGroupClaimOffersTheAgentsPreviousWorkDir(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available")
	}
	ctx := context.Background()
	fx := newGroupClaimFixture(t, "gwd")

	task1 := groupFanoutSend(t, fx, "first question")
	claimed1 := groupClaimOne(t, fx)
	resp1, failure1 := groupBuildClaim(t, fx, claimed1)
	if failure1 != nil {
		t.Fatalf("claim build 1: %+v", failure1)
	}
	if resp1.PriorWorkDir != "" || resp1.PriorSessionID != "" {
		t.Fatalf("the agent's first group turn inherited something: workdir=%q session=%q",
			resp1.PriorWorkDir, resp1.PriorSessionID)
	}

	// The daemon reports the worktree it ran in when it completes the turn.
	// Completing it also frees the agent's concurrency slot.
	workDir := "/tmp/multica-group-kept-worktree"
	if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue
		SET status = 'completed', completed_at = now(), work_dir = $2
		WHERE id = $1`, task1, workDir); err != nil {
		t.Fatalf("complete turn one: %v", err)
	}

	task2 := groupFanoutSend(t, fx, "second question")
	if task2 == task1 {
		t.Fatal("second send must create a second task")
	}
	claimed2 := groupClaimOne(t, fx)
	resp2, failure2 := groupBuildClaim(t, fx, claimed2)
	if failure2 != nil {
		t.Fatalf("claim build 2: %+v", failure2)
	}
	if resp2.ChatSessionKind != "group" {
		t.Fatalf("claim kind = %q, want group", resp2.ChatSessionKind)
	}
	if resp2.PriorWorkDir != workDir {
		t.Fatalf("group claim offered workdir %q, want %q", resp2.PriorWorkDir, workDir)
	}
	if resp2.PriorSessionID != "" {
		t.Fatalf("group claim resumed a provider session: %q", resp2.PriorSessionID)
	}
}
