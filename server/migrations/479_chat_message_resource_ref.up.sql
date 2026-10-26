-- 479: Chat resource references stay separate from message content and snapshots.
CREATE TABLE chat_message_resource_ref (
    message_id UUID NOT NULL,
    position INT NOT NULL CHECK (position BETWEEN 0 AND 2),
    resource_type TEXT NOT NULL CHECK (resource_type IN ('issue', 'document')),
    resource_id UUID NOT NULL,
    resource_kind TEXT NOT NULL DEFAULT '' CHECK (resource_kind IN ('', 'task', 'requirement')),
    resource_source TEXT NOT NULL DEFAULT '' CHECK (resource_source IN ('', 'artifact', 'attachment')),
    project_id UUID
);
