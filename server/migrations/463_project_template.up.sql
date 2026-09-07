-- 项目模板：创建时选定，决定详情 TAB 集合。
-- general / rd / data 为创建可选值；full 仅给存量项目，保持当前八 TAB。
ALTER TABLE project
    ADD COLUMN template TEXT NOT NULL DEFAULT 'full'
        CHECK (template IN ('general', 'rd', 'data', 'full'));
