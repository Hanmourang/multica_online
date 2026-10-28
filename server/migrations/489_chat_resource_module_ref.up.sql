-- 489: let a chat message reference a project module (or one of its prototype versions).
-- Context: plans/20261026-功能模块能力升级/06_聊天模块_技术方案与执行清单.md §3.1
-- 479 introduced the table with resource_type IN ('issue','document') and
-- resource_kind IN ('','task','requirement'); modules need both widened.
-- The constraint names below are PG-generated, so drop by definition match
-- instead of by name: a rename anywhere in history would otherwise abort the
-- whole migration.

DO $$
DECLARE
    cname text;
BEGIN
    FOR cname IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'chat_message_resource_ref'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%resource_type%'
    LOOP
        EXECUTE format('ALTER TABLE chat_message_resource_ref DROP CONSTRAINT %I', cname);
    END LOOP;

    FOR cname IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'chat_message_resource_ref'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%resource_kind%'
    LOOP
        EXECUTE format('ALTER TABLE chat_message_resource_ref DROP CONSTRAINT %I', cname);
    END LOOP;
END $$;

ALTER TABLE chat_message_resource_ref
    ADD CONSTRAINT chat_message_resource_ref_resource_type_check
        CHECK (resource_type IN ('issue', 'document', 'module', 'module_prototype'));

ALTER TABLE chat_message_resource_ref
    ADD CONSTRAINT chat_message_resource_ref_resource_kind_check
        CHECK (resource_kind IN ('', 'task', 'requirement', 'module', 'prototype'));

-- Reverse lookup: "which conversations discussed this module?" for the module
-- detail page, and "which messages cite this prototype version?" for release
-- receipts. Partial so the much larger issue/document rows stay out of the tree.
CREATE INDEX IF NOT EXISTS chat_resource_module_idx
    ON chat_message_resource_ref(resource_id, message_id)
    WHERE resource_type IN ('module', 'module_prototype');
