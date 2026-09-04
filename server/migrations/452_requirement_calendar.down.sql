DROP INDEX IF EXISTS idx_issue_repo_resource;
DROP INDEX IF EXISTS idx_issue_root_requirement;
DROP INDEX IF EXISTS idx_issue_trigger_sweep;

ALTER TABLE issue
    DROP COLUMN start_at,
    DROP COLUMN goal,
    DROP COLUMN repo_resource_id,
    DROP COLUMN decompose_mode,
    DROP COLUMN auto_trigger,
    DROP COLUMN decomposition_confirmed_at,
    DROP COLUMN triggered_at,
    DROP COLUMN acceptance_round,
    DROP COLUMN root_requirement_id,
    DROP COLUMN feature_points,
    DROP COLUMN graph_context,
    DROP COLUMN acceptance_spec;
