-- YaChat E2EE phase 4: device-bound public keys for encrypted notification
-- previews. Private preview keys remain in the receiving browser.

alter table public.yachat_e2ee_devices
  add column if not exists push_preview_public text not null default '',
  add column if not exists push_preview_signature text not null default '';

alter table public.yachat_e2ee_devices
  drop constraint if exists yachat_e2ee_devices_push_preview_key_check;

alter table public.yachat_e2ee_devices
  add constraint yachat_e2ee_devices_push_preview_key_check
  check (
    (push_preview_public = '' and push_preview_signature = '')
    or (
      length(push_preview_public) between 86 and 90
      and length(push_preview_signature) between 84 and 90
    )
  );

comment on column public.yachat_e2ee_devices.push_preview_public is
  'Signed P-256 public key used by senders to encrypt notification previews for this device.';

comment on column public.yachat_e2ee_devices.push_preview_signature is
  'Ed25519 identity signature binding the push-preview key to the E2EE device.';
