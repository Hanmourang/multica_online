-- 477 down: 恢复旧四阶段语义与约束。
-- 可执行且不报错；S5/iteration 增量与交换损失（原 S1/S2 无法区分新旧）
-- 属预期不可逆部分，plan §3.3 已接受该口径；up ③.5 的 source 恢复同理
-- （down 不知历史 PATCH 前的原值，仅影响来源徽标展示）。

-- ① 档案侧 S5/iteration 行退回未分阶保留区，lifecycle S5 资产退回 general。
UPDATE project_artifact
SET    stage = NULL, doc_type = 'asset', updated_at = now()
WHERE  deleted_at IS NULL AND (stage = 5 OR doc_type = 'iteration');

UPDATE project_asset_binding
SET    lifecycle_stage = 'general'
WHERE  lifecycle_stage = 'S5';

-- ② 约束收紧回旧口径（先收约束后改数据会失败，故数据先行）。
ALTER TABLE project_asset_binding
    DROP CONSTRAINT IF EXISTS project_asset_binding_lifecycle_stage_check;
ALTER TABLE project_asset_binding
    ADD CONSTRAINT project_asset_binding_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('S1', 'S2', 'S3', 'S4', 'general'));

ALTER TABLE project_artifact
    DROP CONSTRAINT IF EXISTS project_artifact_stage_check;
ALTER TABLE project_artifact
    ADD CONSTRAINT project_artifact_stage_check
    CHECK (stage IN (1, 2, 3, 4));

-- ③ 语义交换回退：新 S1(规划)↔S2(原型) 换回旧语义（同样无法还原历史原值，
--    与 up 对称执行一次交换即可保持两侧一致）。
UPDATE project_asset_binding
SET lifecycle_stage = CASE lifecycle_stage
        WHEN 'S1' THEN 'S2'
        WHEN 'S2' THEN 'S1'
        ELSE lifecycle_stage END
WHERE lifecycle_stage IN ('S1', 'S2');

-- ④ 档案 placement 按旧四阶段语义重新对齐资产原生行。
UPDATE project_artifact a
SET    stage = CASE b.lifecycle_stage
           WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3 WHEN 'S4' THEN 4
       END,
       doc_type = CASE b.lifecycle_stage
           WHEN 'S1' THEN 'product-design'  WHEN 'S2' THEN 'research'
           WHEN 'S3' THEN 'architecture'    WHEN 'S4' THEN 'retrospective'
       END,
       updated_at = now()
FROM project_asset_binding b
WHERE a.asset_binding_id = b.id
  AND b.lifecycle_stage IN ('S1', 'S2', 'S3', 'S4')
  AND a.deleted_at IS NULL
  AND (a.stage IS DISTINCT FROM CASE b.lifecycle_stage
            WHEN 'S1' THEN 1 WHEN 'S2' THEN 2 WHEN 'S3' THEN 3 WHEN 'S4' THEN 4 END
       OR a.doc_type <> CASE b.lifecycle_stage
            WHEN 'S1' THEN 'product-design' WHEN 'S2' THEN 'research'
            WHEN 'S3' THEN 'architecture'   WHEN 'S4' THEN 'retrospective' END);
