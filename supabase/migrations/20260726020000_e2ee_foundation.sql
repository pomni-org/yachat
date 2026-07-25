-- YaChat E2EE foundation. Phase 1 stores encrypted shadow payloads while
-- legacy plaintext remains readable during the compatibility rollout.

create table if not exists public.yachat_e2ee_devices (
  device_id text primary key,
  user_id text not null references public.public_users(id) on delete cascade,
  algorithm text not null default 'yachat-x3dh-v1',
  identity_dh_public text not null,
  identity_sign_public text not null,
  signed_prekey_id text not null,
  signed_prekey_public text not null,
  signed_prekey_signature text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (length(device_id) between 8 and 128),
  check (length(identity_dh_public) between 40 and 128),
  check (length(identity_sign_public) between 40 and 128),
  check (length(signed_prekey_public) between 40 and 128),
  check (length(signed_prekey_signature) between 80 and 256)
);

create index if not exists yachat_e2ee_devices_user_active_idx
  on public.yachat_e2ee_devices(user_id, updated_at desc)
  where revoked_at is null;

create table if not exists public.yachat_e2ee_one_time_prekeys (
  device_id text not null references public.yachat_e2ee_devices(device_id) on delete cascade,
  prekey_id text not null,
  public_key text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by_user_id text references public.public_users(id) on delete set null,
  claimed_by_device_id text,
  primary key (device_id, prekey_id),
  check (length(prekey_id) between 8 and 128),
  check (length(public_key) between 40 and 128)
);

create index if not exists yachat_e2ee_prekeys_available_idx
  on public.yachat_e2ee_one_time_prekeys(device_id, created_at)
  where claimed_at is null;

create index if not exists yachat_e2ee_prekeys_claimed_user_idx
  on public.yachat_e2ee_one_time_prekeys(claimed_by_user_id)
  where claimed_by_user_id is not null;

alter table public.yachat_messages
  add column if not exists e2ee_version integer not null default 0,
  add column if not exists e2ee_mode text not null default 'legacy',
  add column if not exists e2ee_ciphertext text not null default '',
  add column if not exists e2ee_iv text not null default '',
  add column if not exists e2ee_aad text not null default '',
  add column if not exists e2ee_envelopes jsonb not null default '[]'::jsonb,
  add column if not exists e2ee_sender_device_id text not null default '',
  add column if not exists e2ee_plaintext_digest text not null default '';

alter table public.yachat_messages
  drop constraint if exists yachat_messages_e2ee_mode_check;

alter table public.yachat_messages
  add constraint yachat_messages_e2ee_mode_check
  check (e2ee_mode in ('legacy', 'shadow', 'encrypted'));

alter table public.yachat_e2ee_devices enable row level security;
alter table public.yachat_e2ee_one_time_prekeys enable row level security;

revoke all on table public.yachat_e2ee_devices from anon, authenticated;
revoke all on table public.yachat_e2ee_one_time_prekeys from anon, authenticated;

comment on table public.yachat_e2ee_devices is
  'Public device key bundles used by the YaChat authenticated backend. Private keys never leave clients.';
comment on table public.yachat_e2ee_one_time_prekeys is
  'One-time X25519 public prekeys claimed atomically by authenticated chat participants.';
comment on column public.yachat_messages.e2ee_mode is
  'legacy=plaintext only, shadow=plaintext plus client ciphertext, encrypted=server-blind ciphertext only.';
