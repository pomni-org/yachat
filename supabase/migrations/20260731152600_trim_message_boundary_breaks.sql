-- Remove empty boundary lines from message text at the storage boundary.
-- Internal line breaks remain untouched. Existing history is intentionally not rewritten.

create or replace function public.yachat_trim_message_boundary_breaks(value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
    normalized text := coalesce(value, '');
begin
    normalized := regexp_replace(
        normalized,
        '^(?:[[:blank:]]*(?:\r\n|\r|\n))+',
        ''
    );
    normalized := regexp_replace(
        normalized,
        '(?:(?:\r\n|\r|\n)[[:blank:]]*)+$',
        ''
    );

    if normalized ~ '^[[:space:]]*$' then
        return '';
    end if;

    return normalized;
end
$$;

create or replace function public.yachat_normalize_message_boundary_breaks()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.text := public.yachat_trim_message_boundary_breaks(new.text);
    return new;
end
$$;

drop trigger if exists yachat_messages_trim_boundary_breaks
    on public.yachat_messages;
create trigger yachat_messages_trim_boundary_breaks
before insert or update of text on public.yachat_messages
for each row
execute function public.yachat_normalize_message_boundary_breaks();

drop trigger if exists yachat_system_messages_trim_boundary_breaks
    on public.yachat_system_messages;
create trigger yachat_system_messages_trim_boundary_breaks
before insert or update of text on public.yachat_system_messages
for each row
execute function public.yachat_normalize_message_boundary_breaks();
