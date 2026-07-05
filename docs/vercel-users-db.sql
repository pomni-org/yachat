create table if not exists public_users (
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
  on public_users(contact_key)
  where contact_key is not null and contact_key <> '';

create unique index if not exists public_users_username_idx
  on public_users(lower(username))
  where username is not null and username <> '';

create table if not exists yachat_auth_challenges (
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
  on yachat_auth_challenges(contact_key, created_at desc);

create table if not exists yachat_system_messages (
  id text primary key,
  user_id text not null references public_users(id) on delete cascade,
  chat_id text not null,
  text text default '',
  system_kind text default '',
  created_at timestamptz default now(),
  expires_at timestamptz
);

create index if not exists yachat_system_messages_user_chat_idx
  on yachat_system_messages(user_id, chat_id, created_at);

create table if not exists yachat_telegram_links (
  telegram_user_id text primary key,
  chat_id text not null,
  contact text not null,
  contact_key text not null,
  username text default '',
  first_name text default '',
  updated_at timestamptz default now()
);

create index if not exists yachat_telegram_links_contact_idx
  on yachat_telegram_links(contact_key);

create table if not exists yachat_sessions (
  token_hash text primary key,
  user_id text not null references public_users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create index if not exists yachat_sessions_user_idx
  on yachat_sessions(user_id);

create table if not exists yachat_chats (
  id text primary key,
  kind text not null default 'private',
  title text default '',
  description text default '',
  owner_id text references public_users(id) on delete set null,
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

create table if not exists yachat_chat_members (
  chat_id text not null references yachat_chats(id) on delete cascade,
  user_id text not null references public_users(id) on delete cascade,
  role text default 'member',
  joined_at timestamptz default now(),
  last_read_at timestamptz default '1970-01-01T00:00:00Z',
  primary key(chat_id, user_id)
);

create index if not exists yachat_chat_members_user_idx
  on yachat_chat_members(user_id);

create table if not exists yachat_messages (
  id text primary key,
  chat_id text not null references yachat_chats(id) on delete cascade,
  sender_id text references public_users(id) on delete set null,
  text text default '',
  attachments jsonb default '[]'::jsonb,
  reply_to_message_id text,
  forwarded_from text default '',
  created_at timestamptz default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index if not exists yachat_messages_chat_created_idx
  on yachat_messages(chat_id, created_at);

create table if not exists yachat_push_subscriptions (
  endpoint text primary key,
  user_id text not null references public_users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  content_encoding text default 'aes128gcm',
  user_agent text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists yachat_push_subscriptions_user_idx
  on yachat_push_subscriptions(user_id);

create table if not exists yachat_user_settings (
  user_id text primary key references public_users(id) on delete cascade,
  language text default 'ru',
  theme text default 'dark',
  theme_source text default 'system',
  country text default 'RU',
  country_code text default '+7',
  updated_at timestamptz default now()
);

create table if not exists yachat_qr_sessions (
  id text primary key,
  token_hash text not null,
  status text default 'pending',
  account_id text references public_users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  approved_at timestamptz
);

create index if not exists yachat_qr_sessions_status_idx
  on yachat_qr_sessions(status, expires_at);
