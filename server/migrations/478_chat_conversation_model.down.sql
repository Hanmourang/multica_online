-- 478 down：fail-closed。存在 dm/group 会话时禁止回滚，避免误删私域数据。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM chat_session WHERE kind IN ('dm', 'group')) THEN
        RAISE EXCEPTION 'cannot rollback 478 while dm/group sessions exist';
    END IF;
END $$;

DROP TABLE IF EXISTS chat_group_task_input;
DROP TABLE IF EXISTS chat_participant;
DROP INDEX IF EXISTS idx_chat_message_session_cursor;
DROP INDEX IF EXISTS idx_chat_message_author;
ALTER TABLE chat_message
    DROP COLUMN IF EXISTS mentions, DROP COLUMN IF EXISTS author_id, DROP COLUMN IF EXISTS author_type;
ALTER TABLE chat_session DROP CONSTRAINT IF EXISTS chat_session_kind_agent_consistency;
DROP INDEX IF EXISTS idx_chat_session_kind;
DROP INDEX IF EXISTS uq_chat_session_dm_pair;
ALTER TABLE chat_session DROP COLUMN IF EXISTS dm_pair_key, DROP COLUMN IF EXISTS kind;
ALTER TABLE chat_session ALTER COLUMN agent_id SET NOT NULL;
