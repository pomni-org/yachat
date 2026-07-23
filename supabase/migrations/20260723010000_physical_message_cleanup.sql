-- Messages deleted for everyone are no longer retained as soft-deleted rows.
-- Existing soft-deleted rows are removed once, reply references become safe,
-- and the redundant broad chat/created index is dropped.

update public.yachat_messages child
set reply_to_message_id = null
where child.reply_to_message_id is not null
  and not exists (
    select 1
    from public.yachat_messages parent
    where parent.id = child.reply_to_message_id
      and parent.deleted_at is null
  );

delete from public.yachat_messages
where deleted_at is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.yachat_messages'::regclass
      and conname = 'yachat_messages_reply_to_message_id_fkey'
  ) then
    alter table public.yachat_messages
      add constraint yachat_messages_reply_to_message_id_fkey
      foreign key (reply_to_message_id)
      references public.yachat_messages(id)
      on delete set null;
  end if;
end
$$;

drop index if exists public.yachat_messages_chat_created_idx;

analyze public.yachat_messages;
analyze public.yachat_message_hidden;
