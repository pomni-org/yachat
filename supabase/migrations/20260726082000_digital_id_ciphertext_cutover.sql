-- Remove redundant plaintext Digital ID copies after client-side vault support
-- is live. The owner value is cleared individually only after its signed vault
-- has been stored successfully.

alter table public.yachat_identity_challenges
  drop column if exists digital_id;

alter table public.yachat_identity_transactions
  drop column if exists digital_id;

alter table public.public_users
  alter column digital_id drop default,
  alter column digital_id drop not null;

drop trigger if exists public_users_digital_id_immutable on public.public_users;

comment on column public.public_users.digital_id is
  'Temporary migration slot. Null after the owner device commits its encrypted Digital ID vault.';
