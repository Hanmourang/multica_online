CREATE UNIQUE INDEX CONCURRENTLY chat_resource_message_ref_uidx
    ON chat_message_resource_ref(
        message_id, resource_type, resource_id, resource_kind, resource_source,
        (COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
    );
