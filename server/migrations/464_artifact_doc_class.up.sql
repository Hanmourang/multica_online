-- 规划文档别名（prd/mrd/brd/roadmap）。不参与路径契约，只供检索。
ALTER TABLE project_artifact
    ADD COLUMN doc_class TEXT;

CREATE INDEX idx_artifact_doc_class ON project_artifact(project_id, doc_class)
    WHERE deleted_at IS NULL AND doc_class IS NOT NULL;
