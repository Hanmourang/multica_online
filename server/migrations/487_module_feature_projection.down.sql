-- 回滚 487：drop 投影表与需求关联表（均为派生/桥接表，无其他引用方）。
DROP TABLE IF EXISTS module_requirement_link;
DROP TABLE IF EXISTS project_module_feature;
