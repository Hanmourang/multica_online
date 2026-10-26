// 工作流引擎服务（CoCo 对标 plan 20261024 §01 C4，Agent-W 主产物）。
//
// 复用铁律（README §3.8）：本服务只做「编排」——auto stage = 一次
// agent_task_queue 入队（EnqueueTaskForMention，stage prompt 以 comment 作为
// trigger 载体，天然进入 stage transcript）；门 = workflow_gate_run（语义对齐
// acceptance_round 的 round CAS 范式）；产物 = project_artifact（stage.outputs
// 存指针）。不新造执行引擎。
//
// 并发铁律：一切状态迁移走带期望值的 CAS（0 行 = 并发抢先 → ErrWorkflowConflict
// → handler 409），杜绝把终态抹回（对照 IncrementAcceptanceRoundIfExpected）。
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/featureflag"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ErrWorkflowConflict 映射 CAS 未命中（并发迁移抢先 / 非法迁移）→ HTTP 409。
var ErrWorkflowConflict = errors.New("workflow_state_conflict")

// WorkflowGateLoopLimit 对齐验收轮次上限（requirement_acceptance.go 的 round>3）：
// 同一门累计 loop 超过该值即转 instance failed + 人工仲裁 comment。
const WorkflowGateLoopLimit = 3

// WorkflowNode 是 workflow_template.nodes JSONB 的元素（§01 A1 注释的节点图 schema）。
type WorkflowNode struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Mode         string   `json:"mode"` // auto | human
	Stage        int      `json:"stage"`
	AgentRef     string   `json:"agent_ref,omitempty"`
	Prompt       string   `json:"prompt,omitempty"`
	Next         []string `json:"next"`
	GateDocTypes []string `json:"gate_doc_types"`
	Inputs       []any    `json:"inputs,omitempty"`
	Outputs      []any    `json:"outputs,omitempty"`
	// Spec 是阶段执行期元数据快照（goal/criteria/inputTpl/outputTpl，plan 20261025 §B1），
	// 由 Flatten 从 authoring 层编译而来，实例创建时落 workflow_stage_run.spec。
	// 旧模板为 nil → nodes JSON 逐字不变（omitempty）。
	Spec *StageSpec `json:"spec,omitempty"`
}

// ParseWorkflowNodes 反序列化节点图；非法 JSON 直接报错（handler 转 400）。
func ParseWorkflowNodes(raw []byte) ([]WorkflowNode, error) {
	var nodes []WorkflowNode
	if err := json.Unmarshal(raw, &nodes); err != nil {
		return nil, fmt.Errorf("invalid nodes json: %w", err)
	}
	return nodes, nil
}

// ValidateWorkflowNodes 是模板写入的结构闸门：
//   - 节点数 1..50；id 非空且唯一；mode ∈ auto|human；
//   - next 引用必须存在（悬空 next 拒绝）；
//   - 图无环（三色 DFS，语义与 scheduler.triggerOneRequirement 的依赖判环一致）。
func ValidateWorkflowNodes(raw []byte) error {
	nodes, err := ParseWorkflowNodes(raw)
	if err != nil {
		return err
	}
	if len(nodes) == 0 || len(nodes) > 50 {
		return fmt.Errorf("nodes count must be between 1 and 50")
	}
	seen := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		if n.ID == "" {
			return fmt.Errorf("node id must not be empty")
		}
		if seen[n.ID] {
			return fmt.Errorf("duplicate node id %q", n.ID)
		}
		seen[n.ID] = true
		if n.Mode != "auto" && n.Mode != "human" {
			return fmt.Errorf("node %q mode must be auto or human", n.ID)
		}
	}
	for _, n := range nodes {
		for _, next := range n.Next {
			if !seen[next] {
				return fmt.Errorf("node %q references unknown next %q", n.ID, next)
			}
		}
	}
	if !workflowNodesAcyclic(nodes) {
		return fmt.Errorf("nodes graph contains a cycle")
	}
	return nil
}

// workflowNodesAcyclic：白/灰/黑三色 DFS；灰色后继 = 后向边 = 有环。
func workflowNodesAcyclic(nodes []WorkflowNode) bool {
	adj := make(map[string][]string, len(nodes))
	for _, n := range nodes {
		adj[n.ID] = append(adj[n.ID], n.Next...)
	}
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(adj))
	var visit func(string) bool
	visit = func(id string) bool {
		color[id] = gray
		for _, next := range adj[id] {
			switch color[next] {
			case gray:
				return false
			case white:
				if !visit(next) {
					return false
				}
			}
		}
		color[id] = black
		return true
	}
	for id := range adj {
		if color[id] == white && !visit(id) {
			return false
		}
	}
	return true
}

