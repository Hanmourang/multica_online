-- spec: docs/superpowers/specs/2026-09-05-project-archive-design.md §4.8（migration 460_stage_gate_rule）
-- DROP TABLE 级联删除其上的 uq_stage_gate_rule_scope / idx_stage_gate_project / idx_stage_gate_workspace。
DROP TABLE IF EXISTS stage_gate_rule;
