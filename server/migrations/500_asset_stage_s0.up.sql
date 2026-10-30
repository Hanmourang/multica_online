-- 500: 资产阶段新增 S0 需求描述（需求 × 阶段矩阵 S0 列的唯一归属）。
-- S0 不在档案日历阶段 1..5 内：同步/回写时落 (stage NULL, doc_type 'requirement')，
-- 与 lifecyclePlacementMap / placement.ts 的 ASSET_S0_PLACEMENT 同值。
-- 仅放宽 CHECK，不改存量行（存量需求级档案仍按 doc_type + stage 自行归属）。
ALTER TABLE project_asset_binding
    DROP CONSTRAINT IF EXISTS project_asset_binding_lifecycle_stage_check;
ALTER TABLE project_asset_binding
    ADD CONSTRAINT project_asset_binding_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'general'));
