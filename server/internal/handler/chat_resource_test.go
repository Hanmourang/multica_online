package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestChatMessagePayloadMarksResourcesWithoutSnapshots(t *testing.T) {
	payload, err := json.Marshal(protocol.ChatMessagePayload{HasResources: true})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if !strings.Contains(string(payload), `"has_resources":true`) {
		t.Fatalf("expected resource marker, got %s", payload)
	}
	if strings.Contains(string(payload), `"resources"`) {
		t.Fatalf("realtime payload must not contain resource snapshots: %s", payload)
	}
}

func TestFormatSharedIssueResourceIncludesProgressFields(t *testing.T) {
	due := "2026-10-25"
	goal := "拆解旅游攻略并给出可执行计划"
	desc := "第一阶段已完成调研。\n第二阶段待补充行程。"
	long := strings.Repeat("进", issuePromptDescriptionLimit+20)
	got := formatSharedIssueResource("issue:task-14", IssueResponse{
		Identifier:  "task_14",
		Title:       "PM plan + 拆解: 旅游攻略",
		Status:      "done",
		StatusName:  "已完成",
		Priority:    "medium",
		DueDate:     &due,
		UpdatedAt:   "2026-10-25T16:57:54Z",
		Goal:        &goal,
		Description: &desc,
	}, sharedIssuePromptExtra{
		Loaded:     true,
		Acceptance: "行程可执行",
		Children: []sharedIssueChild{
			{Identifier: "task_15", Title: "调研", Status: "done"},
			{Identifier: "task_16", Title: "拆解", Status: "in_progress"},
		},
		ChildrenClosed: 1,
		Comments: []sharedIssueComment{
			{At: "2026-10-25T10:00:00Z", Author: "member", Content: "先看景区开放时间"},
		},
	})
	for _, expected := range []string{
		"- issue:task-14 — task_14 PM plan + 拆解: 旅游攻略",
		"status: done (已完成)",
		"priority: medium",
		"due: 2026-10-25",
		"updated: 2026-10-25T16:57:54Z",
		"goal:",
		"拆解旅游攻略并给出可执行计划",
		"description:",
		"第一阶段已完成调研。",
		"第二阶段待补充行程。",
		"acceptance:",
		"行程可执行",
		"children:",
		"task_15 调研 — done",
		"task_16 拆解 — in_progress",
		"child_progress: 1/2 closed (done or cancelled)",
		"comments:",
		"member: 先看景区开放时间",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("prompt missing %q:\n%s", expected, got)
		}
	}

	clipped := formatSharedIssueResource("issue:task-14", IssueResponse{
		Identifier:  "task_14",
		Title:       "long",
		Description: &long,
	}, sharedIssuePromptExtra{})
	if !strings.Contains(clipped, "…") {
		t.Fatalf("expected description to be clipped:\n%s", clipped)
	}
	if strings.Count(clipped, "进") > issuePromptDescriptionLimit {
		t.Fatalf("description exceeded the prompt cap")
	}
	empty := formatSharedIssueResource("issue:task-14", IssueResponse{Title: "empty"}, sharedIssuePromptExtra{Loaded: true})
	for _, expected := range []string{"children: none", "comments: none"} {
		if !strings.Contains(empty, expected) {
			t.Fatalf("empty progress record missing %q:\n%s", expected, empty)
		}
	}
}

func TestFormatAcceptanceForPromptReadsCriteriaAndSpec(t *testing.T) {
	got := formatAcceptanceForPrompt([]byte(`["行程可执行"]`), []byte(`{"assertions":["金额一致"]}`))
	for _, expected := range []string{"行程可执行", "金额一致"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("acceptance text missing %q: %s", expected, got)
		}
	}
	if formatAcceptanceForPrompt([]byte("null"), []byte("[]")) != "" {
		t.Fatal("empty acceptance documents must stay out of the prompt")
	}
}

