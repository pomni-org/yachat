-- Event-driven transport for YaChat.
--
-- Realtime broadcasts contain invalidation metadata only. Message bodies,
-- attachments, phone numbers, session tokens, and E2EE material never enter
-- realtime.messages. Authenticated YaChat WebSocket gateways load the allowed
-- state from the server after receiving an invalidation.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.yachat_realtime_topic_key()
returns text
language sql
volatile
set search_path = pg_catalog, extensions
as $$
  select encode(extensions.gen_random_bytes(24), 'hex')
$$;

revoke all on function public.yachat_realtime_topic_key()
from public, anon, authenticated;

alter table public.public_users
  add column if not exists realtime_event_key text;

update public.public_users
set realtime_event_key = public.yachat_realtime_topic_key()
where realtime_event_key is null or realtime_event_key = '';

alter table public.public_users
  alter column realtime_event_key set default public.yachat_realtime_topic_key(),
  alter column realtime_event_key set not null;

create unique index if not exists public_users_realtime_event_key_idx
  on public.public_users(realtime_event_key);

alter table public.yachat_chats
  add column if not exists realtime_topic_key text;

update public.yachat_chats
set realtime_topic_key = public.yachat_realtime_topic_key()
where realtime_topic_key is null or realtime_topic_key = '';

alter table public.yachat_chats
  alter column realtime_topic_key set default public.yachat_realtime_topic_key(),
  alter column realtime_topic_key set not null;

create unique index if not exists yachat_chats_realtime_topic_key_idx
  on public.yachat_chats(realtime_topic_key);

