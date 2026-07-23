-- Every Digital ID chooses one alphabet once and uses it for all letters.

create or replace function public.yachat_generate_digital_id()
returns text
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
    latin_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    cyrillic_alphabet constant text := 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ';
    alphabet text;
    letter_count integer;
    candidate text;
    position integer;
begin
    loop
        alphabet := case when random() < 0.5 then latin_alphabet else cyrillic_alphabet end;
        letter_count := 2 + floor(random() * 2)::integer;
        candidate := '';

        for position in 1..letter_count loop
            candidate := candidate || substr(
                alphabet,
                1 + floor(random() * length(alphabet))::integer,
                1
            );
        end loop;

        for position in (letter_count + 1)..6 loop
            candidate := candidate || floor(random() * 10)::integer::text;
        end loop;

        exit when not exists (
            select 1
            from public.public_users
            where digital_id = candidate
        );
    end loop;

    return candidate;
end;
$$;

create or replace function public.yachat_generate_digital_id(p_language text)
returns text
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
    alphabet text := case
        when lower(coalesce(p_language, 'en')) = 'ru'
            then 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ'
        else 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    end;
    letter_count integer;
    candidate text;
    position integer;
begin
    loop
        letter_count := 2 + floor(random() * 2)::integer;
        candidate := '';

        for position in 1..letter_count loop
            candidate := candidate || substr(
                alphabet,
                1 + floor(random() * length(alphabet))::integer,
                1
            );
        end loop;

        for position in (letter_count + 1)..6 loop
            candidate := candidate || floor(random() * 10)::integer::text;
        end loop;

        exit when not exists (
            select 1
            from public.public_users
            where digital_id = candidate
        );
    end loop;

    return candidate;
end;
$$;

revoke all on function public.yachat_generate_digital_id() from public, anon, authenticated;
revoke all on function public.yachat_generate_digital_id(text) from public, anon, authenticated;
alter table public.public_users alter column digital_id set default public.yachat_generate_digital_id();

do $$
begin
    if exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.public_users'::regclass
          and tgname = 'public_users_digital_id_immutable'
          and not tgisinternal
    ) then
        execute 'alter table public.public_users disable trigger public_users_digital_id_immutable';
    end if;
end;
$$;

update public.public_users
set digital_id = public.yachat_generate_digital_id(),
    updated_at = now()
where digital_id is null
   or digital_id = ''
   or not (
       digital_id ~ '^([ABCDEFGHJKLMNPQRSTUVWXYZ]{2}[0-9]{4}|[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}[0-9]{3})$'
       or digital_id ~ '^([АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}[0-9]{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}[0-9]{3})$'
   );

do $$
begin
    if exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.public_users'::regclass
          and tgname = 'public_users_digital_id_immutable'
          and not tgisinternal
    ) then
        execute 'alter table public.public_users enable trigger public_users_digital_id_immutable';
    end if;
end;
$$;

alter table public.public_users
    drop constraint if exists public_users_digital_id_single_script_check;

alter table public.public_users
    add constraint public_users_digital_id_single_script_check
    check (
        digital_id ~ '^([ABCDEFGHJKLMNPQRSTUVWXYZ]{2}[0-9]{4}|[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}[0-9]{3})$'
        or digital_id ~ '^([АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}[0-9]{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}[0-9]{3})$'
    );

comment on function public.yachat_generate_digital_id() is
    'Generates a unique six-character Digital ID whose letters belong to exactly one script.';
comment on function public.yachat_generate_digital_id(text) is
    'Generates a unique six-character Digital ID in the alphabet selected once from the account language.';
