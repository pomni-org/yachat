-- Make the server-only access model explicit and cover foreign keys used by
-- reply cleanup and E2EE epoch retirement. The application connects as the
-- table-owning Postgres role, while browser-facing roles remain denied.

do $$
declare
    target_table text;
begin
    foreach target_table in array array[
        'public_users',
        'yachat_account_bans',
        'yachat_auth_challenges',
        'yachat_banned_contacts',
        'yachat_chat_members',
        'yachat_chats',
        'yachat_data_migrations',
        'yachat_developer_clients',
        'yachat_device_codes',
        'yachat_digital_id_vaults',
        'yachat_e2ee_chat_epochs',
        'yachat_e2ee_devices',
        'yachat_e2ee_one_time_prekeys',
        'yachat_identity_challenges',
        'yachat_identity_transactions',
        'yachat_imported_contacts',
        'yachat_message_hidden',
        'yachat_messages',
        'yachat_push_delivery_dedup',
        'yachat_push_subscriptions',
        'yachat_qr_sessions',
        'yachat_report_evidence',
        'yachat_reports',
        'yachat_sessions',
        'yachat_system_chats',
        'yachat_system_messages',
        'yachat_telegram_links',
        'yachat_typing',
        'yachat_user_blocks',
        'yachat_user_presence',
        'yachat_user_settings'
    ]
    loop
        if to_regclass(format('public.%I', target_table)) is null then
            raise exception 'required server table public.% is missing', target_table;
        end if;

        execute format(
            'alter table public.%I enable row level security',
            target_table
        );
        execute format(
            'revoke all privileges on table public.%I from public, anon, authenticated',
            target_table
        );

        if not exists (
            select 1
            from pg_policies
            where schemaname = 'public'
              and tablename = target_table
              and policyname = 'yachat_server_only_deny_all'
        ) then
            execute format(
                'create policy yachat_server_only_deny_all on public.%I '
                'as restrictive for all to anon, authenticated '
                'using (false) with check (false)',
                target_table
            );
        end if;
    end loop;
end
$$;

create index if not exists yachat_chats_e2ee_epoch_fk_idx
    on public.yachat_chats(e2ee_epoch_id)
    where e2ee_epoch_id is not null;

create index if not exists yachat_messages_reply_to_message_fk_idx
    on public.yachat_messages(reply_to_message_id)
    where reply_to_message_id is not null;