// WorkflowService 封装实例状态机的全部编排动作；由 router.go 构造并挂到
// Handler.WorkflowService，sweep job 与 task 完成监听共享同一实例。
type WorkflowService struct {
	Queries     *db.Queries
	TxStarter   TxStarter
	TaskService *TaskService
	Bus         *events.Bus
	// FeatureFlags 只影响 sweep 空转开关；nil 视为未启用（sweep inert）。
	FeatureFlags *featureflag.Service
	// db 是资产准入/产物落地/blocked 复评所需的原生查询句柄（plan 20261025 §B3）。
	// project_asset_binding 走"新表用原生 SQL"约定不经 sqlc，故由 TxStarter（实际是
	// 连接池）类型断言取得；未满足断言（单测 fake）时为 nil，相关能力保守降级。
	db rawDB
}

func NewWorkflowService(q *db.Queries, tx TxStarter, taskSvc *TaskService, bus *events.Bus, flags *featureflag.Service) *WorkflowService {
	svc := &WorkflowService{Queries: q, TxStarter: tx, TaskService: taskSvc, Bus: bus, FeatureFlags: flags}
	if handle, ok := tx.(rawDB); ok {
		svc.db = handle
	}
	return svc
}

// ── 实例生命周期 ─────────────────────────────────────────────────────────────

// StartWorkflowInstance 幂等启动：waiting→running（MarkWorkflowStarted CAS），
// 随后派发第一个 pending stage。已被并发启动（CAS 0 行）视为成功 no-op。
func (s *WorkflowService) StartWorkflowInstance(ctx context.Context, instanceID pgtype.UUID) error {
	inst, err := s.Queries.MarkWorkflowStarted(ctx, instanceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // 已被其他通道（手动启动 / 另一 sweep）启动
		}
		return fmt.Errorf("mark workflow started: %w", err)
	}
	s.publishInstanceState(ctx, inst, "started")
	return s.dispatchNextPending(ctx, inst)
}

// TransitionInstance 通用 CAS 迁移（pause/resume/cancel/succeed 共用）。
func (s *WorkflowService) TransitionInstance(ctx context.Context, inst db.WorkflowInstance, to string) (db.WorkflowInstance, error) {
	updated, err := s.Queries.UpdateWorkflowInstanceState(ctx, db.UpdateWorkflowInstanceStateParams{
		ID:          inst.ID,
		WorkspaceID: inst.WorkspaceID,
		Status:      to,
		Status_2:    inst.Status,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowInstance{}, ErrWorkflowConflict
		}
		return db.WorkflowInstance{}, fmt.Errorf("transition instance to %s: %w", to, err)
	}
	s.publishInstanceState(ctx, updated, "transition_"+to)
	return updated, nil
}

// CancelInstance 取消：实例 CAS→cancelled + 撤销全部 waiting 门（best-effort，
// 门行残留也只会被后续 sweep/裁决 CAS 挡下）。
func (s *WorkflowService) CancelInstance(ctx context.Context, inst db.WorkflowInstance) (db.WorkflowInstance, error) {
	updated, err := s.TransitionInstance(ctx, inst, "cancelled")
	if err != nil {
		return db.WorkflowInstance{}, err
	}
	s.cancelWaitingGates(ctx, inst.ID)
	return updated, nil
}

// SucceedInstance 人工置成：running/paused→done + 撤销 waiting 门 + 未跑 stage 标 skipped。
func (s *WorkflowService) SucceedInstance(ctx context.Context, inst db.WorkflowInstance) (db.WorkflowInstance, error) {
	updated, err := s.TransitionInstance(ctx, inst, "done")
	if err != nil {
		return db.WorkflowInstance{}, err
	}
	s.cancelWaitingGates(ctx, inst.ID)
	stages, err := s.Queries.ListWorkflowStageRuns(ctx, inst.ID)
	if err == nil {
		for _, st := range stages {
			if st.State == "pending" || st.State == "running" || st.State == "waiting_gate" {
				if CASerr := s.casStage(ctx, st.ID, st.State, "skipped", pgtype.UUID{}, nil); CASerr != nil {
					slog.Warn("workflow succeed: skip stage failed", "stage_id", util.UUIDToString(st.ID), "error", CASerr)
				}
			}
		}
	}
	return updated, nil
}

