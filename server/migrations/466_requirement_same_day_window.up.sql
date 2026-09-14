-- 日历顶层需求：终止日对齐开始日，去掉历史跨天色块。
-- start_at 用 UTC 日历日；无 start_at 时对齐 start_date。子任务不改。
UPDATE issue
SET
    due_date = (start_at AT TIME ZONE 'UTC')::date,
    start_date = COALESCE(start_date, (start_at AT TIME ZONE 'UTC')::date)
WHERE parent_issue_id IS NULL
  AND start_at IS NOT NULL
  AND (
        due_date IS DISTINCT FROM (start_at AT TIME ZONE 'UTC')::date
        OR start_date IS DISTINCT FROM (start_at AT TIME ZONE 'UTC')::date
      );

UPDATE issue
SET due_date = start_date
WHERE parent_issue_id IS NULL
  AND start_at IS NULL
  AND start_date IS NOT NULL
  AND due_date IS DISTINCT FROM start_date;
