-- 模块自有原型（issue_id 为空）的归属就是 module_id 本身，而
-- issue_prototype_version_owner_check 要求 issue_id 与 module_id 至少一个非空。
-- 原来的 FK ON DELETE SET NULL 在删除模块时会把这类行改成「两个都空」，撞上
-- CHECK 让整条删除失败 —— 表现为前端「删除模块失败」（500）。
--
-- 同一条路径也覆盖项目 / 工作区级联删除：ON DELETE CASCADE 逐行删除
-- project_module 时同样会触发这里的 BEFORE DELETE，先把模块自有版本删掉。
--
-- 带 issue_id 的需求原型保留，仍由 FK 的 SET NULL 释放 module_id。
CREATE OR REPLACE FUNCTION delete_module_owned_prototype_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM issue_prototype_version
    WHERE module_id = OLD.id AND issue_id IS NULL;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_module_owned_prototype_versions ON project_module;
CREATE TRIGGER trg_delete_module_owned_prototype_versions
BEFORE DELETE ON project_module
FOR EACH ROW EXECUTE FUNCTION delete_module_owned_prototype_versions();