// RecoverInstance 失败恢复：failed→running（CAS），失败 stage 重置 pending，
// 重新派发第一个 pending。诊断由 handler 组装（复用 agent_run stalled 探测口径的
// 简化版：failed stage + 其 task 终态即建议动作）。
func (s *WorkflowService) RecoverInstance(ctx context.Context, inst db.WorkflowInstance) (db.WorkflowInstance, error) {
	updated, err := s.TransitionInstance(ctx, inst, "running")
	if err != nil {
		return db.WorkflowInstance{}, err
	}
	stages, err := s.Queries.ListWorkflowStageRuns(ctx, inst.ID)
	if err != nil {
		return updated, fmt.Errorf("list stages after recover: %w", err)
	}
	for _, st := range stages {
		if st.State == "failed" {
			if casErr := s.casStage(ctx, st.ID, "failed", "pending", pgtype.UUID{}, nil); casErr != nil {
				slog.Warn("workflow recover: reset failed stage failed", "stage_id", util.UUIDToString(st.ID), "error", casErr)
			}
		}
	}
	return updated, s.dispatchNextPending(ctx, updated)
}

// ── stage 派发与推进 ─────────────────────────────────────────────────────────

// casStage 是 workflow_stage_run 的唯一写口：带期望态 CAS；outputs/taskID 可选覆盖。
func (s *WorkflowService) casStage(ctx context.Context, stageID pgtype.UUID, expected, next string, taskID pgtype.UUID, outputs []byte) error {
	_, err := s.Queries.UpdateWorkflowStageRunState(ctx, db.UpdateWorkflowStageRunStateParams{
		ID: stageID,
		// 注意参数映射：SQL 里 WHERE state=$2 在 SET state=$3 之前，故
		// State = 期望态（WHERE），State_2 = 新态（SET）——与 instance 版
		// （Status=新态, Status_2=期望态）恰好相反，改 SQL 时两头都要对。
		State:   expected,
		State_2: next,
		TaskID:  taskID,
		Outputs: outputs,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWorkflowConflict
		}
		return fmt.Errorf("stage CAS %s->%s: %w", expected, next, err)
	}
	return nil
}

