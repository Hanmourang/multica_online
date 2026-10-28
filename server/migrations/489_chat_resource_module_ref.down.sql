DROP INDEX IF EXISTS chat_resource_module_idx;

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
        CHECK (resource_type IN ('issue', 'document'));

ALTER TABLE chat_message_resource_ref
    ADD CONSTRAINT chat_message_resource_ref_resource_kind_check
        CHECK (resource_kind IN ('', 'task', 'requirement'));
