// 需求触发（spec: 2026-09-04-requirement-calendar-design.md §7.1 / §7.5①）：
// 到点（或手动）把需求的 stage 3 执行子任务推进 agent_task_queue。
//
// 幂等锚点是 MarkRequirementTriggered 的 execrows 守卫（triggered_at IS NULL
// 才写入）——sweep 并发与手动重试都由它挡下，影响 0 行即「已被触发」。
// 入队走 TaskService.EnqueueTaskForIssue 全量管道（attribution/去重/广播），
// 带 blocked_by 依赖的子任务同样入队 queued：领取侧的 451 依赖闸门
// （ClaimAgentTask 的 NOT EXISTS 判定）在前置全部 done 前挡住 claim，
// 前置完成后自然放行（§7.5⑤）。stage 4 验收子任务不在此派发，归验收执行
// （T19）管。
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ErrRequirementAlreadyTriggered 表示需求已触发（幂等重试/并发竞争）→ 409。
var ErrRequirementAlreadyTriggered = errors.New("requirement already triggered")

// ErrRequirementNotConfirmed 表示拆解确认门未通过，不能触发 → 409。
var ErrRequirementNotConfirmed = errors.New("requirement decomposition not confirmed")

// ErrRequirementNotTopLevel 表示目标不是顶层需求 → 400。
var ErrRequirementNotTopLevel = errors.New("not a top-level requirement")

// ErrRequirementNotDue 表示未到 start_at（仅 sweep 防御性复检用；手动触发忽略）。
var ErrRequirementNotDue = errors.New("requirement start_at not reached")

// TriggerRequirementResult 汇总一次触发的入队结果。
type TriggerRequirementResult struct {
	// EnqueuedChildren 是本次新入队的 stage-3 子任务数。
	EnqueuedChildren int
	// SkippedChildren 是未入队的 stage-3 子任务数（无 agent 执行人、
	// 已有 pending 任务、或入队失败——失败只记日志不阻断整批）。
	SkippedChildren int
}

// TriggerRequirement 触发单个需求：写 triggered_at 并把 stage 3 子任务入队。
// manual=true 忽略 start_at 到点判定（POST /issues/{id}/trigger）。
func (s *IssueService) TriggerRequirement(ctx context.Context, requirementID pgtype.UUID, manual bool) (*TriggerRequirementResult, error) {
	issue, err := s.Queries.GetIssue(ctx, requirementID)
	if err != nil {
		return nil, fmt.Errorf("load requirement: %w", err)
	}
	if issue.ParentIssueID.Valid {
		return nil, ErrRequirementNotTopLevel
	}
	if !issue.DecompositionConfirmedAt.Valid {
		return nil, ErrRequirementNotConfirmed
	}
	if !manual {
		// sweep 路径 SQL 已过滤到点行，这里复检防 TOCTOU 外的直调。
		if !issue.StartAt.Valid || issue.StartAt.Time.After(time.Now()) {
			return nil, ErrRequirementNotDue
		}
	}

	rows, err := s.Queries.MarkRequirementTriggered(ctx, requirementID)
	if err != nil {
		return nil, fmt.Errorf("mark requirement triggered: %w", err)
	}
	if rows == 0 {
		return nil, ErrRequirementAlreadyTriggered
	}

	children, err := s.Queries.ListRequirementChildren(ctx, requirementID)
	if err != nil {
		return nil, fmt.Errorf("list requirement children: %w", err)
	}
	res := &TriggerRequirementResult{}
	for _, child := range children {
		if !child.Stage.Valid || child.Stage.Int32 != 3 {
			continue
		}
		if child.AssigneeType.String != "agent" || !child.AssigneeID.Valid {
			// 成员/未指派的执行子任务不进 agent 队列（人自己领活）。
			res.SkippedChildren++
			continue
		}
		hasPending, perr := s.Queries.HasPendingTaskForIssueAndAgent(ctx, db.HasPendingTaskForIssueAndAgentParams{
			IssueID: child.ID,
			AgentID: child.AssigneeID,
			// 去重键与领取/重跑路径一致：按 review head 区分（TEN-356）。
			HeadSha: s.TaskService.ResolveIssueReviewSHAParam(ctx, child.ID),
		})
		if perr == nil && hasPending {
			res.SkippedChildren++
			continue
		}
		if _, err := s.TaskService.EnqueueTaskForIssue(ctx, child); err != nil {
			slog.Warn("requirement trigger: enqueue child failed",
				"requirement_id", util.UUIDToString(requirementID),
				"issue_id", util.UUIDToString(child.ID),
				"error", err)
			res.SkippedChildren++
			continue
		}
		res.EnqueuedChildren++
	}
	slog.Info("requirement triggered",
		"requirement_id", util.UUIDToString(requirementID),
		"manual", manual,
		"enqueued", res.EnqueuedChildren,
		"skipped", res.SkippedChildren,
	)
	return res, nil
}

// SweepRequirementTriggers 是 30s 触发 loop 的一轮：扫到点需求逐个触发。
// 返回本轮新触发的需求数。单个需求失败不阻断本轮其余需求。
func (s *IssueService) SweepRequirementTriggers(ctx context.Context) (int, error) {
	rows, err := s.Queries.ListTriggerableRequirements(ctx)
	if err != nil {
		return 0, fmt.Errorf("list triggerable requirements: %w", err)
	}
	triggered := 0
	for _, req := range rows {
		_, err := s.TriggerRequirement(ctx, req.ID, false)
		switch {
		case errors.Is(err, ErrRequirementAlreadyTriggered):
			// 并发触发竞争：另一实例先拿了 execrows 守卫，正常跳过。
			continue
		case err != nil:
			slog.Warn("requirement trigger sweep: trigger failed",
				"requirement_id", util.UUIDToString(req.ID), "error", err)
			continue
		}
		triggered++
	}
	return triggered, nil
}
