// 原型版本（spec: 2026-09-04-requirement-calendar-design.md §5.3）：
// 每次生成登记一个新版本行（version=MAX+1），同事务把旧 pending 版本置
// superseded；已 confirmed 的版本是确认门的终点，重生成前必须先取消确认。
package service

import (
	"context"
	"errors"
	"fmt"

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