func TestFormatSharedDocumentResourceInlinesBody(t *testing.T) {
	got := formatSharedDocumentResource("artifact:doc-1", "projects/dsh_desktop/overview/research/report.md", "第一段结论。\n第二段市场。")
	for _, expected := range []string{
		"- artifact:doc-1 — projects/dsh_desktop/overview/research/report.md",
		"body:",
		"第一段结论。",
		"第二段市场。",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("document prompt missing %q:\n%s", expected, got)
		}
	}
	missing := formatSharedDocumentResource("artifact:doc-1", "report.md", "")
	if !strings.Contains(missing, "unavailable") || !strings.Contains(missing, "Do not search") {
		t.Fatalf("missing document must not invite a search:\n%s", missing)
	}
}

func TestReadChatDocumentAtFindsArchiveMarkdown(t *testing.T) {
	root := t.TempDir()
	rel := "projects/dsh_desktop/overview/research/report.md"
	abs := filepath.Join(root, "projects_mgmt", filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	const body = "# 调研\n\n市场结论在这里。"
	if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	codeRoot := filepath.Join(root, "ai_agents", "dsh_desktop")
	if err := os.MkdirAll(codeRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	got := readChatDocumentAt(expandArchiveRoots([]string{codeRoot}), rel)
	if got != body {
		t.Fatalf("read %q, want %q", got, body)
	}
}

func TestNormalizeChatResourceRefsDedupesAndPreservesOrder(t *testing.T) {
	refs, err := normalizeChatResourceRefs([]protocol.ChatResourceRef{
		{Type: "issue", ID: " issue-1 ", Kind: "task"},
		{Type: "document", ID: "doc-1", Source: "artifact", ProjectID: "project-1"},
		{Type: "issue", ID: "issue-1", Kind: "task"},
	})
	if err != nil {
		t.Fatalf("normalize refs: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("expected two unique refs, got %#v", refs)
	}
	if refs[0].ID != "issue-1" || refs[1].Source != "artifact" {
		t.Fatalf("unexpected normalized refs: %#v", refs)
	}
}

func TestConversationRailUsesSafeSummaryForResourceOnlyMessage(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	sender := dmNewMember(t, "gresRailA")
	peer := dmNewMember(t, "gresRailB")
	code, sessionID := groupCreate(t, sender, map[string]any{
		"title": "resource rail", "member_ids": []string{peer},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() { dmCleanupSession(context.Background(), sessionID) })
	issueID := dbfx.Issue(t, "resource-only rail secret title")

	code, body, _ := groupSend(t, sender, sessionID, map[string]any{
		"content":       "",
		"resource_refs": []map[string]any{{"type": "issue", "id": issueID, "kind": "task"}},
	})
	if code != http.StatusCreated {
		t.Fatalf("send resource-only message: %d %s", code, body)
	}
	sessions, err := testHandler.listConversationSessionsForMember(context.Background(), testWorkspaceID, sender, false)
	if err != nil {
		t.Fatalf("list conversation sessions: %v", err)
	}
	for _, session := range sessions {
		if session.ID != sessionID {
			continue
		}
		if session.LastMessage == nil || session.LastMessage.Content != "[Task]" {
			t.Fatalf("resource-only rail preview = %#v, want safe task summary", session.LastMessage)
		}
		if strings.Contains(session.LastMessage.Content, "secret title") {
			t.Fatalf("rail preview leaked resource title: %q", session.LastMessage.Content)
		}
		return
	}
	t.Fatalf("sent session %s missing from rail", sessionID)
}

func TestGroupClaimIncludesResourceKeysFromSnapshot(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	fx := newGroupClaimFixture(t, "gresClaim")
	issueID := dbfx.Issue(t, "shared implementation brief")
	content := "[@Bot](mention://agent/" + fx.agentID + ") inspect the shared task"
	code, body, sent := groupSend(t, fx.sender, fx.sessionID, map[string]any{
		"content":       content,
		"mentions":      []map[string]any{{"type": "agent", "id": fx.agentID}},
		"resource_refs": []map[string]any{{"type": "issue", "id": issueID, "kind": "task"}},
	})
	if code != http.StatusCreated {
		t.Fatalf("send resource mention: %d %s", code, body)
	}
	claimed := groupClaimOne(t, fx)
	resp, failure := groupBuildClaim(t, fx, claimed)
	if failure != nil {
		t.Fatalf("build resource claim: %+v", failure)
	}
	if !strings.Contains(resp.ChatMessage, "issue:"+issueID) {
		t.Fatalf("claim input missing immutable resource key: %q", resp.ChatMessage)
	}
	if !strings.Contains(resp.ChatMessage, "shared implementation brief") {
		t.Fatalf("claim input missing authorized issue snapshot: %q", resp.ChatMessage)
	}
	if !strings.Contains(resp.ChatIssueRecord, "shared implementation brief") || !strings.Contains(resp.ChatIssueRecord, "children:") {
		t.Fatalf("claim issue record missing progress snapshot: %q", resp.ChatIssueRecord)
	}
	if len(sent.Resources) != 1 || sent.Resources[0].Issue == nil {
		t.Fatalf("send response missing authorized resource snapshot: %#v", sent.Resources)
	}
}

func TestDirectAgentClaimAcceptsResourceOnlyMessage(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	fx := newGroupClaimFixture(t, "gresDirect")
	sessionID := createHandlerTestChatSession(t, fx.agentID)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE chat_session_id = $1`, sessionID)
	})
	issueID := dbfx.Issue(t, "resource-only direct task")
	req := withChatTestWorkspaceCtx(t, withURLParam(newRequest(http.MethodPost,
		"/api/chat/sessions/"+sessionID+"/messages", map[string]any{
			"content":       "",
			"resource_refs": []map[string]any{{"type": "issue", "id": issueID, "kind": "task"}},
		}), "sessionId", sessionID))
	testutil.Call(t, testHandler.SendChatMessage, req).Want(http.StatusCreated)

	claimed := groupClaimOne(t, fx)
	resp, failure := groupBuildClaim(t, fx, claimed)
	if failure != nil {
		t.Fatalf("resource-only direct claim was rejected: %+v", failure)
	}
	if !strings.Contains(resp.ChatMessage, "issue:"+issueID) {
		t.Fatalf("resource-only direct input missing resource key: %q", resp.ChatMessage)
	}
}

func TestChatResourceHydrationDistinguishesDeniedAndMissing(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	sender := dmNewMember(t, "gresAccessA")
	peer := dmNewMember(t, "gresAccessB")
	code, sessionID := groupCreate(t, sender, map[string]any{
		"title": "resource access", "member_ids": []string{peer},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() { dmCleanupSession(context.Background(), sessionID) })
	code, body, sent := groupSend(t, sender, sessionID, map[string]any{"content": "resource access"})
	if code != http.StatusCreated {
		t.Fatalf("send message: %d %s", code, body)
	}

	var otherWorkspaceID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ('resource other workspace', 'resource-other-workspace', '', 'RES')
		RETURNING id`).Scan(&otherWorkspaceID); err != nil {
		t.Fatalf("create other workspace: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, otherWorkspaceID)
	})
	deniedIssueID := dbfx.Issue(t, "denied resource secret title", testutil.Cols{"workspace_id": otherWorkspaceID})
	missingIssueID := "00000000-0000-0000-0000-000000000001"
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO chat_message_resource_ref
			(message_id, position, resource_type, resource_id, resource_kind)
		VALUES
			($1, 0, 'issue', $2, 'task'),
			($1, 1, 'issue', $3, 'task')`, sent.MessageID, deniedIssueID, missingIssueID); err != nil {
		t.Fatalf("insert resource fixtures: %v", err)
	}

	req := dmAsRequest(t, http.MethodGet, "/api/chat/sessions/"+sessionID+"/messages", nil, sender, "sessionId", sessionID)
	resources := testHandler.groupChatMessageResources(req, parseUUID(testWorkspaceID), []pgtype.UUID{parseUUID(sent.MessageID)})[sent.MessageID]
	if len(resources) != 2 {
		t.Fatalf("hydrated resources = %#v, want denied and missing entries", resources)
	}
	if resources[0].Access != "denied" || resources[0].Issue != nil {
		t.Fatalf("cross-workspace resource = %#v, want denied without snapshot", resources[0])
	}
	if resources[1].Access != "missing" || resources[1].Issue != nil {
		t.Fatalf("missing resource = %#v, want missing without snapshot", resources[1])
	}
	encoded, err := json.Marshal(resources)
	if err != nil {
		t.Fatalf("marshal resources: %v", err)
	}
	if strings.Contains(string(encoded), "denied resource secret title") {
		t.Fatalf("safe resource DTO leaked denied title: %s", encoded)
	}
}

type chatResourceCountingExecutor struct {
	dbExecutor
	issueQueries      int
	artifactQueries   int
	attachmentQueries int
}

func (q *chatResourceCountingExecutor) count(sql string) {
	normalized := strings.ToLower(sql)
	if strings.Contains(normalized, "from issue") {
		q.issueQueries++
	}
	if strings.Contains(normalized, "from project_artifact") {
		q.artifactQueries++
	}
	if strings.Contains(normalized, "from attachment") {
		q.attachmentQueries++
	}
}

func (q *chatResourceCountingExecutor) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.count(sql)
	return q.dbExecutor.Query(ctx, sql, args...)
}

func (q *chatResourceCountingExecutor) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	q.count(sql)
	return q.dbExecutor.QueryRow(ctx, sql, args...)
}

func TestChatResourceHydrationBatchesIssueLookups(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	sender := dmNewMember(t, "gresBatchA")
	peer := dmNewMember(t, "gresBatchB")
	code, sessionID := groupCreate(t, sender, map[string]any{
		"title": "batched resources", "member_ids": []string{peer},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() { dmCleanupSession(context.Background(), sessionID) })
	code, body, sent := groupSend(t, sender, sessionID, map[string]any{"content": "batch"})
	if code != http.StatusCreated {
		t.Fatalf("send message: %d %s", code, body)
	}
	firstIssueID := dbfx.Issue(t, "first batched issue")
	secondIssueID := dbfx.Issue(t, "second batched issue")
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO chat_message_resource_ref
			(message_id, position, resource_type, resource_id, resource_kind)
		VALUES
			($1, 0, 'issue', $2, 'task'),
			($1, 1, 'issue', $3, 'task')`, sent.MessageID, firstIssueID, secondIssueID); err != nil {
		t.Fatalf("insert resource fixtures: %v", err)
	}

	countingDB := &chatResourceCountingExecutor{dbExecutor: testHandler.DB}
	h := *testHandler
	h.DB = countingDB
	h.Queries = db.New(countingDB)
	req := dmAsRequest(t, http.MethodGet, "/api/chat/sessions/"+sessionID+"/messages", nil, sender, "sessionId", sessionID)
	resources := h.groupChatMessageResources(req, parseUUID(testWorkspaceID), []pgtype.UUID{parseUUID(sent.MessageID)})[sent.MessageID]
	if len(resources) != 2 || resources[0].Issue == nil || resources[1].Issue == nil {
		t.Fatalf("hydrated resources = %#v, want two granted issues", resources)
	}
	if countingDB.issueQueries != 1 {
		t.Fatalf("issue lookups = %d, want one batched query", countingDB.issueQueries)
	}
}

func TestChatResourceHydrationBatchesDocumentLookups(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	sender := dmNewMember(t, "gresDocBatchA")
	peer := dmNewMember(t, "gresDocBatchB")
	code, sessionID := groupCreate(t, sender, map[string]any{
		"title": "batched documents", "member_ids": []string{peer},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() { dmCleanupSession(context.Background(), sessionID) })
	code, body, sent := groupSend(t, sender, sessionID, map[string]any{"content": "batch"})
	if code != http.StatusCreated {
		t.Fatalf("send message: %d %s", code, body)
	}
	projectID := dbfx.Project(t, "batched documents")
	resourceID := dbfx.Insert(t, "project_resource", testutil.Cols{
		"project_id": projectID, "workspace_id": testWorkspaceID,
		"resource_type": "local_directory", "resource_ref": `{}`, "position": 0,
	})
	artifactIDs := make([]string, 2)
	for i, name := range []string{"first.md", "second.md"} {
		if err := testPool.QueryRow(context.Background(), `
			INSERT INTO project_artifact (workspace_id, project_id, resource_id, scope, doc_type,
				version, rel_path, blob_sha, size_bytes, source)
			VALUES ($1, $2, $3, 'project', 'research', 1, $4, '', 1, 'agent')
			RETURNING id::text`, testWorkspaceID, projectID, resourceID, name).Scan(&artifactIDs[i]); err != nil {
			t.Fatalf("insert artifact fixture: %v", err)
		}
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM project_artifact WHERE id = ANY($1::uuid[])`, artifactIDs)
	})
	attachmentIDs := make([]string, 2)
	for i, name := range []string{"first.txt", "second.txt"} {
		if err := testPool.QueryRow(context.Background(), `
			INSERT INTO attachment (workspace_id, uploader_type, uploader_id, filename, url, content_type, size_bytes)
			VALUES ($1, 'member', $2, $3, $4, 'text/plain', 1)
			RETURNING id::text`, testWorkspaceID, sender, name, "/"+name).Scan(&attachmentIDs[i]); err != nil {
			t.Fatalf("insert attachment fixture: %v", err)
		}
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM attachment WHERE id = ANY($1::uuid[])`, attachmentIDs)
	})
	code, body, attachmentMessage := groupSend(t, sender, sessionID, map[string]any{"content": "attachments"})
	if code != http.StatusCreated {
		t.Fatalf("send attachment message: %d %s", code, body)
	}
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO chat_message_resource_ref
			(message_id, position, resource_type, resource_id, resource_source, project_id)
		VALUES
			($1, 0, 'document', $2, 'artifact', $6),
			($1, 1, 'document', $3, 'artifact', $6),
			($7, 0, 'document', $4, 'attachment', NULL),
			($7, 1, 'document', $5, 'attachment', NULL)`,
		sent.MessageID, artifactIDs[0], artifactIDs[1], attachmentIDs[0], attachmentIDs[1], projectID, attachmentMessage.MessageID); err != nil {
		t.Fatalf("insert resource fixtures: %v", err)
	}

	countingDB := &chatResourceCountingExecutor{dbExecutor: testHandler.DB}
	h := *testHandler
	h.DB = countingDB
	h.Queries = db.New(countingDB)
	req := dmAsRequest(t, http.MethodGet, "/api/chat/sessions/"+sessionID+"/messages", nil, sender, "sessionId", sessionID)
	grouped := h.groupChatMessageResources(req, parseUUID(testWorkspaceID), []pgtype.UUID{parseUUID(sent.MessageID), parseUUID(attachmentMessage.MessageID)})
	artifacts := grouped[sent.MessageID]
	attachments := grouped[attachmentMessage.MessageID]
	if len(artifacts) != 2 || artifacts[0].Artifact == nil || artifacts[1].Artifact == nil || len(attachments) != 2 || attachments[0].Attachment == nil || attachments[1].Attachment == nil {
		t.Fatalf("hydrated resources = %#v, want four granted documents", grouped)
	}
	if countingDB.artifactQueries != 1 {
		t.Fatalf("artifact lookups = %d, want one batched query", countingDB.artifactQueries)
	}
	if countingDB.attachmentQueries != 1 {
		t.Fatalf("attachment lookups = %d, want one batched query", countingDB.attachmentQueries)
	}

	refs := []protocol.ChatResourceRef{
		{Type: "document", ID: artifactIDs[0], Source: "artifact", ProjectID: projectID},
		{Type: "document", ID: artifactIDs[1], Source: "artifact", ProjectID: projectID},
		{Type: "document", ID: attachmentIDs[0], Source: "attachment"},
		{Type: "document", ID: attachmentIDs[1], Source: "attachment"},
	}
	countingDB.artifactQueries = 0
	countingDB.attachmentQueries = 0
	if !h.validateChatResourceRefs(req, parseUUID(testWorkspaceID), refs) {
		t.Fatal("expected batched send validation to authorize all documents")
	}
	if countingDB.artifactQueries != 1 || countingDB.attachmentQueries != 1 {
		t.Fatalf("send validation lookups = artifacts %d, attachments %d; want one each", countingDB.artifactQueries, countingDB.attachmentQueries)
	}

	promptRows := make([]db.ChatMessageResourceRef, 0, len(refs))
	for i, ref := range refs {
		projectUUID := pgtype.UUID{}
		if ref.ProjectID != "" {
			projectUUID = parseUUID(ref.ProjectID)
		}
		promptRows = append(promptRows, db.ChatMessageResourceRef{
			MessageID: parseUUID(sent.MessageID), Position: int32(i),
			ResourceType: ref.Type, ResourceID: parseUUID(ref.ID),
			ResourceSource: ref.Source, ProjectID: projectUUID,
		})
	}
	countingDB.artifactQueries = 0
	countingDB.attachmentQueries = 0
	prompt := h.chatResourcePrompt(req, parseUUID(testWorkspaceID), promptRows)
	for _, expected := range []string{"first.md", "second.md", "first.txt", "second.txt"} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("agent resource prompt missing %q: %s", expected, prompt)
		}
	}
	if countingDB.artifactQueries != 1 || countingDB.attachmentQueries != 1 {
		t.Fatalf("agent prompt lookups = artifacts %d, attachments %d; want one each", countingDB.artifactQueries, countingDB.attachmentQueries)
	}
}

func TestNormalizeChatResourceRefsAcceptsModuleTypes(t *testing.T) {
	refs, err := normalizeChatResourceRefs([]protocol.ChatResourceRef{
		{Type: "module", ID: " module-1 "},
		{Type: "module_prototype", ID: "version-1"},
	})
	if err != nil {
		t.Fatalf("normalize module refs: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("expected two refs, got %#v", refs)
	}
	if refs[0].ID != "module-1" || refs[0].Kind != "module" {
		t.Fatalf("module ref = %#v, want trimmed id and kind=module", refs[0])
	}
	if refs[1].Kind != "prototype" {
		t.Fatalf("prototype ref = %#v, want kind=prototype", refs[1])
	}

	for _, bad := range [][]protocol.ChatResourceRef{
		{{Type: "module", ID: "m", Kind: "task"}},
		{{Type: "module", ID: "m", Source: "artifact"}},
		{{Type: "module_prototype", ID: "v", Kind: "task"}},
		{{Type: "module_prototype", ID: "v", Source: "attachment"}},
	} {
		if _, err := normalizeChatResourceRefs(bad); err == nil {
			t.Fatalf("expected %#v to be rejected", bad)
		}
	}
}

// D2: a module enters the prompt as a compact summary. Inlining the full
// feature contracts would burn the context window on every turn.
func TestFormatSharedModuleResourceKeepsContractsOutOfPrompt(t *testing.T) {
	canonical := 3
	got := formatSharedModuleResource("module:mod-1", protocol.ChatModuleSnapshot{
		ModuleID:                  "mod-1",
		ProjectID:                 "proj-1",
		Name:                      "线索分配",
		SpecVersion:               4,
		CanonicalPrototypeVersion: &canonical,
		FeaturePointCount:         7,
	})
	for _, expected := range []string{
		`- module:mod-1 — module "线索分配"`,
		"module_id mod-1",
		"project_id proj-1",
		"spec v4",
		"canonical prototype v3",
		"7 feature points",
		"full feature contracts are intentionally not inlined",
		// The prompt must name the read path: "not inlined" alone is what sent
		// chat agents through project/requirement commands without ever
		// reaching the prototype file.
		"multica module get mod-1",
		"multica module prototype read mod-1",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("module prompt missing %q:\n%s", expected, got)
		}
	}

	lean := formatSharedModuleResource("module:mod-2", protocol.ChatModuleSnapshot{Name: "空模块"})
	for _, unexpected := range []string{"spec v", "canonical prototype", "feature points"} {
		if strings.Contains(lean, unexpected) {
			t.Fatalf("module without a spec centre must not claim %q:\n%s", unexpected, lean)
		}
	}
}

func TestFormatSharedModulePrototypeResourceNamesVersion(t *testing.T) {
	got := formatSharedModulePrototypeResource("module_prototype:v-1", protocol.ChatModulePrototypeSnapshot{
		VersionID:  "v-1",
		ModuleID:   "mod-1",
		Version:    3,
		ModuleName: "线索分配",
		Status:     "confirmed",
		HTMLPath:   "prototypes/lead/v3.html",
	})
	for _, expected := range []string{
		"prototype v3",
		`of "线索分配"`,
		"(confirmed)",
		"prototypes/lead/v3.html",
		"multica module prototype read mod-1 --version 3",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("prototype prompt missing %q:\n%s", expected, got)
		}
	}

	// Modules only join the snapshot once migration 484 lands; until then the
	// owning issue title is the best available label.
	fallback := formatSharedModulePrototypeResource("module_prototype:v-2", protocol.ChatModulePrototypeSnapshot{
		Version: 1, IssueTitle: "原型需求",
	})
	if !strings.Contains(fallback, `of "原型需求"`) {
		t.Fatalf("prototype prompt must fall back to the issue title:\n%s", fallback)
	}
}

// C-15: while the flag is closed the server rejects both new ref types instead
// of resolving them, so a stale client cannot resurrect the surface.
func TestChatResourceBatchHidesModulesWhileFlagIsOff(t *testing.T) {
	if testHandler == nil {
		t.Fatal("handler not available for chat resource test")
	}
	withFeatureFlag(t, testHandler, featureflags.ModulePrototypeChat, false)
	req := httptest.NewRequest(http.MethodGet, "/api/chat/sessions/x/messages", nil)
	resolved := testHandler.resolveChatResourceBatch(req, parseUUID(testWorkspaceID), []protocol.ChatResourceRef{
		{Type: "module", ID: "00000000-0000-0000-0000-000000000001", Kind: "module"},
		{Type: "module_prototype", ID: "00000000-0000-0000-0000-000000000002", Kind: "prototype"},
	})
	if len(resolved) != 2 {
		t.Fatalf("resolved = %#v, want one entry per ref", resolved)
	}
	for _, resource := range resolved {
		if resource.Access != "missing" {
			t.Fatalf("%s resource = %#v, want missing while the flag is closed", resource.Type, resource)
		}
		if resource.Module != nil || resource.Prototype != nil {
			t.Fatalf("%s resource must not carry a snapshot while the flag is closed", resource.Type)
		}
	}
}

func TestChatResourceHydrationResolvesModuleAndPrototype(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Fatal("database not available for chat resource test")
	}
	withFeatureFlag(t, testHandler, featureflags.ModulePrototypeChat, true)
	sender := dmNewMember(t, "gresModuleA")
	peer := dmNewMember(t, "gresModuleB")
	code, sessionID := groupCreate(t, sender, map[string]any{
		"title": "module resources", "member_ids": []string{peer},
	})
	if code != http.StatusCreated {
		t.Fatalf("create group: %d %s", code, sessionID)
	}
	t.Cleanup(func() { dmCleanupSession(context.Background(), sessionID) })
	code, body, sent := groupSend(t, sender, sessionID, map[string]any{"content": "module resources"})
	if code != http.StatusCreated {
		t.Fatalf("send message: %d %s", code, body)
	}

	projectID := dbfx.Project(t, "module resource project")
	moduleID := dbfx.Insert(t, "project_module", testutil.Cols{
		"project_id":   projectID,
		"workspace_id": testWorkspaceID,
		"name":         "线索分配",
		"color":        "#10b981",
	})
	issueID := dbfx.Issue(t, "prototype bearing issue", testutil.Cols{"module_id": moduleID})
	versionID := dbfx.Insert(t, "issue_prototype_version", testutil.Cols{
		"issue_id":        issueID,
		"workspace_id":    testWorkspaceID,
		"version":         2,
		"html_path":       "prototypes/lead/v2.html",
		"prompt":          "第二版原型",
		"status":          "confirmed",
		"created_by_type": "member",
		"created_by_id":   testUserID,
	})
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO chat_message_resource_ref
			(message_id, position, resource_type, resource_id, resource_kind)
		VALUES
			($1, 0, 'module', $2, 'module'),
			($1, 1, 'module_prototype', $3, 'prototype')`, sent.MessageID, moduleID, versionID); err != nil {
		t.Fatalf("insert module resource fixtures: %v", err)
	}

	req := dmAsRequest(t, http.MethodGet, "/api/chat/sessions/"+sessionID+"/messages", nil, sender, "sessionId", sessionID)
	resources := testHandler.groupChatMessageResources(req, parseUUID(testWorkspaceID), []pgtype.UUID{parseUUID(sent.MessageID)})[sent.MessageID]
	if len(resources) != 2 {
		t.Fatalf("hydrated resources = %#v, want module and prototype", resources)
	}
	if resources[0].Access != "granted" || resources[0].Type != "module" {
		t.Fatalf("module resource = %#v, want granted", resources[0])
	}
	module, ok := resources[0].Module.(protocol.ChatModuleSnapshot)
	if !ok {
		t.Fatalf("module snapshot = %#v, want ChatModuleSnapshot", resources[0].Module)
	}
	if module.Name != "线索分配" || module.ProjectID != projectID || module.ModuleID != moduleID {
		t.Fatalf("module snapshot = %#v, want name/project/module from the database", module)
	}
	if resources[0].ProjectID != projectID {
		t.Fatalf("module resource project = %q, want %q", resources[0].ProjectID, projectID)
	}

	if resources[1].Access != "granted" || resources[1].Type != "module_prototype" {
		t.Fatalf("prototype resource = %#v, want granted", resources[1])
	}
	prototype, ok := resources[1].Prototype.(protocol.ChatModulePrototypeSnapshot)
	if !ok {
		t.Fatalf("prototype snapshot = %#v, want ChatModulePrototypeSnapshot", resources[1].Prototype)
	}
	if prototype.VersionID != versionID || prototype.Version != 2 || prototype.IssueID != issueID {
		t.Fatalf("prototype snapshot = %#v, want version id/2/issue from the database", prototype)
	}
	if prototype.Status != "confirmed" || prototype.HTMLPath != "prototypes/lead/v2.html" {
		t.Fatalf("prototype snapshot = %#v, want status and html path", prototype)
	}
}

