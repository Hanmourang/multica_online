CREATE INDEX CONCURRENTLY chat_resource_target_idx
    ON chat_message_resource_ref(resource_type, resource_id);
