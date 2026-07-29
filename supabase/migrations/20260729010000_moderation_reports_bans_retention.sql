-- Moderation reports, account bans and a 30-day retention window for deleted messages.
-- Report snapshots intentionally do not reference public_users so evidence survives
-- permanent account removal.

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.yachat_reports (
    id text primary key,
    kind text not null check (kind in ('message', 'chat')),
    status text not null default 'collecting'
        check (status in ('collecting', 'pending', 'dismissed', 'banned', 'delivery_failed')),
    reporter_user_id text not null,
    reported_user_id text not null,
    chat_id text not null,
    message_id text,
    reporter_display_name text not null default '',
    reporter_username text not null default '',
    reported_display_name text not null default '',
    reported_username text not null default '',
    created_at timestamptz not null default now(),
    evidence_cutoff timestamptz not null default now(),
    expected_message_count integer not null default 0 check (expected_message_count >= 0),
    telegram_chat_id text,
    telegram_message_id bigint,
    resolution text not null default '',
    moderator_telegram_id text not null default '',
    resolved_at timestamptz,
    check (reporter_user_id <> reported_user_id),
    check (
        (kind = 'message' and message_id is not null)
        or (kind = 'chat' and message_id is null)
    )
);

create index if not exists yachat_reports_reporter_created_idx
    on public.yachat_reports(reporter_user_id, created_at desc);
create index if not exists yachat_reports_reported_status_idx
    on public.yachat_reports(reported_user_id, status, created_at desc);

create table if not exists public.yachat_report_evidence (
    id bigserial primary key,
    report_id text not null references public.yachat_reports(id) on delete cascade,
    message_id text not null,
    author_user_id text not null default '',
    author_display_name text not null default '',
    author_username text not null default '',
    sent_at timestamptz not null,
    deleted_at timestamptz,
    text text not null default '',
    attachment_summary jsonb not null default '[]'::jsonb,
    e2ee_verified boolean not null default false,
    created_at timestamptz not null default now(),
    unique(report_id, message_id)
);

create index if not exists yachat_report_evidence_order_idx
    on public.yachat_report_evidence(report_id, sent_at, message_id);

create table if not exists public.yachat_account_bans (
    id text primary key,
    user_id text not null,
    contact_key text not null default '',
    permanent boolean not null default false,
    expires_at timestamptz,
    report_id text references public.yachat_reports(id) on delete set null,
    reason text not null default '',
    created_at timestamptz not null default now(),
    banned_by_telegram_id text not null default '',
    check (permanent or expires_at is not null)
);

create index if not exists yachat_account_bans_user_active_idx
    on public.yachat_account_bans(user_id, permanent, expires_at desc);
create index if not exists yachat_account_bans_contact_active_idx
    on public.yachat_account_bans(contact_key, permanent, expires_at desc)
    where contact_key <> '';
create index if not exists yachat_account_bans_report_idx
    on public.yachat_account_bans(report_id)
    where report_id is not null;

create table if not exists public.yachat_banned_contacts (
    contact_key text primary key,
    contact text not null default '',
    report_id text references public.yachat_reports(id) on delete set null,
    reason text not null default '',
    banned_at timestamptz not null default now(),
    banned_by_telegram_id text not null default ''
);

create index if not exists yachat_banned_contacts_report_idx
    on public.yachat_banned_contacts(report_id)
    where report_id is not null;

alter table public.yachat_reports enable row level security;
alter table public.yachat_report_evidence enable row level security;
alter table public.yachat_account_bans enable row level security;
alter table public.yachat_banned_contacts enable row level security;

revoke all privileges on table public.yachat_reports from anon, authenticated;
revoke all privileges on table public.yachat_report_evidence from anon, authenticated;
revoke all privileges on sequence public.yachat_report_evidence_id_seq from anon, authenticated;
revoke all privileges on table public.yachat_account_bans from anon, authenticated;
revoke all privileges on table public.yachat_banned_contacts from anon, authenticated;

create or replace function public.yachat_purge_deleted_messages()
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
    purged_count integer := 0;
begin
    with candidates as (
        select m.id
        from public.yachat_messages m
        where m.deleted_at <= now() - interval '30 days'
           or (
                m.deleted_at is null
                and exists (
                    select 1
                    from public.yachat_chat_members cm
                    where cm.chat_id = m.chat_id
                )
                and (
                    select count(*)
                    from public.yachat_message_hidden h
                    where h.message_id = m.id
                ) >= (
                    select count(*)
                    from public.yachat_chat_members cm
                    where cm.chat_id = m.chat_id
                )
                and (
                    select max(h.hidden_at)
                    from public.yachat_message_hidden h
                    where h.message_id = m.id
                ) <= now() - interval '30 days'
           )
    ),
    cleared_replies as (
        update public.yachat_messages child
        set reply_to_message_id = null
        where child.reply_to_message_id in (select id from candidates)
        returning child.id
    ),
    deleted as (
        delete from public.yachat_messages message
        where message.id in (select id from candidates)
        returning message.id
    )
    select count(*) into purged_count from deleted;

    return purged_count;
end;
$$;

revoke all on function public.yachat_purge_deleted_messages() from public, anon, authenticated;

do $$
begin
    if exists (
        select 1
        from pg_namespace
        where nspname = 'cron'
    ) then
        perform cron.unschedule(jobid)
        from cron.job
        where jobname = 'yachat-purge-deleted-messages';

        perform cron.schedule(
            'yachat-purge-deleted-messages',
            '17 3 * * *',
            'select public.yachat_purge_deleted_messages()'
        );
    end if;
exception
    when insufficient_privilege or undefined_function or undefined_table then
        raise notice 'pg_cron cleanup schedule was not installed; run the purge function from an external scheduler';
end
$$;
