-- 回滚 499：撤掉成对发布 / 说明版本 / 字段字典与两个指针列。

ALTER TABLE project_module
    DROP COLUMN IF EXISTS brief_version,
    DROP COLUMN IF EXISTS release_version;

DROP TABLE IF EXISTS module_release;
DROP TABLE IF EXISTS module_brief_version;
DROP TABLE IF EXISTS module_field_def;
