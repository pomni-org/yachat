-- YaChat server schema for Supabase Postgres.
-- The browser never uses the Supabase Data API; all access goes through the
-- authenticated YaChat API running on Vercel.

create table if not exists public.public_users (
  id text primary key,
  contact text,
  contact_key text,
  method text default 'phone',
  username text,
  preview_name text,
  display_name text,
  bio text default '',
  avatar_url text default '',
  avatar_accent text default '#471AFF',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public_key_type text default 'x25519',
  is_public boolean default true
);

create unique index if not exists public_users_contact_key_idx
  on public.public_users(contact_key)
  where contact_key is not null and contact_key <> '';

create unique index if not exists public_users_username_idx
  on public.public_users(lower(username))
  where username is not null and username <> '';

create table if not exists public.yachat_auth_challenges (
  id text primary key,
  contact text not null,
  contact_key text not null,
  method text default 'phone',
  code_hash text not null,
  registration_token_hash text,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  verified_at timestamptz
);

create index if not exists yachat_auth_challenges_contact_idx
  on public.yachat_auth_challenges(contact_key, created_at desc);

create index if not exists yachat_auth_challenges_expires_idx
  on public.yachat_auth_challenges(expires_at);

create table if not exists public.yachat_system_messages (
  id text primary key,
  user_id text not null references public.public_users(id) on delete cascade,
  chat_id text not null,
  author_id text default 'yachat',
  text text default '',
  formatted_html text default '',
  attachments jsonb default '[]'::jsonb,
  system_kind text default '',
  created_at timestamptz default now(),
  expires_at timestamptz
);

create index if not exists yachat_system_messages_user_chat_idx
  on public.yachat_system_messages(user_id, chat_id, created_at);

create table if not exists public.yachat_system_chats (
  id text primary key,
  title text default '',
  description text default '',
  avatar_url text default '',
  updated_at timestamptz default now()
);

create table if not exists public.yachat_telegram_links (
  telegram_user_id text primary key,
  chat_id text not null,
  contact text not null,
  contact_key text not null,
  username text default '',
  first_name text default '',
  updated_at timestamptz default now()
);

create index if not exists yachat_telegram_links_contact_idx
  on public.yachat_telegram_links(contact_key);

