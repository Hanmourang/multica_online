-- 483: emoji reactions and short replies stay on the chat message.
CREATE TABLE chat_message_reaction (
    message_id UUID NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, actor_id, emoji)
);

CREATE INDEX chat_message_reaction_message_idx ON chat_message_reaction (message_id);

CREATE TABLE chat_message_reply (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    chat_session_id UUID NOT NULL,
    author_id UUID NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_message_reply_message_idx ON chat_message_reply (message_id, created_at);