// dispatchStage 派发单个 pending stage：
//   - human：建 waiting 门（instance 保持 running 等人）+ stage→waiting_gate；
//   - auto：root issue 上落一条 stage prompt comment → EnqueueTaskForMention
//     （执行 = 一次 agent_task_queue 入队）+ stage→running（带 task_id）。
//
// auto stage 缺 agent / 缺 root issue / 入队失败 → stage failed + instance failed
// （fail-fast：无人可跑的任务留在队列只会被 daemon 拒绝，暴露比吞掉好）。
func (s *WorkflowService) dispatchStage(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) error {
	if stage.Mode == "human" {
		if _, err := s.Queries.CreateWorkflowGateRun(ctx, db.CreateWorkflowGateRunParams{
			InstanceID:  inst.ID,
			StageRunID:  stage.ID,
			WorkspaceID: inst.WorkspaceID,
			Round:       1,
			Mode:        "human",
			State:       "waiting",
			Generation:  1,
			ParentID:    pgtype.UUID{},
		}); err != nil {
			return fmt.Errorf("create waiting gate for stage %s: %w", util.UUIDToString(stage.ID), err)
		}
		if err := s.casStage(ctx, stage.ID, stage.State, "waiting_gate", pgtype.UUID{}, nil); err != nil && !errors.Is(err, ErrWorkflowConflict) {
			return err
		}
		return nil
	}

	// 资产准入门禁（plan 101 C5/C7）：flag 开启时，本阶段声明的必检输入若尚未被上游
	// 产出，则不入队、把阶段置 blocked，等上游产出后由 dispatchNextPending 复评解除。
	if s.assetGateEnabled(ctx) {
		missing, merr := s.stageAdmissionMissing(ctx, inst, stage)
		if merr != nil {
			return fmt.Errorf("asset admission check: %w", merr)
		}
		if len(missing) > 0 {
			if casErr := s.casStage(ctx, stage.ID, stage.State, "blocked", pgtype.UUID{}, nil); casErr != nil && !errors.Is(casErr, ErrWorkflowConflict) {
				return casErr
			}
			slog.Info("workflow dispatch: stage blocked by asset admission",
				"stage_id", util.UUIDToString(stage.ID), "missing", missing)
			s.publishInstanceState(ctx, inst, "stage_blocked")
			return nil
		}
	}

	fail := func(reason string, cause error) error {
		if casErr := s.casStage(ctx, stage.ID, stage.State, "failed", pgtype.UUID{}, nil); casErr != nil && !errors.Is(casErr, ErrWorkflowConflict) {
			slog.Error("workflow dispatch: mark stage failed error", "stage_id", util.UUIDToString(stage.ID), "error", casErr)
		}
		if inst.Status == "running" {
			if _, casErr := s.Queries.UpdateWorkflowInstanceState(ctx, db.UpdateWorkflowInstanceStateParams{
				ID: inst.ID, WorkspaceID: inst.WorkspaceID, Status: "failed", Status_2: "running",
			}); casErr == nil {
				s.publishInstanceState(ctx, inst, "stage_failed:"+reason)
			}
		}
		if cause != nil {
			return fmt.Errorf("%s: %w", reason, cause)
		}
		return errors.New(reason)
	}

	if !stage.AgentID.Valid {
		return fail("auto_stage_without_agent", nil)
	}
	if !inst.RootIssueID.Valid {
		return fail("auto_stage_without_root_issue", nil)
	}
	issue, err := s.Queries.GetIssue(ctx, inst.RootIssueID)
	if err != nil {
		return fail("load_root_issue_failed", err)
	}
	prompt := stage.Prompt.String
	if prompt == "" {
		prompt = defaultStagePrompt(stage.Name, util.UUIDToString(inst.ID))
	}
	// plan 20261025 §B2：workflow_stage_spec 开启且快照带 spec 时，把阶段目标/达成判定/
	// 输入输出模板渲染进正文；关闭或 spec 为空时 prompt 逐字不变（零回归）。
	if s.stageSpecEnabled(ctx) {
		if spec := parseStageSpec(stage.Spec); spec != nil {
			merged, warnings := composeSpecPrompt(prompt, spec, stageRenderContext(inst, issue, stage))
			prompt = merged
			if len(warnings) > 0 {
				slog.Warn("workflow dispatch: unresolved stage spec placeholders",
					"stage_id", util.UUIDToString(stage.ID), "unknown", warnings)
			}
		}
	}
	// plan 101 P3：workflow_pull_context flag 开启时把大块正文换成按需拉取指针；
	// 关闭时逐字返回上面的 prompt（零回归）。
	prompt = s.pullContextPrompt(ctx, prompt, issue, inst, stage)
	commentID := dbid.NewV7()
	if _, err := s.Queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          commentID,
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		AuthorType:  inst.StartedByType,
		AuthorID:    inst.StartedByID,
		Content:     prompt,
		Type:        "comment",
		ParentID:    pgtype.UUID{Valid: false},
	}); err != nil {
		return fail("create_stage_prompt_comment_failed", err)
	}
	task, err := s.TaskService.EnqueueTaskForMention(ctx, issue, stage.AgentID, commentID)
	if err != nil {
		return fail("enqueue_stage_task_failed", err)
	}
	if err := s.casStage(ctx, stage.ID, stage.State, "running", task.ID, nil); err != nil && !errors.Is(err, ErrWorkflowConflict) {
		return fail("stage_running_cas_failed", err)
	}
	return nil
}

// dispatchNextPending 派发 seq 最小的 pending stage（无则检查是否可收尾）。
func (s *WorkflowService) dispatchNextPending(ctx context.Context, inst db.WorkflowInstance) error {
	stages, err := s.Queries.ListWorkflowStageRuns(ctx, inst.ID)
	if err != nil {
		return fmt.Errorf("list stages: %w", err)
	}
	for _, st := range stages {
		if st.State == "blocked" {
			// 准入门禁复评：上游已产出则解除 blocked→pending 并派发；仍缺件则停止向后推进
			// （线性引擎不得越过被阻塞的上游阶段）。
			if s.assetGateEnabled(ctx) && s.canUnblockStage(ctx, inst, st) {
				if err := s.casStage(ctx, st.ID, "blocked", "pending", pgtype.UUID{}, nil); err == nil {
					st.State = "pending"
					return s.dispatchStage(ctx, inst, st)
				}
			}
			return nil
		}
		if st.State == "pending" {
			return s.dispatchStage(ctx, inst, st)
		}
	}
	return s.finishInstanceIfIdle(ctx, inst, stages)
}

