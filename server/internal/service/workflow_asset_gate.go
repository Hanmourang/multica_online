// 工作流阶段资产准入强制门禁（plan 101 C5/C7）+ 外部资产语义与复评闭环（plan 20261025 §B3）。
//
// 判定模型（与原型「资产联动」口径对齐）——某阶段的「执行前必检输入」= stage_run.inputs 里
// DefinitionInput{required:true, assetRole!="out"}，按来源分两类，各自有独立的满足证据：
//
//	a) 上游产物型（fromStageId 非空）：必须由**同一实例内 seq 更小且已 done 的上游阶段**
//	   的 outputs 声明产出同名产物（DefinitionOutput.name 或 id）；
//	b) 外部资产型（fromStageId 为空，原型 role=in，如「架构文档」「验收标准」）：上游永远
//	   产不出它，故满足证据 = 项目资产管理里存在同名 binding（项目级，或挂在实例 root issue
//	   上的工作项级）。改造前只认 (a)，外部必检项会把阶段永久卡死——这是本轮修正的核心。
//
// 未满足 → dispatchStage 不入队，阶段置 blocked；补齐后由三条路径复评解除（§B3c）：
// 资产绑定/解绑写路径触发、sweep 周期兜底、实例详情手动重试。
//
// 阶段 done 时其声明产物 upsert 成 project_asset_binding（source='workflow', asset_role=
// 'output'），既让「全流程产物追踪」有真实数据，也让下游的外部资产型判定能吃到上游落地。
//
// 全程受 workflow_asset_gate flag 门控：flag 关闭时不产生 blocked 态、不写 binding、
// 行为与既有实现逐字一致（零回归）。
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/featureflags"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// assetWorkflowSource 是阶段产物落地时写入 binding.source 的固定标识，
// 供产物追踪面板与「工作流来源」过滤使用。
const assetWorkflowSource = "workflow"

// rawDB 是本文件所需的最小原生查询面：*pgxpool.Pool 与 pgx.Tx 都满足。
// project_asset_binding 属"新表走原生 SQL"约定（不经 sqlc），故在此直查。
type rawDB interface {
	Exec(ctx context.Context, query string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, query string, args ...any) pgx.Row
	Query(ctx context.Context, query string, args ...any) (pgx.Rows, error)
}

// raw 返回共享连接句柄；未注入（老构造路径/单测）时返回 nil，调用方须判空并保守降级。
func (s *WorkflowService) raw() rawDB {
	if s == nil {
		return nil
	}
	return s.db
}

// assetGateEnabled 报告资产准入门禁是否开启。nil flags 视为关闭（零回归）。
func (s *WorkflowService) assetGateEnabled(ctx context.Context) bool {
	return featureflags.WorkflowAssetGateEnabled(ctx, s.FeatureFlags)
}

