-- spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.1

ALTER TABLE project_module DROP COLUMN IF EXISTS graph_node_id;
ALTER TABLE project DROP COLUMN IF EXISTS archive_resource_id;
DROP TABLE IF EXISTS project_artifact;
