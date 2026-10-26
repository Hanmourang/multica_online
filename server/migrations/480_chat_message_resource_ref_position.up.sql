CREATE UNIQUE INDEX CONCURRENTLY chat_resource_message_position_uidx
    ON chat_message_resource_ref(message_id, position);