// finishInstanceIfIdle：没有 pending/running/waiting_gate 的 stage 即收尾 done。
func (s *WorkflowService) finishInstanceIfIdle(ctx context.Context, inst db.WorkflowInstance, stages []db.WorkflowStageRun) error {
	for _, st := range stages {
		switch st.State {
		case "pending", "running", "waiting_gate", "blocked":
			return nil // 仍在途（含被准入门禁阻塞的阶段，不得据此收尾 done）
		}
	}
	updated, err := s.Queries.UpdateWorkflowInstanceState(ctx, db.UpdateWorkflowInstanceStateParams{
		ID: inst.ID, WorkspaceID: inst.WorkspaceID, Status: "done", Status_2: "running",
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // 并发已收尾（done/cancelled），不覆盖
		}
		return fmt.Errorf("finish instance done: %w", err)
	}
	s.publishInstanceState(ctx, updated, "all_stages_done")
	return nil
}

// OnTaskDone 是 daemon 任务终态 → stage 的桥（经 events.Bus 订阅）。
// ok=true：stage running→done 后继续推进；ok=false：stage+instance 转 failed。
func (s *WorkflowService) OnTaskDone(ctx context.Context, taskID pgtype.UUID, ok bool) error {
	stage, err := s.Queries.GetWorkflowStageRunByTask(ctx, taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // 非工作流任务（绝大多数 task）——静默返回
		}
		return fmt.Errorf("find stage by task: %w", err)
	}
	if stage.State != "running" {
		return nil // 已被 rerun/interrupt/并发路径先行迁移，本次终态过期
	}
	inst, err := s.Queries.GetWorkflowInstance(ctx, db.GetWorkflowInstanceParams{
		ID: stage.InstanceID, WorkspaceID: stage.WorkspaceID,
	})
	if err != nil {
		return fmt.Errorf("load instance for stage %s: %w", util.UUIDToString(stage.ID), err)
	}
	if !ok {
		if casErr := s.casStage(ctx, stage.ID, "running", "failed", pgtype.UUID{}, nil); casErr != nil && !errors.Is(casErr, ErrWorkflowConflict) {
			return casErr
		}
		if inst.Status == "running" {
			updated, uerr := s.Queries.UpdateWorkflowInstanceState(ctx, db.UpdateWorkflowInstanceStateParams{
				ID: inst.ID, WorkspaceID: inst.WorkspaceID, Status: "failed", Status_2: "running",
			})
			if uerr == nil {
				s.publishInstanceState(ctx, updated, "task_failed")
			}
		}
		return nil
	}
	if casErr := s.casStage(ctx, stage.ID, "running", "done", pgtype.UUID{}, nil); casErr != nil {
		if errors.Is(casErr, ErrWorkflowConflict) {
			return nil
		}
		return casErr
	}
	// plan 20261025 §B3b：auto 阶段完成即把声明产物落地成项目资产绑定（幂等、best-effort），
	// 下游阶段的「外部资产型」判定与产物追踪面板都依赖这一步。
	s.landStageOutputs(ctx, inst, stage)
	return s.dispatchNextPending(ctx, inst)
}

// SkipStage 人工跳过阶段：pending/running/waiting_gate/blocked→skipped。
// 副作用 best-effort：running 先 cancel 底层 task，waiting_gate 先撤销 waiting 门；
// 实例 running 时继续推进下一个 pending stage。
// blocked 可跳（plan 20261025 §A1.3）：缺件阶段得有人工“不依此产物继续”的出口，
// 否则只能无限等补齐。
func (s *WorkflowService) SkipStage(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) error {
	switch stage.State {
	case "pending", "running", "waiting_gate", "blocked":
	default:
		return ErrWorkflowConflict
	}
	if stage.State == "running" && stage.TaskID.Valid && s.TaskService != nil {
		if _, err := s.TaskService.CancelTask(ctx, stage.TaskID); err != nil {
			slog.Warn("workflow skip: cancel stage task failed", "task_id", util.UUIDToString(stage.TaskID), "error", err)
		}
	}
	if g, err := s.Queries.GetWaitingGateByStageRun(ctx, stage.ID); err == nil {
		if _, cerr := s.Queries.CancelWorkflowGateRun(ctx, g.ID); cerr != nil && !errors.Is(cerr, pgx.ErrNoRows) {
			slog.Warn("workflow skip: cancel waiting gate failed", "gate_id", util.UUIDToString(g.ID), "error", cerr)
		}
	}
	if err := s.casStage(ctx, stage.ID, stage.State, "skipped", pgtype.UUID{}, nil); err != nil {
		return err
	}
	if inst.Status == "running" {
		return s.dispatchNextPending(ctx, inst)
	}
	return nil
}

