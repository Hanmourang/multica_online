// 原型版本（spec: 2026-09-04-requirement-calendar-design.md §5.3）：
// 每次生成登记一个新版本行（version=MAX+1），同事务把旧 pending 版本置
// superseded；已 confirmed 的版本是确认门的终点，重生成前必须先取消确认。
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ErrPrototypeAlreadyConfirmed 表示当前版本已被确认 → 409（需先取消确认）。
var ErrPrototypeAlreadyConfirmed = errors.New("prototype already confirmed")

// GeneratePrototypeVersionParams 是 GeneratePrototypeVersion 的入参。Prompt
// 由调用方（handler）用 AssemblePrototypePrompt 组装好传入；HtmlPath 为
// PrototypeOutputPath 计算的产出约定路径。
type GeneratePrototypeVersionParams struct {
	IssueID     pgtype.UUID
	WorkspaceID pgtype.UUID
	HtmlPath    string
	Prompt      string
	CreatorType string
	CreatorID   pgtype.UUID
}

// GeneratePrototypeVersion 在单事务内完成「旧 pending 版本置 superseded +
// 登记新版本（version=MAX+1, status=pending）」。已有 confirmed 版本时返回
// ErrPrototypeAlreadyConfirmed。并发兜底为 (issue_id, version) 唯一约束。
func (s *IssueService) GeneratePrototypeVersion(ctx context.Context, p GeneratePrototypeVersionParams) (db.IssuePrototypeVersion, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return db.IssuePrototypeVersion{}, err
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)

	latest, err := qtx.GetLatestPrototypeVersion(ctx, p.IssueID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return db.IssuePrototypeVersion{}, fmt.Errorf("load latest prototype version: %w", err)
	}
	if err == nil && latest.Status == "confirmed" {
		return db.IssuePrototypeVersion{}, ErrPrototypeAlreadyConfirmed
	}
	if err := qtx.SupersedePendingPrototypeVersions(ctx, p.IssueID); err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("supersede pending prototype versions: %w", err)
	}
	version, err := qtx.CreatePrototypeVersion(ctx, db.CreatePrototypeVersionParams{
		IssueID:       p.IssueID,
		WorkspaceID:   p.WorkspaceID,
		HtmlPath:      p.HtmlPath,
		Prompt:        p.Prompt,
		CreatedByType: p.CreatorType,
		CreatedByID:   p.CreatorID,
	})
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("create prototype version: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.IssuePrototypeVersion{}, err
	}
	return version, nil
}

// ErrPrototypeVersionNotFound 表示 {issue, version} 不存在 → 404。
var ErrPrototypeVersionNotFound = errors.New("prototype version not found")

// ErrPrototypeVersionNotPending 表示目标版本不是 pending（marks 只能写
// pending 版本，确认门也只能作用于 pending 版本）→ 409。
var ErrPrototypeVersionNotPending = errors.New("prototype version is not pending")

// PrototypeValidationError 是标记内容错误（→ 400）。
type PrototypeValidationError struct{ Msg string }

func (e *PrototypeValidationError) Error() string { return e.Msg }

// PrototypeConfirmGateError 是确认门拦截（→ 409）：当前 pending 版本仍存在
// verdict='no' 的标记项。✗ 必须随新版本消解（重生成后 marks 重置），note
// 备注不能替代重生成（spec 画面 4 标注 9）。
type PrototypeConfirmGateError struct{ DetailIDs []string }

func (e *PrototypeConfirmGateError) Error() string {
	return "unresolved no-marks on the pending version: " + strings.Join(e.DetailIDs, ", ")
}

// validatePrototypeMarks 校验标记集合：detail_id 必填，verdict ∈ ok/no/pending。
func validatePrototypeMarks(marks []PrototypeMark) error {
	for _, m := range marks {
		if strings.TrimSpace(m.DetailID) == "" {
			return &PrototypeValidationError{Msg: "mark detail_id required"}
		}
		switch m.Verdict {
		case "ok", "no", "pending":
		default:
			return &PrototypeValidationError{Msg: "invalid mark verdict: " + m.Verdict}
		}
	}
	return nil
}

// UpdatePrototypeMarks 整体替换某个 pending 版本的 marks（whole-document
// write；画面 4 的逐项标记在客户端合并后一次性提交）。
func (s *IssueService) UpdatePrototypeMarks(ctx context.Context, issueID pgtype.UUID, version int32, marks []PrototypeMark) (db.IssuePrototypeVersion, error) {
	if marks == nil {
		marks = []PrototypeMark{}
	}
	if err := validatePrototypeMarks(marks); err != nil {
		return db.IssuePrototypeVersion{}, err
	}
	v, err := s.Queries.GetPrototypeVersion(ctx, db.GetPrototypeVersionParams{IssueID: issueID, Version: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.IssuePrototypeVersion{}, ErrPrototypeVersionNotFound
	}
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("load prototype version: %w", err)
	}
	if v.Status != "pending" {
		return db.IssuePrototypeVersion{}, ErrPrototypeVersionNotPending
	}
	raw, err := json.Marshal(marks)
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("marshal marks: %w", err)
	}
	updated, err := s.Queries.UpdatePrototypeMarks(ctx, db.UpdatePrototypeMarksParams{
		Marks:   raw,
		IssueID: issueID,
		Version: version,
	})
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("update prototype marks: %w", err)
	}
	return updated, nil
}