func TestNormalizeChatResourceRefsRejectsInvalidShapes(t *testing.T) {
	tests := []struct {
		name string
		refs []protocol.ChatResourceRef
	}{
		{name: "too many", refs: []protocol.ChatResourceRef{
			{Type: "issue", ID: "1", Kind: "task"},
			{Type: "issue", ID: "2", Kind: "task"},
			{Type: "issue", ID: "3", Kind: "task"},
			{Type: "issue", ID: "4", Kind: "task"},
		}},
		{name: "unknown type", refs: []protocol.ChatResourceRef{{Type: "link", ID: "1"}}},
		{name: "issue kind mismatch", refs: []protocol.ChatResourceRef{{Type: "issue", ID: "1", Kind: "bug"}}},
		{name: "document source missing", refs: []protocol.ChatResourceRef{{Type: "document", ID: "1"}}},
		{name: "artifact project missing", refs: []protocol.ChatResourceRef{{Type: "document", ID: "1", Source: "artifact"}}},
		{name: "document kind forbidden", refs: []protocol.ChatResourceRef{{Type: "document", ID: "1", Source: "attachment", Kind: "task"}}},
		{name: "module kind mismatch", refs: []protocol.ChatResourceRef{{Type: "module", ID: "1", Kind: "task"}}},
		{name: "module document fields", refs: []protocol.ChatResourceRef{{Type: "module", ID: "1", Source: "artifact"}}},
		{name: "prototype kind mismatch", refs: []protocol.ChatResourceRef{{Type: "module_prototype", ID: "1", Kind: "issue"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := normalizeChatResourceRefs(tt.refs); err == nil {
				t.Fatalf("expected invalid refs to fail: %#v", tt.refs)
			}
		})
	}
}
