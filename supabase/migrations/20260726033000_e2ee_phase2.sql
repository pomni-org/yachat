-- YaChat E2EE phase 2: bind authenticated sessions to devices, activate
-- server-blind text encryption per private chat, and pin each message to a
-- cryptographic device-roster epoch.

alter table public.yachat_sessions
  add column if not exists device_id text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists e2ee_version integer not null default 0,
  add column if not exists e2ee_capable_at timestamptz,
  add column if not exists user_agent text not null default '';

update public.yachat_sessions
set last_seen_at = coalesce(last_seen_at, created_at, now())
where last_seen_at is null;

alter table public.yachat_sessions
  alter column last_seen_at set default now(),
  alter column last_seen_at set not null;

alter table public.yachat_sessions
  drop constraint if exists yachat_sessions_e2ee_version_check;

alter table public.yachat_sessions
  add constraint yachat_sessions_e2ee_version_check
  check (e2ee_version between 0 and 16);

create index if not exists yachat_sessions_e2ee_active_idx
  on public.yachat_sessions(user_id, expires_at, last_seen_at desc, device_id);

create index if not exists yachat_sessions_device_idx
  on public.yachat_sessions(device_id, user_id)
  where device_id is not null;

alter table public.yachat_e2ee_devices
  add column if not exists protocol_version integer not null default 1,
  add column if not exists capabilities jsonb not null default '[]'::jsonb,
  add column if not exists ready_at timestamptz,
  add column if not exists user_agent text not null default '';

alter table public.yachat_e2ee_devices
  drop constraint if exists yachat_e2ee_devices_protocol_version_check;

alter table public.yachat_e2ee_devices
  add constraint yachat_e2ee_devices_protocol_version_check
  check (protocol_version between 1 and 16);

create index if not exists yachat_e2ee_devices_phase2_ready_idx
  on public.yachat_e2ee_devices(user_id, last_seen_at desc)
  where revoked_at is null and ready_at is not null and protocol_version >= 2;

alter table public.yachat_chats
  add column if not exists e2ee_policy text not null default 'legacy',
  add column if not exists e2ee_epoch_id text,
  add column if not exists e2ee_enabled_at timestamptz;

update public.yachat_chats
set e2ee_policy = 'shadow'
where kind = 'private' and e2ee_policy = 'legacy';

alter table public.yachat_chats
  drop constraint if exists yachat_chats_e2ee_policy_check;

alter table public.yachat_chats
  add constraint yachat_chats_e2ee_policy_check
  check (e2ee_policy in ('legacy', 'shadow', 'text_encrypted'));

create table if not exists public.yachat_e2ee_chat_epochs (
  id text primary key,
  chat_id text not null references public.yachat_chats(id) on delete cascade,
  version integer not null,
  roster jsonb not null,
  roster_hash text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique(chat_id, version),
  check (version > 0),
  check (jsonb_typeof(roster) = 'array'),
  check (length(roster_hash) between 40 and 128)
);

create unique index if not exists yachat_e2ee_chat_epochs_active_idx
  on public.yachat_e2ee_chat_epochs(chat_id)
  where retired_at is null;

create index if not exists yachat_e2ee_chat_epochs_roster_idx
  on public.yachat_e2ee_chat_epochs(chat_id, roster_hash, version desc);

alter table public.yachat_chats
  drop constraint if exists yachat_chats_e2ee_epoch_fk;

alter table public.yachat_chats
  add constraint yachat_chats_e2ee_epoch_fk
  foreign key (e2ee_epoch_id)
  references public.yachat_e2ee_chat_epochs(id)
  on delete set null;

alter table public.yachat_messages
  add column if not exists e2ee_epoch_id text;

alter table public.yachat_messages
  drop constraint if exists yachat_messages_e2ee_epoch_fk;

alter table public.yachat_messages
  add constraint yachat_messages_e2ee_epoch_fk
  foreign key (e2ee_epoch_id)
  references public.yachat_e2ee_chat_epochs(id)
  on delete set null;

alter table public.yachat_messages
  drop constraint if exists yachat_messages_encrypted_no_plaintext_check;

alter table public.yachat_messages
  add constraint yachat_messages_encrypted_no_plaintext_check
  check (
    e2ee_mode <> 'encrypted'
    or (
      coalesce(text, '') = ''
      and coalesce(formatted_html, '') = ''
      and reply_to_message_id is null
      and coalesce(forwarded_from, '') = ''
    )
  );

alter table public.yachat_messages
  drop constraint if exists yachat_messages_encrypted_payload_check;

alter table public.yachat_messages
  add constraint yachat_messages_encrypted_payload_check
  check (
    e2ee_mode <> 'encrypted'
    or (
      e2ee_version >= 2
      and e2ee_epoch_id is not null
      and coalesce(e2ee_ciphertext, '') <> ''
      and coalesce(e2ee_iv, '') <> ''
      and coalesce(e2ee_sender_device_id, '') <> ''
      and jsonb_array_length(e2ee_envelopes) > 0
    )
  );

create index if not exists yachat_messages_e2ee_epoch_idx
  on public.yachat_messages(e2ee_epoch_id, created_at)
  where e2ee_epoch_id is not null;

alter table public.yachat_e2ee_chat_epochs enable row level security;
revoke all on table public.yachat_e2ee_chat_epochs from anon, authenticated;

comment on column public.yachat_sessions.device_id is
  'E2EE device bound to this bearer session after authenticated registration.';
comment on column public.yachat_chats.e2ee_policy is
  'legacy=no E2EE enforcement, shadow=compatibility verification, text_encrypted=plaintext text is forbidden.';
comment on table public.yachat_e2ee_chat_epochs is
  'Immutable active-device roster snapshots used to reject missing or injected message envelopes.';
comment on column public.yachat_messages.e2ee_epoch_id is
  'Device-roster epoch that the encrypted message envelopes must exactly cover.';
