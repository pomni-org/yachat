-- Correct the phase 2 readiness index after introducing device heartbeats.
-- Registration updates updated_at, while regular liveness is tracked by last_seen_at.

drop index if exists public.yachat_e2ee_devices_phase2_ready_idx;

create index yachat_e2ee_devices_phase2_ready_idx
  on public.yachat_e2ee_devices(user_id, last_seen_at desc)
  where revoked_at is null and ready_at is not null and protocol_version >= 2;