// RerunStage 重跑已结束的阶段：done/failed/skipped→pending 后立即重派。
// 实例必须在 running（paused/终态下重跑会绕过状态机约束 → ErrWorkflowConflict）。
func (s *WorkflowService) RerunStage(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) error {
	if inst.Status != "running" {
		return ErrWorkflowConflict
	}
	switch stage.State {
	case "done", "failed", "skipped":
	default:
		return ErrWorkflowConflict
	}
	if err := s.casStage(ctx, stage.ID, stage.State, "pending", pgtype.UUID{}, nil); err != nil {
		return err
	}
	stage.State = "pending"
	return s.dispatchStage(ctx, inst, stage)
}

// ── gate 决策（loop / exit 核心） ────────────────────────────────────────────

// DecideGate 裁决 waiting 门：
//   - exit：门 decided + 其 stage waiting_gate→done + 推进下一 pending（全部完成则 done）；
//   - loop：IncrGateRoundLoopBack 开 round+1 新门（旧门 superseded），回退最近一个
//     done/failed/skipped 的前序 stage 重派；round>WorkflowGateLoopLimit 转 instance
//     failed + 人工仲裁 comment（逐字对照 postAcceptanceFailedComment）。
//
// 返回新门与决策后的实例快照（可能未变）。CAS 未命中 → ErrWorkflowConflict → 409。
func (s *WorkflowService) DecideGate(ctx context.Context, gateID, workspaceID pgtype.UUID, decision, actorType string, actorID pgtype.UUID) (db.WorkflowGateRun, db.WorkflowInstance, error) {
	gate, err := s.Queries.GetWorkflowGateRun(ctx, db.GetWorkflowGateRunParams{ID: gateID, WorkspaceID: workspaceID})
	if err != nil {
		return gate, db.WorkflowInstance{}, err
	}
	if decision != "loop" && decision != "exit" {
		return gate, db.WorkflowInstance{}, fmt.Errorf("decision must be loop or exit")
	}
	decided, err := s.Queries.DecideWorkflowGate(ctx, db.DecideWorkflowGateParams{
		ID: gateID, Decision: decision, DecidedByType: pgtype.Text{String: actorType, Valid: true}, DecidedByID: actorID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gate, db.WorkflowInstance{}, ErrWorkflowConflict
		}
		return gate, db.WorkflowInstance{}, fmt.Errorf("decide gate: %w", err)
	}
	inst, ierr := s.Queries.GetWorkflowInstance(ctx, db.GetWorkflowInstanceParams{
		ID: gate.InstanceID, WorkspaceID: workspaceID,
	})
	if ierr != nil {
		return decided, db.WorkflowInstance{}, fmt.Errorf("load instance after decide: %w", ierr)
	}
	s.publishGateDecided(ctx, decided, inst)

	if decision == "exit" {
		if stage, serr := s.Queries.GetWorkflowStageRun(ctx, db.GetWorkflowStageRunParams{
			ID: decided.StageRunID, WorkspaceID: workspaceID,
		}); serr == nil && stage.State == "waiting_gate" {
			casErr := s.casStage(ctx, stage.ID, "waiting_gate", "done", pgtype.UUID{}, nil)
			if casErr != nil && !errors.Is(casErr, ErrWorkflowConflict) {
				return decided, inst, casErr
			}
			if casErr == nil {
				// 人工阶段放行即完成：其声明产物同样落地（plan 20261025 §B3b）
				s.landStageOutputs(ctx, inst, stage)
			}
		}
		if inst.Status == "running" {
			return decided, inst, s.dispatchNextPending(ctx, inst)
		}
		return decided, inst, nil
	}

	// loop：round+1 新门（旧门由 DecideWorkflowGate 标 decided = superseded，generation 递增）
	newGate, err := s.Queries.IncrGateRoundLoopBack(ctx, decided.ID)
	if err != nil {
		return decided, inst, fmt.Errorf("loop back gate round: %w", err)
	}
	if newGate.Round > WorkflowGateLoopLimit {
		if _, cerr := s.Queries.CancelWorkflowGateRun(ctx, newGate.ID); cerr != nil {
			slog.Warn("workflow loop: cancel over-limit gate failed", "gate_id", util.UUIDToString(newGate.ID), "error", cerr)
		}
		updated, uerr := s.Queries.UpdateWorkflowInstanceState(ctx, db.UpdateWorkflowInstanceStateParams{
			ID: inst.ID, WorkspaceID: workspaceID, Status: "failed", Status_2: inst.Status,
		})
		if uerr == nil {
			inst = updated
			s.publishInstanceState(ctx, updated, "gate_loop_exceeded")
		}
		s.postGateLoopFailedComment(ctx, inst, newGate.Round)
		return newGate, inst, nil
	}
	s.publishGateDecided(ctx, newGate, inst)

	// 回退到最近一个已结束的前序 stage 重派（auto 重新入队；human 重开 waiting 门）。
	stages, err := s.Queries.ListWorkflowStageRuns(ctx, inst.ID)
	if err != nil {
		return newGate, inst, fmt.Errorf("list stages for loop back: %w", err)
	}
	currentSeq := int32(0)
	for _, st := range stages {
		if st.ID == decided.StageRunID {
			currentSeq = st.Seq
		}
	}
	for i := len(stages) - 1; i >= 0; i-- {
		st := stages[i]
		if st.Seq >= currentSeq {
			continue
		}
		if st.State == "done" || st.State == "failed" || st.State == "skipped" {
			if casErr := s.casStage(ctx, st.ID, st.State, "pending", pgtype.UUID{}, nil); casErr != nil && !errors.Is(casErr, ErrWorkflowConflict) {
				return newGate, inst, casErr
			}
			st.State = "pending"
			return newGate, inst, s.dispatchStage(ctx, inst, st)
		}
	}
	return newGate, inst, nil
}

