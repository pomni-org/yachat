-- YaChat E2EE phase 5 foundation. This migration is intentionally additive:
-- production enforcement is activated only after the phase 5 runtime is live.

alter table public.public_users
  add column if not exists e2ee_required boolean not null default false,
  add column if not exists e2ee_min_protocol integer not null default 2,
  add column if not exists e2ee_migrated_at timestamptz,
  add column if not exists digital_id_lookup_hash text;

alter table public.public_users
  drop constraint if exists public_users_e2ee_min_protocol_check;

alter table public.public_users
  add constraint public_users_e2ee_min_protocol_check
  check (e2ee_min_protocol between 2 and 16);

alter table public.yachat_e2ee_devices
  add column if not exists identity_dh_signature text not null default '';

alter table public.yachat_e2ee_devices
  drop constraint if exists yachat_e2ee_devices_phase5_identity_check;

alter table public.yachat_e2ee_devices
  add constraint yachat_e2ee_devices_phase5_identity_check
  check (
    protocol_version < 5
    or length(identity_dh_signature) between 84 and 90
  );

alter table public.yachat_e2ee_one_time_prekeys
  add column if not exists used_at timestamptz,
  add column if not exists used_by_message_id text;

create index if not exists yachat_e2ee_prekeys_message_use_idx
  on public.yachat_e2ee_one_time_prekeys(used_by_message_id, device_id)
  where used_by_message_id is not null;

create unique index if not exists public_users_digital_id_lookup_hash_idx
  on public.public_users(digital_id_lookup_hash)
  where digital_id_lookup_hash is not null;

alter table public.yachat_chats
  add column if not exists e2ee_min_protocol integer not null default 2;

alter table public.yachat_chats
  drop constraint if exists yachat_chats_e2ee_min_protocol_check;

alter table public.yachat_chats
  add constraint yachat_chats_e2ee_min_protocol_check
  check (e2ee_min_protocol between 2 and 16);

alter table public.yachat_messages
  add column if not exists e2ee_padding_scheme text not null default '',
  add column if not exists e2ee_envelope_digest text not null default '',
  add column if not exists e2ee_sender_sign_public text not null default '',
  add column if not exists e2ee_signature text not null default '';

alter table public.yachat_messages
  drop constraint if exists yachat_messages_phase5_payload_check;

alter table public.yachat_messages
  add constraint yachat_messages_phase5_payload_check
  check (
    e2ee_version < 5
    or (
      e2ee_mode = 'encrypted'
      and e2ee_padding_scheme = 'bucket-v1'
      and length(e2ee_envelope_digest) between 40 and 48
      and length(e2ee_sender_sign_public) between 40 and 48
      and length(e2ee_signature) between 84 and 90
    )
  );

create table if not exists public.yachat_digital_id_vaults (
  user_id text primary key references public.public_users(id) on delete cascade,
  version integer not null default 1,
  algorithm text not null default 'yachat-x3dh-v1',
  ciphertext text not null,
  iv text not null,
  aad text not null,
  envelopes jsonb not null,
  plaintext_digest text not null,
  sender_device_id text not null,
  sender_identity_sign_public text not null,
  envelope_digest text not null,
  signature text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (version = 1),
  check (jsonb_typeof(envelopes) = 'array' and jsonb_array_length(envelopes) > 0),
  check (length(ciphertext) between 300 and 800),
  check (length(iv) between 16 and 20),
  check (length(plaintext_digest) between 40 and 48),
  check (length(sender_identity_sign_public) between 40 and 48),
  check (length(signature) between 84 and 90)
);

alter table public.yachat_digital_id_vaults enable row level security;
revoke all on table public.yachat_digital_id_vaults from public, anon, authenticated;

comment on table public.yachat_digital_id_vaults is
  'Client-encrypted Digital ID vault. The authenticated backend stores and routes ciphertext only.';
comment on column public.yachat_e2ee_devices.identity_dh_signature is
  'Ed25519 attestation binding the static X25519 identity key to this device.';
comment on column public.yachat_e2ee_one_time_prekeys.used_by_message_id is
  'Idempotency binding that prevents a claimed one-time prekey from being reused by another message.';
comment on column public.public_users.digital_id_lookup_hash is
  'Server-keyed HMAC lookup token. The Supabase database does not hold the HMAC key.';
comment on column public.yachat_chats.e2ee_min_protocol is
  'Minimum client E2EE protocol accepted for this chat.';
