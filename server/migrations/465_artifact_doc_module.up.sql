-- 功能模块标签（人工覆盖）。缺省由文件直属目录推导，不参与路径契约。
ALTER TABLE project_artifact
    ADD COLUMN doc_module TEXT;

CREATE INDEX idx_artifact_doc_module ON project_artifact(project_id, doc_module)
    WHERE deleted_at IS NULL AND doc_module IS NOT NULL;
