-- YaChat E2EE phase 3: speed up negotiation for devices that can receive
-- application-layer encrypted attachment containers.

create index if not exists yachat_e2ee_devices_phase3_ready_idx
  on public.yachat_e2ee_devices(user_id, last_seen_at desc, device_id)
  where revoked_at is null
    and ready_at is not null
    and protocol_version >= 3
    and capabilities ? 'server-blind-text-v1'
    and capabilities ? 'encrypted-attachments-v1';

comment on index public.yachat_e2ee_devices_phase3_ready_idx is
  'Active devices eligible for negotiated E2EE encrypted attachments.';
