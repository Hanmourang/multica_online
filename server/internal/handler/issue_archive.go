package handler

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Issue 级档案聚合：组合既有表（comment / agent_task_queue / agent_run /
// agent_run_todo / project_artifact）为需求详情页的档案视图提供结构化
// 基础数据。完整的三层 rollup（加权进度 / 血缘链 / 孤儿检测）留 TODO。
// spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §5.5

// ─── f7 需求动态：按时间归并的单条动态流 ───────────────────────────────────────
// 数据源优先级：task_message（对话气泡，真实活链路）> agent_run_event（进展/状态，
// 依赖外部投影器写入，当前可能为空——诚实降级）> project_artifact（产物事件）。
// 事件四分体系：conversation / progress / status / artifact。

// dynamicsEvent is one item in the merged time stream.
type dynamicsEvent struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`       // conversation | progress | status | artifact
	TaskID    *string `json:"task_id"`    // owning task (for left-rail color dot)
	RunID     *string `json:"run_id"`     // owning run (if derived from agent_run_event)
	Actor     string  `json:"actor"`      // user | agent | tool
	ActorName string  `json:"actor_name"` // display name (agent_id or username)
	Content   string  `json:"content"`    // message text / event summary
	ToolName  *string `json:"tool_name"`  // tool_use / tool_result name
	Ts        string  `json:"ts"`         // ISO timestamp
}

// dynamicsDay groups events under one calendar date.
type dynamicsDay struct {
	Date   string          `json:"date"` // YYYY-MM-DD
	Events []dynamicsEvent `json:"events"`
}

// dynamicsSummary carries the five-metric summary bar.
type dynamicsSummary struct {
	TaskTotal           int64 `json:"task_total"`
	TaskDispatched      int64 `json:"task_dispatched"`
	MessageCount        int64 `json:"message_count"`
	ProgressEventCount  int64 `json:"progress_event_count"`
	ArtifactCount       int64 `json:"artifact_count"`
	ArtifactArchivedCnt int64 `json:"artifact_archived_count"`
}

// dynamicsFilterMeta describes available filter facets for the frontend.
type dynamicsFilterMeta struct {
	Tasks  []dynamicsTaskFacet `json:"tasks"`
	Agents []string            `json:"agents"`
	Types  []string            `json:"types"`
}

type dynamicsTaskFacet struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Agent  string `json:"agent"`
	Status string `json:"status"`
}

// GetIssueDynamics implements GET /api/issues/{id}/dynamics: the time-merged
// activity stream for the requirement dynamics tab (f7). Sources:
//   - task_message (conversation bubbles; real writer = antigravity agent)
//   - agent_run_event (progress/status events; writer = external projector,
//     may be empty — honest degradation, no fake data)
//   - project_artifact (artifact submission events)
func (h *Handler) GetIssueDynamics(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	ctx := r.Context()

	// ── 1. Tasks for this issue ────────────────────────────────────────────
	type taskMeta struct {
		id      string
		title   string
		agentID string
		status  string
	}
	taskMap := map[string]taskMeta{}
	var taskTotal, taskDispatched int64
	rows, err := h.DB.Query(ctx, `
		SELECT id, agent_id, status,
		       LEFT(COALESCE(NULLIF(trigger_summary, ''), 'Task ' || LEFT(id::text, 8)), 80)
		FROM agent_task_queue
		WHERE issue_id = $1
		ORDER BY created_at ASC
		LIMIT 200`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue dynamics")
		return
	}
	for rows.Next() {
		var id, agentID pgtype.UUID
		var status, title string
		if err := rows.Scan(&id, &agentID, &status, &title); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan tasks")
			return
		}
		tm := taskMeta{id: uuidToString(id), title: title, agentID: uuidToString(agentID), status: status}
		taskMap[tm.id] = tm
		taskTotal++
		if status != "queued" && status != "pending" {
			taskDispatched++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue dynamics")
		return
	}

	// Collect task IDs for the IN clause.
	taskIDs := make([]pgtype.UUID, 0, len(taskMap))
	for _, tm := range taskMap {
		taskIDs = append(taskIDs, parseUUID(tm.id))
	}

	// ── 2. Conversation events from task_message ───────────────────────────
	var allEvents []dynamicsEvent
	var messageCount int64
	if len(taskIDs) > 0 {
		msgRows, err := h.DB.Query(ctx, `
			SELECT tm.id, tm.task_id, tm.type, tm.tool, tm.content, tm.output, tm.created_at
			FROM task_message tm
			WHERE tm.task_id = ANY($1)
			ORDER BY tm.created_at DESC
			LIMIT 500`,
			taskIDs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load task messages")
			return
		}
		for msgRows.Next() {
			var id, taskID pgtype.UUID
			var msgType string
			var tool, content, output pgtype.Text
			var createdAt pgtype.Timestamptz
			if err := msgRows.Scan(&id, &taskID, &msgType, &tool, &content, &output, &createdAt); err != nil {
				msgRows.Close()
				writeError(w, http.StatusInternalServerError, "failed to scan task messages")
				return
			}
			tid := uuidToString(taskID)
			tm := taskMap[tid]

			// Classify actor from message type.
			actor := "agent"
			actorName := tm.agentID
			if msgType == "text" && content.Valid && len(content.String) > 0 {
				// Heuristic: first message in a task is often the user dispatch.
				// task_message.type is written by the agent framework, so text = agent reply.
				actor = "agent"
			}
			if msgType == "tool_use" || msgType == "tool_result" {
				actor = "tool"
				if tool.Valid {
					actorName = tool.String
				}
			}

			// Build display content.
			displayContent := ""
			if content.Valid {
				displayContent = content.String
			} else if output.Valid {
				displayContent = output.String
			}
			if len(displayContent) > 300 {
				displayContent = displayContent[:300] + "…"
			}

			var toolName *string
			if tool.Valid && tool.String != "" {
				tn := tool.String
				toolName = &tn
			}
			var taskIDPtr *string
			taskIDPtr = &tid

			allEvents = append(allEvents, dynamicsEvent{
				ID:        uuidToString(id),
				Type:      "conversation",
				TaskID:    taskIDPtr,
				Actor:     actor,
				ActorName: actorName,
				Content:   displayContent,
				ToolName:  toolName,
				Ts:        timestampToString(createdAt),
			})
			messageCount++
		}
		msgRows.Close()
		if err := msgRows.Err(); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load task messages")
			return
		}
	}

	// ── 3. Progress/status events from agent_run_event ─────────────────────
	// NOTE: agent_run_event currently has no automated producer in the codebase.
	// The write endpoint (POST /agent-runs/{id}/events) exists for external
	// projectors. If empty, we degrade honestly — no fake data.
	var progressEventCount int64
	evtRows, err := h.DB.Query(ctx, `
		SELECT are.id, are.run_id, are.event_type, are.detail, are.created_at,
		       ar.task_queue_id, ar.agent_id
		FROM agent_run_event are
		JOIN agent_run ar ON ar.id = are.run_id
		WHERE ar.issue_id = $1 OR ar.root_issue_id = $1
		ORDER BY are.created_at DESC
		LIMIT 200`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run events")
		return
	}
	for evtRows.Next() {
		var id, runID, taskQueueID, agentID pgtype.UUID
		var eventType string
		var detail []byte
		var createdAt pgtype.Timestamptz
		if err := evtRows.Scan(&id, &runID, &eventType, &detail, &createdAt, &taskQueueID, &agentID); err != nil {
			evtRows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan run events")
			return
		}

		// Classify: heartbeat/todo_change → progress; rate_limit/net_err/crash → status.
		evType := "progress"
		switch eventType {
		case "rate_limit", "net_err", "crash":
			evType = "status"
		}

		var tidPtr, ridPtr *string
		if taskQueueID.Valid {
			s := uuidToString(taskQueueID)
			tidPtr = &s
		}
		rid := uuidToString(runID)
		ridPtr = &rid

		allEvents = append(allEvents, dynamicsEvent{
			ID:        uuidToString(id),
			Type:      evType,
			TaskID:    tidPtr,
			RunID:     ridPtr,
			Actor:     "agent",
			ActorName: uuidToString(agentID),
			Content:   eventType,
			Ts:        timestampToString(createdAt),
		})
		progressEventCount++
	}
	evtRows.Close()
	if err := evtRows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load run events")
		return
	}

	// ── 4. Artifact events ─────────────────────────────────────────────────
	var artifactCount, artifactArchivedCount int64
	artRows, err := h.DB.Query(ctx, `
		SELECT id, rel_path, source, synced_at, deleted_at
		FROM project_artifact
		WHERE issue_id = $1
		ORDER BY synced_at DESC
		LIMIT 100`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load artifacts")
		return
	}
	for artRows.Next() {
		var id pgtype.UUID
		var relPath, source string
		var syncedAt pgtype.Timestamptz
		var deletedAt pgtype.Timestamptz
		if err := artRows.Scan(&id, &relPath, &source, &syncedAt, &deletedAt); err != nil {
			artRows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan artifacts")
			return
		}
		artifactCount++
		if !deletedAt.Valid {
			artifactArchivedCount++
		}
		allEvents = append(allEvents, dynamicsEvent{
			ID:        uuidToString(id),
			Type:      "artifact",
			Actor:     source,
			ActorName: source,
			Content:   relPath,
			Ts:        timestampToString(syncedAt),
		})
	}
	artRows.Close()
	if err := artRows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load artifacts")
		return
	}

	// ── 5. Sort all events by timestamp descending ─────────────────────────
	sortDynamicsEvents(allEvents)

	// ── 6. Group by day ────────────────────────────────────────────────────
	days := groupEventsByDay(allEvents)

	// ── 7. Build filter facets ─────────────────────────────────────────────
	taskFacets := make([]dynamicsTaskFacet, 0, len(taskMap))
	agentSet := map[string]bool{}
	for _, tm := range taskMap {
		taskFacets = append(taskFacets, dynamicsTaskFacet{
			ID: tm.id, Title: tm.title, Agent: tm.agentID, Status: tm.status,
		})
		if tm.agentID != "" {
			agentSet[tm.agentID] = true
		}
	}
	agents := make([]string, 0, len(agentSet))
	for a := range agentSet {
		agents = append(agents, a)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"issue": map[string]any{
			"id":     uuidToString(issue.ID),
			"title":  issue.Title,
			"status": issue.Status,
		},
		"days": days,
		"summary": dynamicsSummary{
			TaskTotal:           taskTotal,
			TaskDispatched:      taskDispatched,
			MessageCount:        messageCount,
			ProgressEventCount:  progressEventCount,
			ArtifactCount:       artifactCount,
			ArtifactArchivedCnt: artifactArchivedCount,
		},
		"filters": dynamicsFilterMeta{
			Tasks:  taskFacets,
			Agents: agents,
			Types:  []string{"conversation", "progress", "status", "artifact"},
		},
	})
}

// sortDynamicsEvents sorts events by timestamp descending (newest first).
func sortDynamicsEvents(events []dynamicsEvent) {
	for i := 1; i < len(events); i++ {
		for j := i; j > 0 && events[j].Ts > events[j-1].Ts; j-- {
			events[j], events[j-1] = events[j-1], events[j]
		}
	}
}

// groupEventsByDay buckets events into day groups (YYYY-MM-DD keys, desc order).
func groupEventsByDay(events []dynamicsEvent) []dynamicsDay {
	if len(events) == 0 {
		return []dynamicsDay{}
	}
	dayMap := map[string][]dynamicsEvent{}
	var dayOrder []string
	for _, ev := range events {
		day := ""
		if len(ev.Ts) >= 10 {
			day = ev.Ts[:10]
		}
		if day == "" {
			day = "unknown"
		}
		if _, exists := dayMap[day]; !exists {
			dayOrder = append(dayOrder, day)
		}
		dayMap[day] = append(dayMap[day], ev)
	}
	result := make([]dynamicsDay, 0, len(dayOrder))
	for _, d := range dayOrder {
		result = append(result, dynamicsDay{Date: d, Events: dayMap[d]})
	}
	return result
}

// ─── f8 交付概览：四状态卡（派生状态 / 调度互斥 / 角色班底 / 档案完整度）+ 阶段带 ───
//
// 三个数据源的真实可用性（2026-09-05 调研结论，实现深度据此决定，不伪造）：
//
//  1. 派生状态 —— 9 规则投影内联在 server/pkg/db/queries/issue.sql 的 ListIssues
//     分页列表查询里（requirement_status / stage_progress 两列），没有单需求版本，
//     issue-archive detail 路径无法直接复用；且本任务禁止改 server/queries/*.sql
//     （sqlc CI 门禁比对 generated diff）。因此 loadDeliverablesProjection 用等价
//     原生 SQL 重新实现。
//     ⚠ 双份真相（已知反模式，此处无法避免，明确披露）：9 规则若在 issue.sql
//     调整，本文件的 CASE 必须同步；requirementStatusKeys 映射表也要跟着补。
//     TODO(Wave 3): 抽成 DB 函数 issue_requirement_status(workspace_id, issue_id)，
//     让 ListIssues 与本 handler 共用同一份规则，消除重复。
//
//  2. ModuleLocker —— 真实写入方存在且已接线：daemon.go acquireModuleLockIfNeeded
//     → ModuleLocker.Acquire(onWait) → client.MarkTaskWaitingModuleLock →
//     service.TaskService.MarkTaskWaitingModuleLock 落 agent_task_queue.status =
//     'waiting_module_lock' + wait_reason（migration 451 加的状态枚举、109 加的列）。
//     所以互斥卡渲染真数据，不需要伪造。
//     ⚠ 局限：锁持有者表（ModuleLocker.holders）是 daemon 进程内存态，服务端拿不到
//     全局锁视图。能诚实给出的是「同模块并发活跃任务数」（= locker 的 module total）
//     「本需求泊在 waiting_module_lock 的任务数 + wait_reason 原文」。issue.module_id
//     为 NULL 时 ModuleLocker 直接跳过 Acquire（「无模块任务不参与」），此时返回
//     module_lock: null，前端诚实降级为「暂无互斥信息」而不是显示假的未锁定。
//
//  3. 角色班底 —— issue_role_assignment（migration 453）真实存在，端点
//     GET /api/issues/{id}/roles 与前端 issueRolesOptions hook 均已可用，但该 hook
//     只返回裸 assignee_id（UUID），且全仓没有 agent / member 名称解析 hook，前端
//     直接复用会把班底渲染成一串 UUID。因此班底随本聚合端点一次带回并在服务端解析
//     显示名：行仍走 sqlc 的 ListIssueRoleAssignments（roster 契约单一来源不复制），
//     只额外做一次批量取名。
//
// 阶段门（stage_gate）：migration 460 新建 stage_gate_rule 表补齐了此前完全缺失的
// 规则载体 ——「每个 stage 要求哪些 doc_type 齐备」。此前 project_artifact.doc_type
// 是开放式字符串、没有必备清单语义，服务端只能证明「某已进入阶段的档案架为空」，
// 无法断言「缺哪份文档 / 门是否闭合」。落地后：
//   · 规则来源优先级 —— project 级（project_id 非空）覆盖 workspace 级默认（project_id NULL），
//     由 loadDeliverablesStageGates 的 NOT EXISTS 子查询在单条 SQL 内解析（见该函数注释）。
//   · missing_items 升级为区分 empty_stage（该阶段完全无档案）与 missing_doc_type
//     （门规则要求的具体 blocking 文档缺失，带 required_doc_type + stage）。
//   · stage_gates 给出每个 stage 的 gate_closed / required_total / required_ready 与
//     「S{n} 门未闭合 → 阻止进 S{n+1}」的 blocking_next_stage（对齐原型 f8 卡4 文案）。
//   · 档案完整度环按 anno②「环只算必备件」——只统计 blocking=true 的规则项。
//   · 无任何规则时 gate_defined=false，missing_items 退回 empty_stage-only 的旧行为，
//     前端诚实降级为「未配置阶段门」而不是伪造缺件。

// deliverablesModuleRef is the issue's project_module pointer — the key the
// daemon-side ModuleLocker takes its lock under.
type deliverablesModuleRef struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// deliverablesDerivedStatus is the 9-rule requirement status projection for one
// issue (see the dual-source-of-truth disclosure above).
type deliverablesDerivedStatus struct {
	// RequirementStatus is the raw literal ListIssues emits, kept so this
	// endpoint stays contract-compatible with issue.requirement_status (which
	// calendar-view already keys its icon/tone dictionaries off).
	RequirementStatus string `json:"requirement_status"`
	// StatusKey is the stable ASCII enum the i18n layer resolves. "unknown"
	// means issue.sql grew a literal this handler has not mapped yet — the
	// frontend then shows the raw literal instead of inventing a label.
	StatusKey string `json:"status_key"`
	// NextActionKey is the honest next move implied by StatusKey; "none" = 无.
	// Derived purely from the projection, never from a stage-gate spec.
	NextActionKey string `json:"next_action_key"`
	// StageProgress mirrors ListIssues' "N/M" stage-3 text (null when the
	// requirement has no stage-3 sub-issue).
	StageProgress *string `json:"stage_progress"`
	StageDone     int32   `json:"stage_done"`
	StageTotal    int32   `json:"stage_total"`
	// CurrentStage is the prototype's `cur` node (1..4).
	CurrentStage int32 `json:"current_stage"`
}

// deliverablesWaitEntry is one of this issue's tasks parked on a module lock.
// Reason is the daemon-written wait_reason verbatim (it names the holder
// module) — data, not UI chrome, so it is passed through untranslated the same
// way progress-tracker renders stall_distribution reasons.
type deliverablesWaitEntry struct {
	TaskID string  `json:"task_id"`
	Reason *string `json:"reason"`
}

// deliverablesModuleLock is the honest server-side view of the ModuleLocker
// state for one issue. null at the top level means "not applicable" (the issue
// carries no module, so the locker never engages).
type deliverablesModuleLock struct {
	Module        deliverablesModuleRef `json:"module"`
	AvoidConflict bool                  `json:"avoid_conflict"`
	// SameModuleActive counts dispatched/running tasks across every issue that
	// shares this module (self included) — the locker's per-module total. Same
	// module never blocks itself, so this reads as 「同组并发」.
	SameModuleActive int64 `json:"same_module_active"`
	// ActiveCount is this issue's own dispatched/running task count.
	ActiveCount int64 `json:"active_count"`
	// WaitingCount is this issue's tasks parked in waiting_module_lock, i.e.
	// serialised behind a conflicting module — 「跨组串行」.
	WaitingCount int64                   `json:"waiting_count"`
	Waiting      []deliverablesWaitEntry `json:"waiting"`
}

// deliverablesRoleAssignment is one issue_role_assignment row with its assignee
// display name resolved server-side (the roster hook ships bare UUIDs).
type deliverablesRoleAssignment struct {
	Role         string `json:"role"`
	AssigneeType string `json:"assignee_type"`
	AssigneeID   string `json:"assignee_id"`
	AssigneeName string `json:"assignee_name"`
	Enabled      bool   `json:"enabled"`
	Ordinal      int32  `json:"ordinal"`
}

// deliverablesStageNode is one node of the four-stage band.
type deliverablesStageNode struct {
	Stage int32  `json:"stage"`
	State string `json:"state"` // done | cur | todo
	// ArtifactCount is the archived project_artifact rows carrying this stage.
	ArtifactCount int64 `json:"artifact_count"`
	// TaskDone/TaskTotal are the stage's sub-issue counters (the 「3/5」 cue).
	TaskDone  int32 `json:"task_done"`
	TaskTotal int32 `json:"task_total"`
}

// deliverablesMissingItem is one archive gap the server can prove from facts.
// Kind is "empty_stage" when an already-entered stage holds zero archived
// artifacts at all, or "missing_doc_type" when a stage_gate_rule (migration 460)
// requires a specific blocking doc_type that has no matching artifact — the
// latter carries RequiredDocType so the frontend can offer the two repair entry
// points (原型 f8 anno③：从模板创建 / 让 agent 补写).
type deliverablesMissingItem struct {
	Stage int32  `json:"stage"`
	Kind  string `json:"kind"` // empty_stage | missing_doc_type
	// RequiredDocType is set only for kind == "missing_doc_type".
	RequiredDocType *string `json:"required_doc_type,omitempty"`
}

// deliverablesStageGate is the gate verdict for one stage, derived from
// stage_gate_rule (migration 460) LEFT-JOINed against project_artifact by
// (stage, doc_type). Only blocking rules feed the counts — anno②「环只算必备件」.
type deliverablesStageGate struct {
	Stage int32 `json:"stage"`
	// GateDefined is false when the resolved ruleset has no row for this stage,
	// i.e. nothing gates it. The frontend then shows no gate verdict for it.
	GateDefined bool `json:"gate_defined"`
	// RequiredTotal / RequiredReady count blocking rules only.
	RequiredTotal int64 `json:"required_total"`
	RequiredReady int64 `json:"required_ready"`
	// GateClosed is true when every blocking rule for the stage is satisfied (or
	// the stage has no blocking rule). An undefined gate reads as closed.
	GateClosed bool `json:"gate_closed"`
	// BlockingNextStage mirrors 原型「S{n} 门未闭合 → 阻止进 S{n+1}」: the gate is
	// open AND this stage is the requirement's current frontier (state == cur)
	// AND there is a next stage to block. A retroactively open `done` stage does
	// not block — the requirement already advanced past it.
	BlockingNextStage bool `json:"blocking_next_stage"`
	// MissingDocTypes lists the blocking doc_types with no artifact, in rule
	// sort_order — the actionable gap behind an open gate.
	MissingDocTypes []string `json:"missing_doc_types"`
}

// requirementStatusKeys maps the 10 literals the ListIssues projection emits onto
// stable ASCII enums. A literal missing here yields "unknown" rather than a
// guessed label. The `acceptance_failed` key is a contract with the frontend
// i18n bundle (`status_acceptance_failed`).
var requirementStatusKeys = map[string]string{
	"未拆解":    "not_decomposed",
	"原型待确认":  "prototype_pending",
	"拆解待确认":  "decomposition_pending",
	"待触发":    "pending_trigger",
	"执行中":    "executing",
	"等待模块释放": "waiting_module_lock",
	"验收中":    "accepting",
	"验收失败":   "acceptance_failed",
	"已完成":    "completed",
	"已取消":    "cancelled",
}

// statusKeyCurrentStage maps a derived status onto the stage the requirement is
// sitting in — the prototype's `cur` node. Stages below it are `done`.
var statusKeyCurrentStage = map[string]int32{
	"prototype_pending":     1,
	"decomposition_pending": 2,
	"not_decomposed":        2,
	"pending_trigger":       3,
	"waiting_module_lock":   3,
	"executing":             3,
	"accepting":             4,
	"acceptance_failed":     4,
	"completed":             4,
	"cancelled":             4,
}

// statusKeyNextAction maps a derived status onto the honest next move. Every
// value is derivable from the projection alone — no stage-gate spec involved.
var statusKeyNextAction = map[string]string{
	"prototype_pending":     "confirm_prototype",
	"decomposition_pending": "confirm_decomposition",
	"not_decomposed":        "decompose",
	"pending_trigger":       "trigger",
	"waiting_module_lock":   "wait_module_lock",
	"executing":             "finish_execution",
	"accepting":             "finish_acceptance",
	"acceptance_failed":     "manual_arbitration",
	"completed":             "none",
	"cancelled":             "none",
}

// deliverablesProjection is the flattened result of the derived-status query.
type deliverablesProjection struct {
	derived       deliverablesDerivedStatus
	module        *deliverablesModuleRef
	avoidConflict bool
	// stageTotal/stageDone are indexed 1..4 (slot 0 unused) — sub-issue counts
	// per requirement-calendar stage.
	stageTotal [5]int32
	stageDone  [5]int32
}

// loadDeliverablesProjection computes the 9-rule derived status plus the
// per-stage sub-issue counters and the module pointer in one round trip.
//
// The CASE block below is a verbatim copy of the requirement_status projection
// in server/pkg/db/queries/issue.sql (ListIssues). Keep the two in sync — see
// the dual-source-of-truth disclosure at the top of this section.
func (h *Handler) loadDeliverablesProjection(ctx context.Context, issueID pgtype.UUID) (deliverablesProjection, error) {
	var (
		proj          deliverablesProjection
		requirementSt string
		moduleID      pgtype.UUID
		moduleName    pgtype.Text
		moduleColor   pgtype.Text
		stageTotals   [4]int32
		stageDones    [4]int32
	)
	err := h.DB.QueryRow(ctx, `
		SELECT
		    CASE
		        WHEN issue_effective_status(i.workspace_id, i.status) = 'done' THEN '已完成'
		        WHEN issue_effective_status(i.workspace_id, i.status) = 'cancelled' THEN '已取消'
		        -- 第 10 态（spec §6 增补 / 开放问题 #4）：累计 4 轮打回仍未过 = 验收失败终态。
		        -- 置于阶段态之前：一旦越界即终态，不再被残留的 open 子任务翻回「执行中/验收中」。
		        WHEN i.acceptance_round > 3 THEN '验收失败'
		        WHEN COALESCE(prog.has_open_stage1, FALSE) THEN '原型待确认'
		        WHEN i.decomposition_confirmed_at IS NULL AND COALESCE(prog.has_stage2, FALSE) THEN '拆解待确认'
		        WHEN i.decomposition_confirmed_at IS NULL THEN '未拆解'
		        WHEN i.triggered_at IS NULL THEN '待触发'
		        -- 规则 6 修正（父状态优先于子计数）：仅当没有任何 stage3 子任务正在推进
		        -- （dispatched/running）且确有子任务在等模块锁时，才判「等待模块释放」；
		        -- 否则只要还有 stage3 在跑就是「执行中」，等锁只是局部阻塞不代表整体停摆。
		        WHEN NOT EXISTS (
		            SELECT 1 FROM issue rc
		            JOIN agent_task_queue rq ON rq.issue_id = rc.id
		            WHERE rc.parent_issue_id = i.id AND rq.status IN ('dispatched', 'running')
		        ) AND EXISTS (
		            SELECT 1 FROM issue wc
		            JOIN agent_task_queue wq ON wq.issue_id = wc.id
		            WHERE wc.parent_issue_id = i.id AND wq.status = 'waiting_module_lock'
		        ) THEN '等待模块释放'
		        WHEN COALESCE(prog.has_open_stage3, FALSE) THEN '执行中'
		        WHEN COALESCE(prog.has_open_stage4, FALSE) THEN '验收中'
		        ELSE '已完成'
		    END AS requirement_status,
		    COALESCE(prog.stage1_total, 0)::int, COALESCE(prog.stage1_done, 0)::int,
		    COALESCE(prog.stage2_total, 0)::int, COALESCE(prog.stage2_done, 0)::int,
		    COALESCE(prog.stage3_total, 0)::int, COALESCE(prog.stage3_done, 0)::int,
		    COALESCE(prog.stage4_total, 0)::int, COALESCE(prog.stage4_done, 0)::int,
		    i.module_id, i.avoid_conflict, pm.name, pm.color
		FROM issue i
		LEFT JOIN project_module pm ON pm.id = i.module_id
		LEFT JOIN LATERAL (
		    SELECT
		        COUNT(*) FILTER (WHERE c.stage = 1)::int AS stage1_total,
		        COUNT(*) FILTER (WHERE c.stage = 1 AND issue_effective_status(c.workspace_id, c.status) IN ('done','cancelled'))::int AS stage1_done,
		        COUNT(*) FILTER (WHERE c.stage = 2)::int AS stage2_total,
		        COUNT(*) FILTER (WHERE c.stage = 2 AND issue_effective_status(c.workspace_id, c.status) IN ('done','cancelled'))::int AS stage2_done,
		        COUNT(*) FILTER (WHERE c.stage = 3)::int AS stage3_total,
		        COUNT(*) FILTER (WHERE c.stage = 3 AND issue_effective_status(c.workspace_id, c.status) IN ('done','cancelled'))::int AS stage3_done,
		        COUNT(*) FILTER (WHERE c.stage = 4)::int AS stage4_total,
		        COUNT(*) FILTER (WHERE c.stage = 4 AND issue_effective_status(c.workspace_id, c.status) IN ('done','cancelled'))::int AS stage4_done,
		        BOOL_OR(c.stage = 1 AND issue_effective_status(c.workspace_id, c.status) NOT IN ('done','cancelled')) AS has_open_stage1,
		        BOOL_OR(c.stage = 2) AS has_stage2,
		        BOOL_OR(c.stage = 3 AND issue_effective_status(c.workspace_id, c.status) NOT IN ('done','cancelled')) AS has_open_stage3,
		        BOOL_OR(c.stage = 4 AND issue_effective_status(c.workspace_id, c.status) NOT IN ('done','cancelled')) AS has_open_stage4
		    FROM issue c
		    WHERE c.parent_issue_id = i.id
		) prog ON TRUE
		WHERE i.id = $1`,
		issueID).Scan(
		&requirementSt,
		&stageTotals[0], &stageDones[0],
		&stageTotals[1], &stageDones[1],
		&stageTotals[2], &stageDones[2],
		&stageTotals[3], &stageDones[3],
		&moduleID, &proj.avoidConflict, &moduleName, &moduleColor,
	)
	if err != nil {
		return proj, err
	}

	for s := 1; s <= 4; s++ {
		proj.stageTotal[s] = stageTotals[s-1]
		proj.stageDone[s] = stageDones[s-1]
	}

	statusKey, mapped := requirementStatusKeys[requirementSt]
	if !mapped {
		statusKey = "unknown"
	}

	// The card reads 「执行中 S3 · 3/5」: the counter belongs to the *current*
	// stage, which for the executing/accepting statuses is exactly the stage-3
	// pair ListIssues reports as stage_progress.
	currentStage, known := statusKeyCurrentStage[statusKey]
	if !known {
		// Unmapped literal: fall back to the highest stage that has sub-issues so
		// the band still points somewhere truthful instead of always at S1.
		currentStage = 1
		for s := 1; s <= 4; s++ {
			if proj.stageTotal[s] > 0 {
				currentStage = int32(s)
			}
		}
	}
	nextAction, known := statusKeyNextAction[statusKey]
	if !known {
		nextAction = "none"
	}

	proj.derived = deliverablesDerivedStatus{
		RequirementStatus: requirementSt,
		StatusKey:         statusKey,
		NextActionKey:     nextAction,
		// Same "N/M" contract as ListIssues.stage_progress: stage-3 only, null
		// when the requirement has no stage-3 sub-issue.
		StageProgress: nonemptyTextPtr(stageProgressText(stageTotals[2], stageDones[2])),
		StageDone:     proj.stageDone[currentStage],
		StageTotal:    proj.stageTotal[currentStage],
		CurrentStage:  currentStage,
	}

	if moduleID.Valid {
		proj.module = &deliverablesModuleRef{
			ID:    uuidToString(moduleID),
			Name:  moduleName.String,
			Color: moduleColor.String,
		}
	}
	return proj, nil
}

// stageProgressText renders the ListIssues "N/M" sentinel ("" when total is 0).
func stageProgressText(total, done int32) string {
	if total <= 0 {
		return ""
	}
	return strconv.Itoa(int(done)) + "/" + strconv.Itoa(int(total))
}

// loadDeliverablesModuleLock assembles the honest ModuleLocker view for one
// issue. Returns nil when the issue carries no module — the daemon-side locker
// skips module-less tasks entirely, so there is nothing truthful to report.
func (h *Handler) loadDeliverablesModuleLock(ctx context.Context, issueID pgtype.UUID, module *deliverablesModuleRef, avoidConflict bool) (*deliverablesModuleLock, error) {
	if module == nil {
		return nil, nil
	}
	lock := &deliverablesModuleLock{
		Module:        *module,
		AvoidConflict: avoidConflict,
		Waiting:       []deliverablesWaitEntry{},
	}

	// This issue's own queue split: parked on the lock vs actively holding it.
	err := h.DB.QueryRow(ctx, `
		SELECT
		    COUNT(*) FILTER (WHERE status = 'waiting_module_lock')::bigint,
		    COUNT(*) FILTER (WHERE status IN ('dispatched','running'))::bigint
		FROM agent_task_queue
		WHERE issue_id = $1`,
		issueID).Scan(&lock.WaitingCount, &lock.ActiveCount)
	if err != nil {
		return nil, err
	}

	// Same-module concurrency across the whole project (self included). The
	// locker never blocks within a module, so every one of these runs in
	// parallel with us — this is the 「同组并发」 figure.
	err = h.DB.QueryRow(ctx, `
		SELECT COUNT(*)::bigint
		FROM agent_task_queue q
		JOIN issue i ON i.id = q.issue_id
		WHERE i.module_id = $1 AND q.status IN ('dispatched','running')`,
		parseUUID(module.ID)).Scan(&lock.SameModuleActive)
	if err != nil {
		return nil, err
	}

	if lock.WaitingCount > 0 {
		rows, err := h.DB.Query(ctx, `
			SELECT id, wait_reason
			FROM agent_task_queue
			WHERE issue_id = $1 AND status = 'waiting_module_lock'
			ORDER BY created_at ASC
			LIMIT 10`,
			issueID)
		if err != nil {
			return nil, err
		}
		// IIFE + defer so the cursor is fully closed before the next statement —
		// pgx binds one connection per transaction/pool checkout.
		func() {
			defer rows.Close()
			for rows.Next() {
				var id pgtype.UUID
				var reason pgtype.Text
				if err := rows.Scan(&id, &reason); err != nil {
					return
				}
				lock.Waiting = append(lock.Waiting, deliverablesWaitEntry{
					TaskID: uuidToString(id),
					Reason: textToPtr(reason),
				})
			}
		}()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return lock, nil
}

// loadDeliverablesRoles returns the requirement's roster snapshot with display
// names resolved. Rows come from the sqlc-generated ListIssueRoleAssignments so
// the roster contract (filter + ordering) stays single-sourced; only the name
// lookup is raw SQL, batched into one round trip for both assignee kinds.
func (h *Handler) loadDeliverablesRoles(ctx context.Context, issueID pgtype.UUID) ([]deliverablesRoleAssignment, error) {
	rows, err := h.Queries.ListIssueRoleAssignments(ctx, issueID)
	if err != nil {
		return nil, err
	}
	out := make([]deliverablesRoleAssignment, 0, len(rows))
	agentIDs := []pgtype.UUID{}
	userIDs := []pgtype.UUID{}
	for _, row := range rows {
		out = append(out, deliverablesRoleAssignment{
			Role:         row.Role,
			AssigneeType: row.AssigneeType,
			AssigneeID:   uuidToString(row.AssigneeID),
			AssigneeName: "",
			Enabled:      row.Enabled,
			Ordinal:      row.Ordinal,
		})
		// issue_role_assignment CHECKs assignee_type IN ('member','agent');
		// 'member' assignee_id is a "user".id (same convention as issue.assignee_id).
		if row.AssigneeType == "agent" {
			agentIDs = append(agentIDs, row.AssigneeID)
		} else {
			userIDs = append(userIDs, row.AssigneeID)
		}
	}
	if len(out) == 0 {
		return out, nil
	}

	names := map[string]string{}
	nameRows, err := h.DB.Query(ctx, `
		SELECT id, name FROM agent WHERE id = ANY($1::uuid[])
		UNION ALL
		SELECT id, name FROM "user" WHERE id = ANY($2::uuid[])`,
		agentIDs, userIDs)
	if err != nil {
		return nil, err
	}
	func() {
		defer nameRows.Close()
		for nameRows.Next() {
			var id pgtype.UUID
			var name string
			if err := nameRows.Scan(&id, &name); err != nil {
				return
			}
			names[uuidToString(id)] = name
		}
	}()
	if err := nameRows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		// Unresolvable id (agent hard-deleted, member removed) keeps "" — the
		// frontend falls back to the truncated UUID rather than a fake name.
		out[i].AssigneeName = names[out[i].AssigneeID]
	}
	return out, nil
}

// buildDeliverablesStageFlow renders the four-stage band. Stages below the
// derived current stage are `done`, the current one is `cur`, the rest `todo`;
// a finished/cancelled requirement marks all four done.
func buildDeliverablesStageFlow(proj deliverablesProjection, artifactsByStage map[string]int64) []deliverablesStageNode {
	settled := proj.derived.StatusKey == "completed" || proj.derived.StatusKey == "cancelled"
	nodes := make([]deliverablesStageNode, 0, 4)
	for s := int32(1); s <= 4; s++ {
		state := "todo"
		switch {
		case settled || s < proj.derived.CurrentStage:
			state = "done"
		case s == proj.derived.CurrentStage:
			state = "cur"
		}
		nodes = append(nodes, deliverablesStageNode{
			Stage:         s,
			State:         state,
			ArtifactCount: artifactsByStage[strconv.Itoa(int(s))],
			TaskDone:      proj.stageDone[s],
			TaskTotal:     proj.stageTotal[s],
		})
	}
	return nodes
}

// deliverablesGateSummary is the resolved stage-gate picture for one issue:
// the four per-stage verdicts plus the ring totals (blocking rules only).
type deliverablesGateSummary struct {
	// gates always holds exactly four entries, stage 1..4, in order.
	gates         []deliverablesStageGate
	requiredTotal int64
	requiredReady int64
	// gateDefined is false when the resolved ruleset is empty (no row at all) —
	// the frontend then degrades to the legacy "stages with artifact" ring
	// instead of inventing a required-doc denominator.
	gateDefined bool
}

// loadDeliverablesStageGates resolves the stage_gate_rule (migration 460)
// ruleset for one issue and LEFT-JOINs it against project_artifact by
// (stage, doc_type) to decide which required documents exist.
//
// Rule-source priority is resolved inside the single query: when the issue's
// project carries its own rules (project_id = $2), those win; otherwise the
// workspace-level defaults (project_id IS NULL) apply. The NOT EXISTS branch is
// what encodes "project overrides workspace" without a second round trip. A
// NULL $2 (issue with no project) naturally falls through to the workspace
// defaults, since `project_id = NULL` is never true.
//
// Only blocking rules feed RequiredTotal / RequiredReady / the ring (anno②
// 「环只算必备件」); non-blocking rows mark the stage GateDefined but never open
// the gate. Artifacts are matched on issue_id, mirroring the overview's own
// by_stage aggregation, so a requirement-level gate counts exactly the rows the
// rest of this endpoint already counts.
func (h *Handler) loadDeliverablesStageGates(ctx context.Context, workspaceID, projectID, issueID pgtype.UUID) (deliverablesGateSummary, error) {
	summary := deliverablesGateSummary{gates: make([]deliverablesStageGate, 4)}
	byStage := make(map[int32]*deliverablesStageGate, 4)
	for i := int32(0); i < 4; i++ {
		summary.gates[i] = deliverablesStageGate{
			Stage:           i + 1,
			GateClosed:      true,
			MissingDocTypes: []string{},
		}
		byStage[i+1] = &summary.gates[i]
	}

	rows, err := h.DB.Query(ctx, `
		SELECT r.stage::int, r.required_doc_type, r.blocking,
		       EXISTS (
		           SELECT 1 FROM project_artifact a
		           WHERE a.issue_id = $3
		             AND a.stage = r.stage
		             AND a.doc_type = r.required_doc_type
		             AND a.deleted_at IS NULL
		       ) AS ready
		FROM stage_gate_rule r
		WHERE r.workspace_id = $1
		  AND r.track IS NULL
		  AND ( r.project_id = $2
		        OR (r.project_id IS NULL AND NOT EXISTS (
		              SELECT 1 FROM stage_gate_rule p
		              WHERE p.workspace_id = r.workspace_id
		                AND p.project_id = $2
		                AND p.track IS NULL
		           )) )
		ORDER BY r.stage, r.sort_order`,
		workspaceID, projectID, issueID)
	if err != nil {
		return summary, err
	}
	for rows.Next() {
		var (
			stage    int32
			docType  string
			blocking bool
			ready    bool
		)
		if err := rows.Scan(&stage, &docType, &blocking, &ready); err != nil {
			rows.Close()
			return summary, err
		}
		gate := byStage[stage]
		if gate == nil {
			// stage CHECK (1..4) makes this unreachable; guard anyway.
			continue
		}
		gate.GateDefined = true
		summary.gateDefined = true
		if !blocking {
			// Non-blocking (aux) rules never open the gate nor count in the ring.
			continue
		}
		gate.RequiredTotal++
		summary.requiredTotal++
		if ready {
			gate.RequiredReady++
			summary.requiredReady++
		} else {
			gate.MissingDocTypes = append(gate.MissingDocTypes, docType)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return summary, err
	}
	for i := range summary.gates {
		summary.gates[i].GateClosed = len(summary.gates[i].MissingDocTypes) == 0
	}
	return summary, nil
}

// buildDeliverablesMissingItems reports the archive gaps the server can prove
// for stages the requirement has already entered (state != todo, or any stage
// once settled). Where a stage_gate_rule ruleset exists the coarse "shelf is
// empty" signal is upgraded into specific missing_doc_type rows (each carrying
// the required doc_type so the frontend can offer the two repair entry points);
// empty_stage survives only for an entered stage with no blocking gap to name —
// either no rule at all, or a rule set whose blocking items are all satisfied
// while the shelf is still bare.
func buildDeliverablesMissingItems(nodes []deliverablesStageNode, gates []deliverablesStageGate, settled bool) []deliverablesMissingItem {
	missing := []deliverablesMissingItem{}
	gateByStage := make(map[int32]deliverablesStageGate, len(gates))
	for _, g := range gates {
		gateByStage[g.Stage] = g
	}
	for _, n := range nodes {
		// A future stage with no archive yet is simply not started — never a gap.
		entered := settled || n.State != "todo"
		if !entered {
			continue
		}
		gate := gateByStage[n.Stage]
		emittedSpecific := false
		if gate.GateDefined {
			for _, docType := range gate.MissingDocTypes {
				dt := docType
				missing = append(missing, deliverablesMissingItem{
					Stage:           n.Stage,
					Kind:            "missing_doc_type",
					RequiredDocType: &dt,
				})
				emittedSpecific = true
			}
		}
		if !emittedSpecific && n.ArtifactCount == 0 {
			missing = append(missing, deliverablesMissingItem{Stage: n.Stage, Kind: "empty_stage"})
		}
	}
	return missing
}

// GetIssueDeliverablesOverview implements GET /api/issues/{id}/deliverables-overview:
// the f8 交付概览 payload — four status cards (derived status · scheduling /
// module mutex · role roster · archive completeness) plus the enhanced
// four-stage band, on top of the existing artifact scope/stage counts and the
// runs' todo rollup.
//
// issue_id / artifacts / todos keep their previous shape so nothing that
// already consumes this endpoint breaks; everything else is additive.
func (h *Handler) GetIssueDeliverablesOverview(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	ctx := r.Context()

	artifactsByScope := map[string]int64{}
	artifactsByStage := map[string]int64{}
	var artifactTotal int64
	rows, err := h.DB.Query(ctx, `
		SELECT scope, stage, COUNT(*)::bigint
		FROM project_artifact
		WHERE issue_id = $1 AND deleted_at IS NULL
		GROUP BY scope, stage`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}
	for rows.Next() {
		var scope string
		var stage pgtype.Int4
		var c int64
		if err := rows.Scan(&scope, &stage, &c); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan deliverables overview")
			return
		}
		artifactsByScope[scope] += c
		if stage.Valid {
			artifactsByStage[strconv.Itoa(int(stage.Int32))] += c
		} else {
			artifactsByStage["unassigned"] += c
		}
		artifactTotal += c
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}

	// Todo rollup across the issue's runs (todos belong to runs, runs to the
	// issue — direct or via root_issue_id).
	todosByStatus := map[string]int64{}
	var todoTotal int64
	rows, err = h.DB.Query(ctx, `
		SELECT t.status, COUNT(*)::bigint
		FROM agent_run_todo t
		JOIN agent_run ar ON ar.id = t.run_id
		WHERE ar.issue_id = $1 OR ar.root_issue_id = $1
		GROUP BY t.status`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}
	for rows.Next() {
		var status string
		var c int64
		if err := rows.Scan(&status, &c); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan deliverables overview")
			return
		}
		todosByStatus[status] += c
		todoTotal += c
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}

	// ── Card ① derived status + the stage band's counters ────────────────
	proj, err := h.loadDeliverablesProjection(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}

	// ── Card ② scheduling / module mutex (nil = not applicable) ─────────
	moduleLock, err := h.loadDeliverablesModuleLock(ctx, issue.ID, proj.module, proj.avoidConflict)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}

	// ── Card ③ role roster with resolved display names ──────────────────
	roles, err := h.loadDeliverablesRoles(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}

	// ── Stage band + Card ④ archive completeness + stage gates ──────────
	stageFlow := buildDeliverablesStageFlow(proj, artifactsByStage)
	settled := proj.derived.StatusKey == "completed" || proj.derived.StatusKey == "cancelled"

	// Stage-gate resolution (migration 460): the ruleset for this issue's
	// workspace/project LEFT-JOINed against its artifacts. project_id may be
	// NULL (issue with no project) — the query then falls back to the
	// workspace-level default rules.
	gateSummary, err := h.loadDeliverablesStageGates(ctx, issue.WorkspaceID, issue.ProjectID, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate deliverables overview")
		return
	}
	// 「S{n} 门未闭合 → 阻止进 S{n+1}」: only the requirement's current frontier
	// (the band's `cur` node) blocks the next stage, and only while unsettled.
	stateByStage := make(map[int32]string, len(stageFlow))
	for _, n := range stageFlow {
		stateByStage[n.Stage] = n.State
	}
	for i := range gateSummary.gates {
		g := &gateSummary.gates[i]
		g.BlockingNextStage = !settled && g.GateDefined && !g.GateClosed &&
			g.Stage < 4 && stateByStage[g.Stage] == "cur"
	}

	missingItems := buildDeliverablesMissingItems(stageFlow, gateSummary.gates, settled)
	stagesWithArtifacts := int64(0)
	for _, n := range stageFlow {
		if n.ArtifactCount > 0 {
			stagesWithArtifacts++
		}
	}

	issueRef := map[string]any{
		"id":     uuidToString(issue.ID),
		"title":  issue.Title,
		"status": issue.Status,
	}
	if proj.module != nil {
		issueRef["module"] = proj.module
	} else {
		issueRef["module"] = nil
	}
	issueRef["avoid_conflict"] = proj.avoidConflict

	// blocking_stage is the frontier stage whose open gate holds the requirement
	// back from the next stage (原型卡4：「S3 门未闭合 → 阻止进 S4」). 0 = none.
	blockingStage := int32(0)
	for _, g := range gateSummary.gates {
		if g.BlockingNextStage {
			blockingStage = g.Stage
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		// Legacy contract — unchanged.
		"issue_id":  uuidToString(issue.ID),
		"artifacts": map[string]any{"total": artifactTotal, "by_scope": artifactsByScope, "by_stage": artifactsByStage},
		"todos":     map[string]any{"total": todoTotal, "by_status": todosByStatus},
		// f8 additions.
		"issue":            issueRef,
		"derived_status":   proj.derived,
		"module_lock":      moduleLock,
		"role_assignments": roles,
		"stage_flow":       stageFlow,
		"missing_items":    missingItems,
		"stage_gates":      gateSummary.gates,
		"blocking_stage":   blockingStage,
		"completeness": map[string]any{
			"artifact_total":       artifactTotal,
			"stages_with_artifact": stagesWithArtifacts,
			"stages_total":         int64(len(stageFlow)),
			"missing_count":        int64(len(missingItems)),
			// Ring (anno②「环只算必备件」): blocking rules only. gate_defined=false
			// means no ruleset resolved, so the frontend falls back to the legacy
			// stages_with_artifact ring instead of dividing by zero.
			"gate_defined":   gateSummary.gateDefined,
			"required_total": gateSummary.requiredTotal,
			"required_ready": gateSummary.requiredReady,
		},
	})
}

// todoProgress is the {done,total} rollup embedded at both run and task level.
type todoProgress struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

// progressTodo is one agent_run_todo projected into the tree (layer 3 leaf).
// Only the render-relevant columns ride along — no id / audit fields.
type progressTodo struct {
	TodoKey string  `json:"todo_key"`
	Phase   *string `json:"phase"`
	Title   string  `json:"title"`
	Status  string  `json:"status"`
	Seq     int32   `json:"seq"`
	Source  string  `json:"source"`
}

// progressRun is one agent_run with its todos embedded (layer 3).
type progressRun struct {
	ID              string         `json:"id"`
	AgentID         string         `json:"agent_id"`
	Model           *string        `json:"model"`
	CliKind         string         `json:"cli_kind"`
	Status          string         `json:"status"`
	TokenUsed       int64          `json:"token_used"`
	StallReason     *string        `json:"stall_reason"`
	LastHeartbeatAt *string        `json:"last_heartbeat_at"`
	StartedAt       string         `json:"started_at"`
	FinishedAt      *string        `json:"finished_at"`
	Todos           []progressTodo `json:"todos"`
	TodosProgress   todoProgress   `json:"todos_progress"`
}

// progressTask is one agent_task_queue row with its runs nested (layer 2).
type progressTask struct {
	ID            string        `json:"id"`
	Title         string        `json:"title"`
	Status        string        `json:"status"`
	AgentID       string        `json:"agent_id"`
	CreatedAt     string        `json:"created_at"`
	Runs          []progressRun `json:"runs"`
	TodosProgress todoProgress  `json:"todos_progress"`
}

// GetIssueProgress implements GET /api/issues/{id}/progress: the three-layer
// tree the prototype asks for — requirement → tasks → runs → todos. Runs join
// onto their task via agent_run.task_queue_id; runs that rolled up from a child
// requirement (root_issue_id) but whose task lives on another issue fall into
// unmatched_runs. Per-run todos are embedded so the frontend renders the whole
// tree from one payload (no lazy per-run fetch). The weighted score / lineage
// chains / orphan detection from the design's RequirementProgressDTO remain
// TODOs pending rule definitions.
func (h *Handler) GetIssueProgress(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	ctx := r.Context()

	// ── Layer 2: tasks ──────────────────────────────────────────────────
	// agent_task_queue has no title column; trigger_summary (migration 061)
	// snapshots the originating comment/autopilot text, so it is the honest
	// display title. Fall back to a stable "Task <id8>" label when absent.
	type taskRow struct {
		id        pgtype.UUID
		agentID   pgtype.UUID
		status    string
		createdAt pgtype.Timestamptz
		title     string
	}
	taskRows := []taskRow{}
	rows, err := h.DB.Query(ctx, `
		SELECT id, agent_id, status, created_at,
		       LEFT(COALESCE(NULLIF(trigger_summary, ''), 'Task ' || LEFT(id::text, 8)), 140) AS title
		FROM agent_task_queue
		WHERE issue_id = $1
		ORDER BY created_at DESC
		LIMIT 100`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate issue progress")
		return
	}
	for rows.Next() {
		var tr taskRow
		if err := rows.Scan(&tr.id, &tr.agentID, &tr.status, &tr.createdAt, &tr.title); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan issue progress")
			return
		}
		taskRows = append(taskRows, tr)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate issue progress")
		return
	}

	// ── Layer 3a: runs (direct + rolled up via root_issue_id) ───────────
	runs, err := h.listAgentRunsForIssue(ctx, issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate issue progress")
		return
	}

	// ── Layer 3b: every todo of every run of this issue, grouped by run ─
	todosByRun := map[string][]progressTodo{}
	rows, err = h.DB.Query(ctx, `
		SELECT t.run_id, t.todo_key, t.phase, t.title, t.status, t.seq, t.source
		FROM agent_run_todo t
		JOIN agent_run ar ON ar.id = t.run_id
		WHERE ar.issue_id = $1 OR ar.root_issue_id = $1
		ORDER BY t.run_id, t.seq`,
		issue.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate issue progress")
		return
	}
	for rows.Next() {
		var runID pgtype.UUID
		var phase pgtype.Text
		var td progressTodo
		if err := rows.Scan(&runID, &td.TodoKey, &phase, &td.Title, &td.Status, &td.Seq, &td.Source); err != nil {
			rows.Close()
			writeError(w, http.StatusInternalServerError, "failed to scan issue progress")
			return
		}
		td.Phase = textToPtr(phase)
		key := uuidToString(runID)
		todosByRun[key] = append(todosByRun[key], td)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to aggregate issue progress")
		return
	}

	// Index the task views by id so runs can be distributed onto them.
	taskViews := make([]progressTask, 0, len(taskRows))
	taskIndex := map[string]int{}
	for _, tr := range taskRows {
		idStr := uuidToString(tr.id)
		taskIndex[idStr] = len(taskViews)
		taskViews = append(taskViews, progressTask{
			ID:        idStr,
			Title:     tr.title,
			Status:    tr.status,
			AgentID:   uuidToString(tr.agentID),
			CreatedAt: timestampToString(tr.createdAt),
			Runs:      []progressRun{},
		})
	}

	// buildRun folds a raw run row + its todos into the layer-3 view, reusing
	// agentRunToResponse so started_at/finished_at projection stays in one place.
	buildRun := func(row agentRunRow) progressRun {
		base := agentRunToResponse(row)
		todos := todosByRun[base.ID]
		if todos == nil {
			todos = []progressTodo{}
		}
		var p todoProgress
		for _, td := range todos {
			p.Total++
			if td.Status == "done" {
				p.Done++
			}
		}
		return progressRun{
			ID:              base.ID,
			AgentID:         base.AgentID,
			Model:           base.Model,
			CliKind:         base.CliKind,
			Status:          base.Status,
			TokenUsed:       base.TokenUsed,
			StallReason:     base.StallReason,
			LastHeartbeatAt: base.LastHeartbeatAt,
			StartedAt:       base.StartedAt,
			FinishedAt:      base.FinishedAt,
			Todos:           todos,
			TodosProgress:   p,
		}
	}

	unmatchedRuns := []progressRun{}
	stallDistribution := map[string]int64{}
	var todosDone, todosTotal, runsActive, runsStalled int64

	for _, row := range runs {
		run := buildRun(row)
		// Rollups span every run of the issue, matched or not.
		todosDone += run.TodosProgress.Done
		todosTotal += run.TodosProgress.Total
		switch run.Status {
		case "running":
			runsActive++
		case "stalled":
			runsStalled++
		}
		if row.StallReason.Valid && row.StallReason.String != "" {
			stallDistribution[row.StallReason.String]++
		}
		// Distribute onto the owning task; else it is an unlinked run.
		if row.TaskQueueID.Valid {
			if idx, ok := taskIndex[uuidToString(row.TaskQueueID)]; ok {
				taskViews[idx].Runs = append(taskViews[idx].Runs, run)
				taskViews[idx].TodosProgress.Done += run.TodosProgress.Done
				taskViews[idx].TodosProgress.Total += run.TodosProgress.Total
				continue
			}
		}
		unmatchedRuns = append(unmatchedRuns, run)
	}

	var tasksDone int64
	for i := range taskViews {
		if taskViews[i].Status == "completed" {
			tasksDone++
		}
	}

	// TODO(project-archive): weighted requirement score, todo lineage chains
	// (superseded_by), and orphan detection (task done but todos
	// in_progress → orphan) once the acceptance rules are defined.
	writeJSON(w, http.StatusOK, map[string]any{
		"issue": map[string]any{
			"id":     uuidToString(issue.ID),
			"title":  issue.Title,
			"status": issue.Status,
			"rollup": map[string]any{
				"tasks_done":   tasksDone,
				"tasks_total":  int64(len(taskViews)),
				"todos_done":   todosDone,
				"todos_total":  todosTotal,
				"runs_active":  runsActive,
				"runs_stalled": runsStalled,
			},
		},
		"tasks":              taskViews,
		"unmatched_runs":     unmatchedRuns,
		"stall_distribution": stallDistribution,
	})
}

// listAgentRunsForIssue loads the raw agent_run rows for an issue (direct or
// rolled up via root_issue_id), newest first.
func (h *Handler) listAgentRunsForIssue(ctx context.Context, issueID pgtype.UUID) ([]agentRunRow, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT `+agentRunColumns+`
		FROM agent_run
		WHERE issue_id = $1 OR root_issue_id = $1
		ORDER BY created_at DESC`,
		issueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	runs := []agentRunRow{}
	for rows.Next() {
		row, err := scanAgentRunRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		runs = append(runs, row)
	}
	return runs, rows.Err()
}