// ConfirmPrototypeVersion 确认门（spec §5.3/§9）：目标版本必须是 pending 且
// marks 中不存在 verdict='no' 项，才置为 confirmed。stage-1 子任务的关闭与
// barrier 唤醒由调用方（handler）在确认成功后执行。
func (s *IssueService) ConfirmPrototypeVersion(ctx context.Context, issueID pgtype.UUID, version int32) (db.IssuePrototypeVersion, error) {
	v, err := s.Queries.GetPrototypeVersion(ctx, db.GetPrototypeVersionParams{IssueID: issueID, Version: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.IssuePrototypeVersion{}, ErrPrototypeVersionNotFound
	}
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("load prototype version: %w", err)
	}
	if v.Status != "pending" {
		return db.IssuePrototypeVersion{}, ErrPrototypeVersionNotPending
	}
	var marks []PrototypeMark
	if len(v.Marks) > 0 {
		if err := json.Unmarshal(v.Marks, &marks); err != nil {
			return db.IssuePrototypeVersion{}, fmt.Errorf("parse prototype marks: %w", err)
		}
	}
	var blocked []string
	for _, m := range marks {
		if m.Verdict == "no" {
			blocked = append(blocked, m.DetailID)
		}
	}
	if len(blocked) > 0 {
		return db.IssuePrototypeVersion{}, &PrototypeConfirmGateError{DetailIDs: blocked}
	}
	if err := s.Queries.SetPrototypeStatus(ctx, db.SetPrototypeStatusParams{
		Status:  "confirmed",
		IssueID: issueID,
		Version: version,
	}); err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("confirm prototype version: %w", err)
	}
	v.Status = "confirmed"
	return v, nil
}

// RegisterPrototypeVersion 人工登记：把已有 HTML 路径写成新版本，不派
// prototyper 任务。已有 confirmed 也不拦截——那是 AI 重生成的门，人工关联
// 只 supersede pending，历史 confirmed 行保留。
func (s *IssueService) RegisterPrototypeVersion(ctx context.Context, p GeneratePrototypeVersionParams) (db.IssuePrototypeVersion, error) {
	if strings.TrimSpace(p.HtmlPath) == "" {
		return db.IssuePrototypeVersion{}, &PrototypeValidationError{Msg: "html_path required"}
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return db.IssuePrototypeVersion{}, err
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	if err := qtx.SupersedePendingPrototypeVersions(ctx, p.IssueID); err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("supersede pending prototype versions: %w", err)
	}
	version, err := qtx.CreatePrototypeVersion(ctx, db.CreatePrototypeVersionParams{
		IssueID:       p.IssueID,
		WorkspaceID:   p.WorkspaceID,
		HtmlPath:      strings.TrimSpace(p.HtmlPath),
		Prompt:        p.Prompt,
		CreatedByType: p.CreatorType,
		CreatedByID:   p.CreatorID,
	})
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("create prototype version: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.IssuePrototypeVersion{}, err
	}
	return version, nil
}

// UpdatePrototypeHtmlPath 改某个版本指向的 HTML 文件，不改 version / status。
func (s *IssueService) UpdatePrototypeHtmlPath(ctx context.Context, issueID pgtype.UUID, version int32, htmlPath, prompt string) (db.IssuePrototypeVersion, error) {
	if strings.TrimSpace(htmlPath) == "" {
		return db.IssuePrototypeVersion{}, &PrototypeValidationError{Msg: "html_path required"}
	}
	_, err := s.Queries.GetPrototypeVersion(ctx, db.GetPrototypeVersionParams{IssueID: issueID, Version: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.IssuePrototypeVersion{}, ErrPrototypeVersionNotFound
	}
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("load prototype version: %w", err)
	}
	updated, err := s.Queries.UpdatePrototypeHtmlPath(ctx, db.UpdatePrototypeHtmlPathParams{
		HtmlPath: strings.TrimSpace(htmlPath),
		Prompt:   prompt,
		IssueID:  issueID,
		Version:  version,
	})
	if err != nil {
		return db.IssuePrototypeVersion{}, fmt.Errorf("update prototype html_path: %w", err)
	}
	return updated, nil
}