// requiredAssetNames 解析 stage_run.inputs，返回执行前必检资产名清单
// （required 且非 out）。空/非法 JSON 返回 nil，视为无准入要求。
// 供 pull 指针使用（只列名字，不做来源判定）。
func requiredAssetNames(rawInputs []byte) []string {
	out := []string{}
	for _, in := range requiredAssets(rawInputs) {
		name := in.OutputName
		if name == "" {
			name = in.OutputID
		}
		if name != "" {
			out = append(out, name)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// requiredAssets 返回必检输入项的**完整结构**（含 fromStageId），供按来源分流判定。
// 空/非法 JSON 返回 nil，视为无准入要求。
func requiredAssets(rawInputs []byte) []DefinitionInput {
	if len(rawInputs) == 0 {
		return nil
	}
	var inputs []DefinitionInput
	if err := json.Unmarshal(rawInputs, &inputs); err != nil {
		return nil
	}
	out := make([]DefinitionInput, 0, len(inputs))
	for _, in := range inputs {
		if !in.Required || in.AssetRole == "out" {
			continue
		}
		out = append(out, in)
	}
	return out
}

// assetNameOf 取必检项/产物的判定名：优先 outputName，退回 outputId/id/name。
func assetNameOf(name, fallback string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return fallback
}

// producedOutputNames 收集 seq 严格小于 beforeSeq 且已 done 的上游阶段产出的全部
// 产物名（DefinitionOutput.name 或 id）。用于判定下游必检项是否已被上游满足。
func producedOutputNames(stages []db.WorkflowStageRun, beforeSeq int32) map[string]bool {
	produced := make(map[string]bool)
	for _, st := range stages {
		if st.Seq >= beforeSeq || st.State != "done" || len(st.Outputs) == 0 {
			continue
		}
		for _, o := range declaredOutputs(st.Outputs) {
			if o.Name != "" {
				produced[o.Name] = true
			}
			if o.ID != "" {
				produced[o.ID] = true
			}
		}
	}
	return produced
}

// declaredOutputs 解析 stage_run.outputs（DefinitionOutput 列表）；空/非法返回 nil。
func declaredOutputs(raw []byte) []DefinitionOutput {
	if len(raw) == 0 {
		return nil
	}
	var outputs []DefinitionOutput
	if err := json.Unmarshal(raw, &outputs); err != nil {
		return nil
	}
	return outputs
}

// stageAdmissionMissing 返回该阶段尚未被满足的必检资产名（保序去重）。
// 无必检项时返回空切片。查询出错时上抛，由调用方决定保守策略。
func (s *WorkflowService) stageAdmissionMissing(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) ([]string, error) {
	required := requiredAssets(stage.Inputs)
	if len(required) == 0 {
		return nil, nil
	}
	stages, err := s.Queries.ListWorkflowStageRuns(ctx, inst.ID)
	if err != nil {
		return nil, err
	}
	produced := producedOutputNames(stages, stage.Seq)
	return admissionMissingWith(required, produced, func(name string) (bool, error) {
		return s.bindingSatisfiesAsset(ctx, inst.ProjectID, inst.RootIssueID, name)
	})
}

// admissionMissingWith 是准入判定的**纯核**（表驱动单测不触库）：
//   - inputs：阶段声明的输入项全集，本函数内部再按 required 且非 out 过滤——
//     必检语义只在这一处判定，调用方传全量 inputs 也是安全的；
//   - produced：同实例上游已 done 阶段的产物名集合；
//   - bindingSatisfied：外部资产型必检项是否已在资产管理绑定（nil 视为未绑定）。
//
// 上游型（fromStageId 非空）只认 produced，绝不回退到绑定判定——否则上游尚未产出时
// 会被无关同名资产误放行（§B3a 的语义分界）。
func admissionMissingWith(inputs []DefinitionInput, produced map[string]bool,
	bindingSatisfied func(name string) (bool, error)) ([]string, error) {
	missing := make([]string, 0, len(inputs))
	seen := map[string]bool{}
	for _, in := range inputs {
		if !in.Required || in.AssetRole == "out" {
			continue
		}
		name := assetNameOf(in.OutputName, in.OutputID)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		if produced[name] {
			continue
		}
		if in.FromStageID != "" {
			missing = append(missing, name)
			continue
		}
		if bindingSatisfied == nil {
			missing = append(missing, name)
			continue
		}
		ok, err := bindingSatisfied(name)
		if err != nil {
			return nil, err
		}
		if ok {
			continue
		}
		missing = append(missing, name)
	}
	return missing, nil
}

// bindingSatisfiesAsset 报告项目资产里是否已绑定该名字（任意 category / source）。
// 无原生句柄（未注入 pool）时保守返回 false——宁可维持 blocked 也不冒险放行。
func (s *WorkflowService) bindingSatisfiesAsset(ctx context.Context, projectID, issueID pgtype.UUID, name string) (bool, error) {
	handle := s.raw()
	if handle == nil || !projectID.Valid || name == "" {
		return false, nil
	}
	var exists bool
	err := handle.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM project_asset_binding
    WHERE asset_name = $2
      AND (
            (project_id = $1 AND issue_id IS NULL)
         OR ($3::uuid IS NOT NULL AND issue_id = $3)
      )
)`, projectID, name, issueID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check asset binding %q: %w", name, err)
	}
	return exists, nil
}

// canUnblockStage 报告一个 blocked 阶段此刻是否已满足准入。
// 查询出错保守返 false（维持 blocked，不冒险推进）。
func (s *WorkflowService) canUnblockStage(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) bool {
	missing, err := s.stageAdmissionMissing(ctx, inst, stage)
	return err == nil && len(missing) == 0
}

// StageAdmissionMissingForView 是实例详情视图的只读出口（plan 20261025 §A1.4）：
// 返回 blocked 阶段当前缺失的必检资产名，供 UI 显示「缺什么 + 去绑定」。
// 门禁关闭或无原生句柄时返回 nil（视图退化为"仅显示 blocked"，不报错）。
func (s *WorkflowService) StageAdmissionMissingForView(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) ([]string, error) {
	if !s.assetGateEnabled(ctx) || s.raw() == nil {
		return nil, nil
	}
	return s.stageAdmissionMissing(ctx, inst, stage)
}

// ── §B3b 产物落地 ──────────────────────────────────────────────────────────

// landStageOutputs 把阶段声明的产物 upsert 成 project_asset_binding
// （source='workflow'、asset_role='output'），让产物追踪与下游准入有真实数据。
//
// 幂等性：撞 471/473 的部分唯一索引时只更新 external_ref 指针 → 同一阶段重复
// done（rerun 后再次完成）不会累积重复行。best-effort：单条失败只记日志，
// 绝不阻断状态机推进（产物追踪是旁路，不是执行前置）。
func (s *WorkflowService) landStageOutputs(ctx context.Context, inst db.WorkflowInstance, stage db.WorkflowStageRun) {
	handle := s.raw()
	if handle == nil || !s.assetGateEnabled(ctx) || !inst.ProjectID.Valid {
		return
	}
	for _, o := range declaredOutputs(stage.Outputs) {
		name := assetNameOf(o.Name, o.ID)
		if name == "" {
			continue
		}
		ref, err := json.Marshal(map[string]any{
			"stage_run_id": util.UUIDToString(stage.ID),
			"instance_id":  util.UUIDToString(inst.ID),
			"node_id":      stage.NodeID,
			"output_id":    o.ID,
			"type":         o.Type,
			"description":  o.Description,
		})
		if err != nil {
			continue
		}
		query, args := artifactBindingSQL(inst, name, string(ref))
		if _, err := handle.Exec(ctx, query, args...); err != nil {
			slog.Warn("workflow artifact landing failed",
				"stage_run_id", util.UUIDToString(stage.ID), "asset", name, "error", err)
		}
	}
}

// artifactBindingSQL 按「工作项级 / 项目级」两种绑定形态选冲突目标：
// 两者的部分唯一索引不同（471 迁移），必须各自命中才能幂等 upsert。
func artifactBindingSQL(inst db.WorkflowInstance, name, ref string) (string, []any) {
	common := `INSERT INTO project_asset_binding
    (workspace_id, project_id, issue_id, asset_category, external_ref, asset_name,
     source, asset_role, created_by_type, created_by_id)
VALUES ($1, $2, $3, 'other', $4::jsonb, $5, 'workflow', 'output', $6, $7)`
	args := []any{inst.WorkspaceID, inst.ProjectID, inst.RootIssueID, ref, name,
		inst.StartedByType, inst.StartedByID}
	if inst.RootIssueID.Valid {
		return common + `
ON CONFLICT (issue_id, asset_category, asset_name, source) WHERE issue_id IS NOT NULL
DO UPDATE SET external_ref = EXCLUDED.external_ref`, args
	}
	return common + `
ON CONFLICT (project_id, asset_category, asset_name, source) WHERE issue_id IS NULL
DO UPDATE SET external_ref = EXCLUDED.external_ref`, args
}

// ── §B3c blocked 复评触发 ──────────────────────────────────────────────────

// ReevaluateProjectBlocked 复评项目下（projectID 为空则全库）所有「running 且存在 blocked
// 阶段」的实例，逐个走 dispatchNextPending 的 blocked→pending 解除分支。
//
// 返回处理的实例数。这是资产绑定写路径与 sweep 的共用兜底：改造前**完全没有**复评触发，
// 外部资产补齐后 blocked 阶段永远等不到复查。
func (s *WorkflowService) ReevaluateProjectBlocked(ctx context.Context, projectID pgtype.UUID) (int, error) {
	handle := s.raw()
	if handle == nil || !s.assetGateEnabled(ctx) {
		return 0, nil
	}
	rows, err := handle.Query(ctx, `
SELECT w.id, w.workspace_id FROM workflow_instance w
WHERE w.status = 'running'
  AND ($1::uuid IS NULL OR w.project_id = $1)
  AND EXISTS (
      SELECT 1 FROM workflow_stage_run s
      WHERE s.instance_id = w.id AND s.state = 'blocked'
  )
ORDER BY w.created_at ASC
LIMIT 50`, projectID)
	if err != nil {
		return 0, fmt.Errorf("list instances with blocked stages: %w", err)
	}
	type target struct {
		id          pgtype.UUID
		workspaceID pgtype.UUID
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.workspaceID); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan blocked instance: %w", err)
		}
		targets = append(targets, t)
	}
	rows.Close()

	reevaluated := 0
	for _, t := range targets {
		inst, err := s.Queries.GetWorkflowInstance(ctx, db.GetWorkflowInstanceParams{
			ID: t.id, WorkspaceID: t.workspaceID,
		})
		if err != nil {
			slog.Warn("workflow blocked reeval: load instance failed",
				"instance_id", util.UUIDToString(t.id), "error", err)
			continue
		}
		if err := s.dispatchNextPending(ctx, inst); err != nil {
			slog.Warn("workflow blocked reeval: dispatch failed",
				"instance_id", util.UUIDToString(t.id), "error", err)
			continue
		}
		reevaluated++
	}
	return reevaluated, nil
}

// ReevaluateInstance 复评单个实例的 blocked 阶段（实例详情「重新校验准入」入口）。
// 实例非 running 时 no-op——状态机约束优先于人工重试。
func (s *WorkflowService) ReevaluateInstance(ctx context.Context, inst db.WorkflowInstance) error {
	if !s.assetGateEnabled(ctx) {
		return nil
	}
	if inst.Status != "running" {
		return ErrWorkflowConflict
	}
	return s.dispatchNextPending(ctx, inst)
}