create or replace function public.yachat_realtime_emit_user(
  p_user_id text,
  p_event text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_topic_key text;
begin
  select u.realtime_event_key
  into v_topic_key
  from public.public_users u
  where u.id = p_user_id
    and u.deleted_at is null;

  if coalesce(v_topic_key, '') = '' then
    return;
  end if;

  perform realtime.send(
    coalesce(p_payload, '{}'::jsonb)
      || jsonb_build_object('userId', p_user_id),
    left(coalesce(nullif(p_event, ''), 'state_changed'), 64),
    'yachat:user:' || v_topic_key,
    false
  );
end;
$$;

create or replace function public.yachat_realtime_emit_chat(
  p_chat_id text,
  p_event text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_topic_key text;
begin
  select c.realtime_topic_key
  into v_topic_key
  from public.yachat_chats c
  where c.id = p_chat_id;

  if coalesce(v_topic_key, '') = '' then
    return;
  end if;

  perform realtime.send(
    coalesce(p_payload, '{}'::jsonb)
      || jsonb_build_object('chatId', p_chat_id),
    left(coalesce(nullif(p_event, ''), 'chat_changed'), 64),
    'yachat:chat:' || v_topic_key,
    false
  );
end;
$$;

revoke all on function public.yachat_realtime_emit_user(text, text, jsonb)
from public, anon, authenticated;
revoke all on function public.yachat_realtime_emit_chat(text, text, jsonb)
from public, anon, authenticated;

create or replace function public.yachat_realtime_message_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_chat_id text;
  v_message_id text;
begin
  if tg_op = 'DELETE' then
    v_chat_id := old.chat_id;
    v_message_id := old.id;
  else
    v_chat_id := new.chat_id;
    v_message_id := new.id;
  end if;

  perform public.yachat_realtime_emit_chat(
    v_chat_id,
    'chat_changed',
    jsonb_build_object(
      'entity', 'message',
      'operation', lower(tg_op),
      'messageId', v_message_id
    )
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.yachat_realtime_hidden_message_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_message_id text;
  v_user_id text;
  v_chat_id text;
begin
  if tg_op = 'DELETE' then
    v_message_id := old.message_id;
    v_user_id := old.user_id;
  else
    v_message_id := new.message_id;
    v_user_id := new.user_id;
  end if;

  select m.chat_id
  into v_chat_id
  from public.yachat_messages m
  where m.id = v_message_id;

  perform public.yachat_realtime_emit_user(
    v_user_id,
    'chats_changed',
    jsonb_build_object(
      'entity', 'hidden_message',
      'operation', lower(tg_op),
      'chatId', v_chat_id,
      'messageId', v_message_id
    )
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.yachat_realtime_chat_member_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_chat_id text;
  v_changed_user_id text;
  v_old_topic_key text;
  v_member record;
begin
  if tg_op = 'DELETE' then
    v_chat_id := old.chat_id;
    v_changed_user_id := old.user_id;
  else
    v_chat_id := new.chat_id;
    v_changed_user_id := new.user_id;
  end if;

  if tg_op = 'UPDATE' then
    perform public.yachat_realtime_emit_chat(
      v_chat_id,
      'chat_changed',
      jsonb_build_object(
        'entity', 'membership',
        'operation', 'update',
        'userId', v_changed_user_id
      )
    );
    perform public.yachat_realtime_emit_user(
      v_changed_user_id,
      'chats_changed',
      jsonb_build_object(
        'entity', 'membership',
        'operation', 'update',
        'chatId', v_chat_id
      )
    );
    return new;
  end if;

  select c.realtime_topic_key
  into v_old_topic_key
  from public.yachat_chats c
  where c.id = v_chat_id;

  if coalesce(v_old_topic_key, '') <> '' then
    perform realtime.send(
      jsonb_build_object(
        'entity', 'membership',
        'operation', lower(tg_op),
        'chatId', v_chat_id,
        'userId', v_changed_user_id
      ),
      'access_changed',
      'yachat:chat:' || v_old_topic_key,
      false
    );

    update public.yachat_chats
    set realtime_topic_key = public.yachat_realtime_topic_key()
    where id = v_chat_id;
  end if;

  for v_member in
    select cm.user_id
    from public.yachat_chat_members cm
    where cm.chat_id = v_chat_id
    union
    select v_changed_user_id
  loop
    perform public.yachat_realtime_emit_user(
      v_member.user_id,
      'chats_changed',
      jsonb_build_object(
        'entity', 'membership',
        'operation', lower(tg_op),
        'chatId', v_chat_id
      )
    );
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.yachat_realtime_ban_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
begin
  perform public.yachat_realtime_emit_user(
    new.user_id,
    'access_changed',
    jsonb_build_object(
      'entity', 'account_ban',
      'operation', lower(tg_op),
      'permanent', new.permanent
    )
  );
  return new;
end;
$$;

create or replace function public.yachat_realtime_receipt_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
begin
  perform public.yachat_realtime_emit_chat(
    new.chat_id,
    'receipt_changed',
    jsonb_build_object(
      'entity', 'read_receipt',
      'userId', new.user_id,
      'readAt', new.last_read_at
    )
  );
  return new;
end;
$$;

create or replace function public.yachat_realtime_chat_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
begin
  perform public.yachat_realtime_emit_chat(
    new.id,
    'chat_changed',
    jsonb_build_object('entity', 'chat', 'operation', 'update')
  );

  return new;
end;
$$;

create or replace function public.yachat_realtime_chat_deleting()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
begin
  perform realtime.send(
    jsonb_build_object('entity', 'chat', 'operation', 'delete', 'chatId', old.id),
    'chat_deleted',
    'yachat:chat:' || old.realtime_topic_key,
    false
  );

  return old;
end;
$$;

create or replace function public.yachat_realtime_block_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_blocker_id text;
  v_blocked_id text;
  v_chat record;
begin
  if tg_op = 'DELETE' then
    v_blocker_id := old.blocker_id;
    v_blocked_id := old.blocked_id;
  else
    v_blocker_id := new.blocker_id;
    v_blocked_id := new.blocked_id;
  end if;

  perform public.yachat_realtime_emit_user(
    v_blocker_id,
    'chats_changed',
    jsonb_build_object('entity', 'block', 'operation', lower(tg_op))
  );
  perform public.yachat_realtime_emit_user(
    v_blocked_id,
    'chats_changed',
    jsonb_build_object('entity', 'block', 'operation', lower(tg_op))
  );

  for v_chat in
    select cm1.chat_id
    from public.yachat_chat_members cm1
    join public.yachat_chat_members cm2
      on cm2.chat_id = cm1.chat_id
    join public.yachat_chats c
      on c.id = cm1.chat_id
     and c.kind = 'private'
    where cm1.user_id = v_blocker_id
      and cm2.user_id = v_blocked_id
  loop
    perform public.yachat_realtime_emit_chat(
      v_chat.chat_id,
      'chat_changed',
      jsonb_build_object('entity', 'block', 'operation', lower(tg_op))
    );
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.yachat_realtime_profile_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_chat record;
begin
  if coalesce(new.realtime_event_key, '') <> '' then
    perform realtime.send(
      jsonb_build_object(
        'entity', 'profile',
        'userId', new.id,
        'deleted', new.deleted_at is not null
      ),
      'profile_changed',
      'yachat:user:' || new.realtime_event_key,
      false
    );
  end if;

  for v_chat in
    select cm.chat_id
    from public.yachat_chat_members cm
    where cm.user_id = new.id
  loop
    perform public.yachat_realtime_emit_chat(
      v_chat.chat_id,
      'chat_changed',
      jsonb_build_object('entity', 'profile', 'userId', new.id)
    );

  end loop;

  return new;
end;
$$;

create or replace function public.yachat_realtime_user_deleting()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
begin
  if coalesce(old.realtime_event_key, '') <> '' then
    perform realtime.send(
      jsonb_build_object(
        'entity', 'profile',
        'userId', old.id,
        'deleted', true
      ),
      'profile_changed',
      'yachat:user:' || old.realtime_event_key,
      false
    );
  end if;
  return old;
end;
$$;

create or replace function public.yachat_realtime_system_message_changed()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  v_user_id text;
  v_chat_id text;
begin
  if tg_op = 'DELETE' then
    v_user_id := old.user_id;
    v_chat_id := old.chat_id;
  else
    v_user_id := new.user_id;
    v_chat_id := new.chat_id;
  end if;

  perform public.yachat_realtime_emit_user(
    v_user_id,
    'system_changed',
    jsonb_build_object(
      'entity', 'system_message',
      'operation', lower(tg_op),
      'chatId', v_chat_id
    )
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.yachat_realtime_message_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_hidden_message_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_chat_member_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_receipt_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_chat_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_chat_deleting()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_block_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_profile_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_user_deleting()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_system_message_changed()
from public, anon, authenticated;
revoke all on function public.yachat_realtime_ban_changed()
from public, anon, authenticated;

drop trigger if exists yachat_messages_realtime_changed on public.yachat_messages;
create trigger yachat_messages_realtime_changed
after insert or update of
  text,
  formatted_html,
  attachments,
  reply_to_message_id,
  forwarded_from,
  edited_at,
  deleted_at,
  e2ee_version,
  e2ee_mode,
  e2ee_ciphertext,
  e2ee_iv,
  e2ee_aad,
  e2ee_envelopes,
  e2ee_epoch_id,
  e2ee_signature
or delete
on public.yachat_messages
for each row
execute function public.yachat_realtime_message_changed();

drop trigger if exists yachat_message_hidden_realtime_changed on public.yachat_message_hidden;
create trigger yachat_message_hidden_realtime_changed
after insert or delete
on public.yachat_message_hidden
for each row
execute function public.yachat_realtime_hidden_message_changed();

drop trigger if exists yachat_chat_members_realtime_access_changed on public.yachat_chat_members;
create trigger yachat_chat_members_realtime_access_changed
after insert or delete or update of role
on public.yachat_chat_members
for each row
execute function public.yachat_realtime_chat_member_changed();

drop trigger if exists yachat_chat_members_realtime_receipt_changed on public.yachat_chat_members;
create trigger yachat_chat_members_realtime_receipt_changed
after update of last_read_at
on public.yachat_chat_members
for each row
when (old.last_read_at is distinct from new.last_read_at)
execute function public.yachat_realtime_receipt_changed();

drop trigger if exists yachat_chats_realtime_changed on public.yachat_chats;
create trigger yachat_chats_realtime_changed
after update of
  kind,
  title,
  description,
  username,
  owner_id,
  locked,
  verified,
  pinned,
  can_send,
  avatar_url,
  avatar_accent,
  invite_code,
  e2ee_policy,
  e2ee_epoch_id,
  e2ee_enabled_at,
  e2ee_min_protocol
on public.yachat_chats
for each row
execute function public.yachat_realtime_chat_changed();

drop trigger if exists yachat_chats_realtime_deleting on public.yachat_chats;
create trigger yachat_chats_realtime_deleting
before delete
on public.yachat_chats
for each row
execute function public.yachat_realtime_chat_deleting();

drop trigger if exists yachat_user_blocks_realtime_changed on public.yachat_user_blocks;
create trigger yachat_user_blocks_realtime_changed
after insert or delete
on public.yachat_user_blocks
for each row
execute function public.yachat_realtime_block_changed();

drop trigger if exists public_users_realtime_profile_changed on public.public_users;
create trigger public_users_realtime_profile_changed
after update of
  username,
  preview_name,
  display_name,
  bio,
  avatar_url,
  avatar_accent,
  deleted_at,
  deletion_reason
on public.public_users
for each row
execute function public.yachat_realtime_profile_changed();

drop trigger if exists public_users_realtime_deleting on public.public_users;
create trigger public_users_realtime_deleting
before delete
on public.public_users
for each row
execute function public.yachat_realtime_user_deleting();

drop trigger if exists yachat_system_messages_realtime_changed on public.yachat_system_messages;
create trigger yachat_system_messages_realtime_changed
after insert or update or delete
on public.yachat_system_messages
for each row
execute function public.yachat_realtime_system_message_changed();

drop trigger if exists yachat_account_bans_realtime_changed on public.yachat_account_bans;
create trigger yachat_account_bans_realtime_changed
after insert or update of permanent, expires_at
on public.yachat_account_bans
for each row
execute function public.yachat_realtime_ban_changed();
