-- 回滚 470：先撤 issue 侧引用，再删表（顺序与 up 相反）。
DROP INDEX IF EXISTS idx_issue_sprint;
ALTER TABLE issue DROP COLUMN IF EXISTS sprint_id;
DROP TABLE IF EXISTS sprint;
