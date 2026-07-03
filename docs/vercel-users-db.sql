create table if not exists yachat_users (
  id text primary key,
  username text not null unique,
  display_name text not null,
  bio text default '',
  avatar_url text default '',
  avatar_accent text default '#471AFF',
  contact text default '',
  public_key_type text default 'x25519',
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace view public_users as
select
  id,
  username,
  display_name as preview_name,
  display_name,
  bio,
  avatar_url,
  avatar_accent,
  contact,
  public_key_type,
  is_public,
  created_at
from yachat_users
where is_public = true;
