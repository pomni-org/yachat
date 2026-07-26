-- Activate fail-closed phase 5 for every account and existing private chat.
-- Run this only after the phase 5 API and browser runtime are deployed.

update public.public_users
set e2ee_required = true,
    e2ee_min_protocol = greatest(e2ee_min_protocol, 5);

update public.yachat_chats
set e2ee_policy = 'text_encrypted',
    e2ee_min_protocol = greatest(e2ee_min_protocol, 5),
    e2ee_epoch_id = null,
    e2ee_enabled_at = coalesce(e2ee_enabled_at, now())
where kind = 'private';

update public.yachat_sessions
set e2ee_capable_at = null,
    expires_at = least(expires_at, now())
where e2ee_version < 5;
