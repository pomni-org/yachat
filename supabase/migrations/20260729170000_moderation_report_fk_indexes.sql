-- Cover report foreign keys used when moderation evidence is resolved or removed.

create index if not exists yachat_account_bans_report_idx
    on public.yachat_account_bans(report_id)
    where report_id is not null;

create index if not exists yachat_banned_contacts_report_idx
    on public.yachat_banned_contacts(report_id)
    where report_id is not null;
