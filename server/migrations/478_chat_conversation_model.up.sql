-- 478: 聊天模块通用化 —— 会话类型化 + 参与者模型 + 消息作者化 + 群任务输入快照。
-- 见 change_logs/multica/plans/20261025-聊天模块-人与人群聊/00_共享基础设施与会话模型.md
-- 方案文档编号基线为 477，但仓库实际 477 已被 asset_stage_alignment 占用，故本专题落 478。

-- ===== 会话类型化 =====
ALTER TABLE chat_session
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (kind IN ('agent', 'dm', 'group')),
    ADD COLUMN dm_pair_key TEXT;

ALTER TABLE chat_session ALTER COLUMN agent_id DROP NOT NULL;

ALTER TABLE chat_session ADD CONSTRAINT chat_session_kind_agent_consistency CHECK (
    (kind = 'agent' AND agent_id IS NOT NULL AND dm_pair_key IS NULL)
    OR (kind = 'dm' AND agent_id IS NULL AND dm_pair_key IS NOT NULL)
    OR (kind = 'group' AND agent_id IS NULL AND dm_pair_key IS NULL)
);

CREATE UNIQUE INDEX uq_chat_session_dm_pair
    ON chat_session(workspace_id, dm_pair_key) WHERE kind = 'dm';
CREATE INDEX idx_chat_session_kind ON chat_session(workspace_id, kind);

-- ===== 参与者一等公民 =====
CREATE TABLE chat_participant (
    chat_session_id UUID NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    participant_type TEXT NOT NULL CHECK (participant_type IN ('member', 'agent')),
    participant_id UUID NOT NULL,
    admin BOOLEAN NOT NULL DEFAULT false,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id UUID,
    pinned_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    PRIMARY KEY (chat_session_id, participant_type, participant_id),
    CHECK (participant_type = 'member' OR NOT admin)
);
CREATE INDEX idx_chat_participant_member
    ON chat_participant(participant_id, chat_session_id) WHERE participant_type = 'member';
CREATE INDEX idx_chat_participant_agent
    ON chat_participant(participant_id, chat_session_id) WHERE participant_type = 'agent';

-- ===== 消息作者三维 =====
ALTER TABLE chat_message
    ADD COLUMN author_type TEXT NOT NULL DEFAULT 'member'
        CHECK (author_type IN ('member', 'agent', 'system')),
    ADD COLUMN author_id UUID,
    ADD COLUMN mentions JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(mentions) = 'array');
CREATE INDEX idx_chat_message_author
    ON chat_message(author_type, author_id) WHERE author_id IS NOT NULL;
-- 保留 033 的 (chat_session_id,created_at) 供旧计划使用；新索引与分页/未读
-- 的 (created_at,id) 排序完全一致，避免同时间戳消息触发额外排序。
CREATE INDEX idx_chat_message_session_cursor
    ON chat_message(chat_session_id, created_at, id);

-- ===== 群任务不可变输入快照（一条消息可并行喂多个 Agent） =====
CREATE TABLE chat_group_task_input (
    task_id UUID NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    position INT NOT NULL CHECK (position >= 0),
    is_trigger BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (task_id, message_id),
    UNIQUE (task_id, position)
);
CREATE UNIQUE INDEX uq_chat_group_task_input_trigger
    ON chat_group_task_input(task_id) WHERE is_trigger;
CREATE INDEX idx_chat_group_task_input_message ON chat_group_task_input(message_id);

-- ===== 存量 Agent 会话参与者回填，同时保留原用户已读/置顶位置 =====
INSERT INTO chat_participant (
    chat_session_id, participant_type, participant_id, admin,
    last_read_at, pinned_at
)
SELECT id, 'member', creator_id, true, COALESCE(last_read_at, now()), pinned_at
FROM chat_session WHERE creator_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO chat_participant (chat_session_id, participant_type, participant_id)
SELECT id, 'agent', agent_id FROM chat_session
WHERE agent_id IS NOT NULL ON CONFLICT DO NOTHING;

-- ===== 存量消息作者归因回填 =====
UPDATE chat_message m SET author_type = 'agent', author_id = s.agent_id
FROM chat_session s
WHERE m.chat_session_id = s.id AND m.role = 'assistant' AND s.agent_id IS NOT NULL;
UPDATE chat_message m SET author_type = 'member', author_id = s.creator_id
FROM chat_session s
WHERE m.chat_session_id = s.id AND m.role = 'user' AND s.creator_id IS NOT NULL;
