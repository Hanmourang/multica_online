-- 477: 资产五阶段 ↔ 档案货架对齐（plan「资产阶段对齐与组件统一」§3）。
-- 顺序固定：先放宽两处 CHECK（lifecycle 加 S5、档案 stage 加 5）→ 旧四阶段
-- 原型语义交换（旧 S1=产品原型 → S2、旧 S2=项目规划 → S1）→ 按新语义回填
-- 两类关联档案 placement。必须先交换后回填：否则档案按旧 lifecycle 值回填后
-- 与交换后的 binding 分叉；S1↔S2 的 stage 数值不变，交换对档案无残留影响。
-- 需求日历四阶段门 stage_gate_rule 不在本迁移范围（plan §3.4 明确不动）。

-- ① 约束放宽：资产 lifecycle 加 S5。
ALTER TABLE project_asset_binding
    DROP CONSTRAINT IF EXISTS project_asset_binding_lifecycle_stage_check;
ALTER TABLE project_asset_binding
    ADD CONSTRAINT project_asset_binding_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('S1', 'S2', 'S3', 'S4', 'S5', 'general'));

-- ② 约束放宽：档案 stage 加 5。
ALTER TABLE project_artifact
    DROP CONSTRAINT IF EXISTS project_artifact_stage_check;
ALTER TABLE project_artifact
    ADD CONSTRAINT project_artifact_stage_check
    CHECK (stage IN (1, 2, 3, 4, 5));

-- ③ 存量旧语义交换：旧四阶段 S1=产品原型、S2=项目规划 → 新语义 S2/S1。
--    单语句双分支 CASE，同一语句内逐行原子完成，不会互相覆盖；
--    S3/S4/general/S5 不动。
UPDATE project_asset_binding
SET lifecycle_stage = CASE lifecycle_stage
        WHEN 'S1' THEN 'S2'
        WHEN 'S2' THEN 'S1'
        ELSE lifecycle_stage END
WHERE lifecycle_stage IN ('S1', 'S2');

-- ③.5 来源徽标恢复（plan §3.3.2）：历史档案 PATCH 会把资产原生行的 source
--     改写为 manual/server，持有 asset_binding_id 链的行一律恢复为 'asset'。
--     down 无法知改写前原值，属仅展示层不可逆（与 rel_path 同口径，见 down 注释）。
UPDATE project_artifact
SET    source = 'asset', updated_at = now()
WHERE  asset_binding_id IS NOT NULL
  AND  deleted_at IS NULL
  AND  source <> 'asset';

-- ④ 资产 → 档案回填：资产原生档案行（asset_binding_id 持链，source 兜底历史）。
UPDATE project_artifact a
SET    stage = CASE b.lifecycle_stage
           WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3
           WHEN 'S4' THEN 4 WHEN 'S5' THEN 5
       END,
       doc_type = CASE b.lifecycle_stage
           WHEN 'S1' THEN 'research'       WHEN 'S2' THEN 'product-design'
           WHEN 'S3' THEN 'architecture'   WHEN 'S4' THEN 'retrospective'
           WHEN 'S5' THEN 'iteration'
       END,
       rel_path = CASE
           WHEN a.rel_path LIKE 'overview/%' AND (
               a.stage IS DISTINCT FROM CASE b.lifecycle_stage
                   WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3
                   WHEN 'S4' THEN 4 WHEN 'S5' THEN 5 END)
           THEN 'overview/' || CASE b.lifecycle_stage
                   WHEN 'S1' THEN 'research'     WHEN 'S2' THEN 'product-design'
                   WHEN 'S3' THEN 'architecture' WHEN 'S4' THEN 'retrospective'
                   WHEN 'S5' THEN 'iteration'
               END || '/' || regexp_replace(a.rel_path, '^overview/[^/]+/', '')
           ELSE a.rel_path END,
       updated_at = now()
FROM project_asset_binding b
WHERE (a.asset_binding_id = b.id OR a.source = 'asset' AND a.asset_binding_id IS NULL)
  AND b.lifecycle_stage IN ('S1', 'S2', 'S3', 'S4', 'S5')
  AND a.deleted_at IS NULL
  AND (a.stage IS DISTINCT FROM CASE b.lifecycle_stage
            WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3
            WHEN 'S4' THEN 4 WHEN 'S5' THEN 5 END
       OR a.doc_type <> CASE b.lifecycle_stage
            WHEN 'S1' THEN 'research'     WHEN 'S2' THEN 'product-design'
            WHEN 'S3' THEN 'architecture' WHEN 'S4' THEN 'retrospective'
            WHEN 'S5' THEN 'iteration' END);

-- ⑤ 档案导入资产 → 档案回填：binding.external_ref.artifact_id 指向的原档案行。
--    只校正 placement 列，不触碰 source/rel_path/doc_module/正文指针。
UPDATE project_artifact a
SET    stage = CASE b.lifecycle_stage
           WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3
           WHEN 'S4' THEN 4 WHEN 'S5' THEN 5
       END,
       doc_type = CASE b.lifecycle_stage
           WHEN 'S1' THEN 'research'       WHEN 'S2' THEN 'product-design'
           WHEN 'S3' THEN 'architecture'   WHEN 'S4' THEN 'retrospective'
           WHEN 'S5' THEN 'iteration'
       END,
       updated_at = now()
FROM project_asset_binding b
WHERE b.external_ref->>'artifact_id' = a.id::text
  AND b.lifecycle_stage IN ('S1', 'S2', 'S3', 'S4', 'S5')
  AND a.deleted_at IS NULL
  AND (a.stage IS DISTINCT FROM CASE b.lifecycle_stage
            WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3
            WHEN 'S4' THEN 4 WHEN 'S5' THEN 5 END
       OR a.doc_type <> CASE b.lifecycle_stage
            WHEN 'S1' THEN 'research'     WHEN 'S2' THEN 'product-design'
            WHEN 'S3' THEN 'architecture' WHEN 'S4' THEN 'retrospective'
            WHEN 'S5' THEN 'iteration' END);

-- ⑥ 未分阶（general/NULL）资产原生行归一未分阶保留区 (NULL, 'asset')。
UPDATE project_artifact a
SET    stage = NULL, doc_type = 'asset', updated_at = now()
FROM project_asset_binding b
WHERE a.asset_binding_id = b.id
  AND (b.lifecycle_stage IS NULL OR b.lifecycle_stage = 'general')
  AND a.deleted_at IS NULL
  AND (a.stage IS NOT NULL OR a.doc_type <> 'asset');