create table if not exists public.yachat_sessions (
  token_hash text primary key,
  user_id text not null references public.public_users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create index if not exists yachat_sessions_user_idx
  on public.yachat_sessions(user_id);

create table if not exists public.yachat_chats (
  id text primary key,
  kind text not null default 'private',
  title text default '',
  description text default '',
  username text default '',
  owner_id text references public.public_users(id) on delete set null,
  locked boolean default false,
  verified boolean default false,
  pinned boolean default false,
  can_send boolean default true,
  avatar_url text default '',
  avatar_accent text default '#471AFF',
  invite_code text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists yachat_chats_username_idx
  on public.yachat_chats(lower(username))
  where username is not null and username <> '';

create index if not exists yachat_chats_owner_idx
  on public.yachat_chats(owner_id);

create table if not exists public.yachat_chat_members (
  chat_id text not null references public.yachat_chats(id) on delete cascade,
  user_id text not null references public.public_users(id) on delete cascade,
  role text default 'member',
  joined_at timestamptz default now(),
  last_read_at timestamptz default '1970-01-01T00:00:00Z',
  primary key(chat_id, user_id)
);

create index if not exists yachat_chat_members_user_idx
  on public.yachat_chat_members(user_id);

create table if not exists public.yachat_messages (
  id text primary key,
  chat_id text not null references public.yachat_chats(id) on delete cascade,
  sender_id text references public.public_users(id) on delete set null,
  text text default '',
  formatted_html text default '',
  attachments jsonb default '[]'::jsonb,
  reply_to_message_id text,
  forwarded_from text default '',
  created_at timestamptz default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index if not exists yachat_messages_chat_created_idx
  on public.yachat_messages(chat_id, created_at);

create index if not exists yachat_messages_sender_idx
  on public.yachat_messages(sender_id);

create index if not exists yachat_messages_unread_idx
  on public.yachat_messages(chat_id, created_at, sender_id)
  where deleted_at is null;

create table if not exists public.yachat_message_hidden (
  message_id text not null references public.yachat_messages(id) on delete cascade,
  user_id text not null references public.public_users(id) on delete cascade,
  hidden_at timestamptz default now(),
  primary key(message_id, user_id)
);

create index if not exists yachat_message_hidden_user_idx
  on public.yachat_message_hidden(user_id, message_id);

create table if not exists public.yachat_user_blocks (
  blocker_id text not null references public.public_users(id) on delete cascade,
  blocked_id text not null references public.public_users(id) on delete cascade,
  created_at timestamptz default now(),
  primary key(blocker_id, blocked_id),
  check(blocker_id <> blocked_id)
);

create index if not exists yachat_user_blocks_blocked_idx
  on public.yachat_user_blocks(blocked_id, blocker_id);

create table if not exists public.yachat_push_subscriptions (
  endpoint text primary key,
  user_id text not null references public.public_users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  content_encoding text default 'aes128gcm',
  user_agent text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists yachat_push_subscriptions_user_idx
  on public.yachat_push_subscriptions(user_id);

create table if not exists public.yachat_device_codes (
  id text primary key,
  user_id text not null references public.public_users(id) on delete cascade,
  code_hash text not null unique,
  display_code text not null,
  language text default 'ru',
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists yachat_device_codes_user_idx
  on public.yachat_device_codes(user_id, created_at desc);

create index if not exists yachat_device_codes_expiry_idx
  on public.yachat_device_codes(expires_at, used_at);

create table if not exists public.yachat_data_migrations (
  id text primary key,
  applied_at timestamptz default now()
);

create table if not exists public.yachat_user_settings (
  user_id text primary key references public.public_users(id) on delete cascade,
  language text default 'ru',
  theme text default 'dark',
  theme_source text default 'system',
  country text default 'RU',
  country_code text default '+7',
  updated_at timestamptz default now()
);

create table if not exists public.yachat_qr_sessions (
  id text primary key,
  token_hash text not null,
  status text default 'pending',
  account_id text references public.public_users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  approved_at timestamptz
);

create index if not exists yachat_qr_sessions_status_idx
  on public.yachat_qr_sessions(status, expires_at);

create index if not exists yachat_qr_sessions_account_idx
  on public.yachat_qr_sessions(account_id);

create table if not exists public.yachat_imported_contacts (
  owner_id text not null references public.public_users(id) on delete cascade,
  phone_key text not null,
  phone_raw text not null default '',
  contact_name text not null default '',
  match_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key(owner_id, phone_key)
);

create index if not exists yachat_imported_contacts_phone_idx
  on public.yachat_imported_contacts(phone_key);

create table if not exists public.yachat_user_presence (
  user_id text primary key references public.public_users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.yachat_typing (
  chat_id text not null references public.yachat_chats(id) on delete cascade,
  user_id text not null references public.public_users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key(chat_id, user_id)
);

create index if not exists yachat_typing_expiry_idx
  on public.yachat_typing(expires_at);

create index if not exists yachat_typing_user_idx
  on public.yachat_typing(user_id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'public_users',
    'yachat_auth_challenges',
    'yachat_system_messages',
    'yachat_system_chats',
    'yachat_telegram_links',
    'yachat_sessions',
    'yachat_chats',
    'yachat_chat_members',
    'yachat_messages',
    'yachat_message_hidden',
    'yachat_user_blocks',
    'yachat_push_subscriptions',
    'yachat_device_codes',
    'yachat_data_migrations',
    'yachat_user_settings',
    'yachat_qr_sessions',
    'yachat_imported_contacts',
    'yachat_user_presence',
    'yachat_typing'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'revoke all privileges on table public.%I from anon, authenticated',
      table_name
    );
  end loop;
end
$$;
