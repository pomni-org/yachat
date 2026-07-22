begin;

-- Human-readable Digital IDs belong only to public_users. Verification records
-- identify the account by user_id and the external service by its scoped subject.
update public.yachat_identity_challenges
set digital_id = '[redacted]'
where digital_id is distinct from '[redacted]';

update public.yachat_identity_transactions
set digital_id = '[redacted]'
where digital_id is distinct from '[redacted]';

alter table public.yachat_identity_challenges
  drop column if exists digital_id;

alter table public.yachat_identity_transactions
  drop column if exists digital_id;

alter table public.yachat_identity_challenges enable row level security;
alter table public.yachat_identity_transactions enable row level security;

revoke all on table public.yachat_identity_challenges from anon, authenticated;
revoke all on table public.yachat_identity_transactions from anon, authenticated;

commit;
