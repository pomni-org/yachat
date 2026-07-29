-- Readable moderation reasons and durable tombstones for permanently banned accounts.

alter table public.yachat_reports
    add column if not exists reason text not null default '';

alter table public.yachat_reports
    drop constraint if exists yachat_reports_reason_length_check;

alter table public.yachat_reports
    add constraint yachat_reports_reason_length_check
    check (reason = '' or char_length(btrim(reason)) between 3 and 1000);

alter table public.public_users
    add column if not exists deleted_at timestamptz,
    add column if not exists deletion_reason text not null default '',
    add column if not exists deleted_by_report_id text;

create index if not exists public_users_deleted_at_idx
    on public.public_users(deleted_at)
    where deleted_at is not null;

comment on column public.public_users.deleted_at is
    'Tombstone timestamp. The row remains so existing private chats can show a deleted-account state.';
comment on column public.public_users.deletion_reason is
    'Internal deletion category. Permanent moderation bans use permanent_moderation_ban.';
comment on column public.public_users.deleted_by_report_id is
    'Moderation report that caused the tombstone, retained as text so report evidence stays independent.';