// postGateLoopFailedComment：门越界的仲裁信号，复用 comment 表（不新建表）。
func (s *WorkflowService) postGateLoopFailedComment(ctx context.Context, inst db.WorkflowInstance, round int32) {
	if !inst.RootIssueID.Valid {
		return
	}
	if _, err := s.Queries.CreateComment(ctx, db.CreateCommentParams{
		ID:          dbid.NewV7(),
		IssueID:     inst.RootIssueID,
		WorkspaceID: inst.WorkspaceID,
		AuthorType:  "system",
		AuthorID:    pgtype.UUID{Valid: true},
		Content: fmt.Sprintf("工作流实例 %s 门回退累计 %d 轮，超过 %d 轮上限——需人工仲裁。",
			util.UUIDToString(inst.ID), round, WorkflowGateLoopLimit),
		Type:     "system",
		ParentID: pgtype.UUID{Valid: false},
	}); err != nil {
		slog.Warn("workflow loop exceeded: post arbitration comment failed",
			"instance_id", util.UUIDToString(inst.ID), "error", err)
	}
}

// cancelWaitingGates 撤掉实例上全部 waiting 门（cancel/succeed 收尾副作用）。
func (s *WorkflowService) cancelWaitingGates(ctx context.Context, instanceID pgtype.UUID) {
	gates, err := s.Queries.ListWorkflowGateRuns(ctx, instanceID)
	if err != nil {
		return
	}
	for _, g := range gates {
		if g.State == "waiting" {
			if _, err := s.Queries.CancelWorkflowGateRun(ctx, g.ID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				slog.Warn("workflow: cancel waiting gate failed", "gate_id", util.UUIDToString(g.ID), "error", err)
			}
		}
	}
}

// ── realtime 广播（铁律：前端只 patch React Query，不镜像 Zustand） ──────────

func (s *WorkflowService) publishInstanceState(ctx context.Context, inst db.WorkflowInstance, source string) {
	if s.Bus == nil {
		return
	}
	s.Bus.Publish(events.Event{
		Type:        protocol.EventWorkflowInstanceState,
		WorkspaceID: util.UUIDToString(inst.WorkspaceID),
		ActorType:   "system",
		Payload: map[string]any{
			"instance_id": util.UUIDToString(inst.ID),
			"status":      inst.Status,
			"source":      source,
		},
	})
}

