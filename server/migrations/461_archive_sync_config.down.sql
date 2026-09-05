-- 461_archive_sync_config 回滚：与 up 严格逆序。

ALTER TABLE project_artifact DROP COLUMN IF EXISTS override_reason;
ALTER TABLE project_artifact DROP COLUMN IF EXISTS confidence;

DROP TABLE IF EXISTS project_archive_sync_config;
DROP TABLE IF EXISTS sync_diagnostics;
