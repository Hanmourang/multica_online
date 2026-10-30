-- 任务属性「功能点」：把一条工作项钉到 项目 → 功能模块 → 原型图 → 功能点 的最后一跳。
--
-- 为什么是 issue 上的一列，而不是再建一张关联表：
--   功能点编号（FP-xx）只在它的模块里唯一（project_module_feature UNIQUE(module_id, code)），
--   而 issue 已经带着 module_id —— 所以 (module_id, feature_code) 这一对本身就是「哪个模块的哪个
--   功能点」的完整主键。再存一份 module_id 到关联表里，等于给同一个事实留两个可漂移的副本。
--
-- 一个任务一个功能点：这是「精细化迭代」的粒度。覆盖多个功能点的工作应当拆成多条任务
-- （每条一个 FP），否则「这个任务到底在改哪一个区块」在原型上就没有唯一答案。
--
-- 存量全部为 NULL（缺就是缺，不猜）：功能点由人/agent 显式绑定，不做任何自动推断。

ALTER TABLE issue
    ADD COLUMN IF NOT EXISTS feature_code TEXT;

-- 「这个功能点被哪些任务覆盖」是列表/原型右栏要问的问题，按 (module_id, feature_code)
-- 建局部索引：绝大多数 issue 没有功能点，部分索引可以完全不进树。
CREATE INDEX IF NOT EXISTS idx_issue_module_feature
    ON issue (module_id, feature_code)
 WHERE feature_code IS NOT NULL;

-- 功能点必须挂在模块下：没有模块就没有功能点可指。
-- NOT VALID 只跳过建约束时对存量行的全表校验（存量 feature_code 全为 NULL，
-- 逻辑上必然满足），之后的每一次写入仍然照常校验。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'issue_feature_code_requires_module'
    ) THEN
        ALTER TABLE issue
            ADD CONSTRAINT issue_feature_code_requires_module
            CHECK (feature_code IS NULL OR module_id IS NOT NULL) NOT VALID;
    END IF;
END $$;

COMMENT ON COLUMN issue.feature_code IS
    '功能点编号（project_module_feature.code，作用域 = 本行 module_id）；NULL = 未绑定功能点';