func (s *WorkflowService) publishGateDecided(ctx context.Context, gate db.WorkflowGateRun, inst db.WorkflowInstance) {
	if s.Bus == nil {
		return
	}
	s.Bus.Publish(events.Event{
		Type:        protocol.EventWorkflowGateDecided,
		WorkspaceID: util.UUIDToString(gate.WorkspaceID),
		ActorType:   "system",
		Payload: map[string]any{
			"gate_id":      util.UUIDToString(gate.ID),
			"instance_id":  util.UUIDToString(gate.InstanceID),
			"stage_run_id": util.UUIDToString(gate.StageRunID),
			"decision":     gate.Decision,
			"round":        gate.Round,
			"generation":   gate.Generation,
			"status":       inst.Status,
		},
	})
}

// ── 30s sweep（供 scheduler.WorkflowTriggerJob 调用） ───────────────────────

// WorkflowSweepSummary 一轮 sweep 的审计汇总（形状对齐 scheduler.SweepSummary）。
type WorkflowSweepSummary struct {
	Scanned int
	Started int
	Errors  int
	// Reevaluated 是本轮复评过「含 blocked 阶段」的实例数（plan 20261025 §B3c）。
	Reevaluated int
}

func (s WorkflowSweepSummary) ResultMap() map[string]any {
	return map[string]any{
		"scanned":     s.Scanned,
		"started":     s.Started,
		"errors":      s.Errors,
		"reevaluated": s.Reevaluated,
	}
}

// SweepWaiting 扫全部 waiting 实例并逐个幂等启动。单实例失败不阻断本轮其余
// （下一 tick 重扫，MarkWorkflowStarted CAS 保证不重复派发）。
// workflow_module flag 关闭时直接空转返回（灰度回滚语义）。
func (s *WorkflowService) SweepWaiting(ctx context.Context) (WorkflowSweepSummary, error) {
	if !featureflags.WorkflowModuleEnabled(ctx, s.FeatureFlags) {
		return WorkflowSweepSummary{}, nil
	}
	instances, err := s.Queries.ListWaitingWorkflowInstances(ctx)
	if err != nil {
		return WorkflowSweepSummary{}, fmt.Errorf("list waiting instances: %w", err)
	}
	summary := WorkflowSweepSummary{Scanned: len(instances)}
	for _, inst := range instances {
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := s.StartWorkflowInstance(callCtx, inst.ID)
		cancel()
		if err != nil {
			summary.Errors++
			slog.Warn("workflow sweep: start instance failed",
				"instance_id", util.UUIDToString(inst.ID), "error", err)
			continue
		}
		summary.Started++
	}
	// plan 20261025 §B3c：blocked 阶段的复评兜底。资产绑定写路径可能漏触发（进程重启、
	// 并发失败、绑定时实例尚未 running 等），周期复查保证缺件补齐后必然解除、不永久卡死。
	// flag 关闭时 ReevaluateProjectBlocked 直接 no-op（零回归）。
	reevaluated, rerr := s.ReevaluateProjectBlocked(ctx, pgtype.UUID{})
	if rerr != nil {
		summary.Errors++
		slog.Warn("workflow sweep: blocked reevaluation failed", "error", rerr)
	}
	summary.Reevaluated = reevaluated
	return summary, nil
}

// SubscribeWorkflowTaskEvents 把 daemon 任务终态桥接进 stage 状态机。
// Bus.Publish 是同步内联调用（监听器跑在发布者 goroutine 上），所以这里只
// hand-off 到独立 goroutine 做 DB 编排，对照 SubscribePluginEvents 的约束。
func SubscribeWorkflowTaskEvents(bus *events.Bus, svc *WorkflowService) {
	if bus == nil || svc == nil {
		return
	}
	forward := func(ok bool) events.Handler {
		return func(e events.Event) {
			if e.TaskID == "" {
				return
			}
			taskID, err := util.ParseUUID(e.TaskID)
			if err != nil {
				return
			}
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := svc.OnTaskDone(ctx, taskID, ok); err != nil {
					slog.Warn("workflow: task terminal hook failed",
						"task_id", e.TaskID, "ok", ok, "error", err)
				}
			}()
		}
	}
	bus.Subscribe(protocol.EventTaskCompleted, forward(true))
	bus.Subscribe(protocol.EventTaskFailed, forward(false))
	bus.Subscribe(protocol.EventTaskCancelled, forward(false))
}
