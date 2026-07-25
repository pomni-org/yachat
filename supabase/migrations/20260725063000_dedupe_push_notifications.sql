alter table public.yachat_push_subscriptions
  add column if not exists device_id text not null default '';

create unique index if not exists yachat_push_subscriptions_user_device_uidx
  on public.yachat_push_subscriptions(user_id, device_id)
  where device_id <> '';

create table if not exists public.yachat_push_delivery_dedup (
  user_id text not null references public.public_users(id) on delete cascade,
  notification_tag text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, notification_tag)
);

create index if not exists yachat_push_delivery_dedup_created_idx
  on public.yachat_push_delivery_dedup(created_at);

alter table public.yachat_push_delivery_dedup enable row level security;
revoke all on table public.yachat_push_delivery_dedup from anon, authenticated;
