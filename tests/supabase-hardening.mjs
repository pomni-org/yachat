import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, database] = await Promise.all([
  readFile(
    new URL(
      "../supabase/migrations/20260729203619_harden_server_tables_and_fk_indexes.sql",
      import.meta.url
    ),
    "utf8"
  ),
  readFile(new URL("../server/database.py", import.meta.url), "utf8")
]);

const serverOnlyTables = [
  "public_users",
  "yachat_account_bans",
  "yachat_auth_challenges",
  "yachat_banned_contacts",
  "yachat_chat_members",
  "yachat_chats",
  "yachat_data_migrations",
  "yachat_developer_clients",
  "yachat_device_codes",
  "yachat_digital_id_vaults",
  "yachat_e2ee_chat_epochs",
  "yachat_e2ee_devices",
  "yachat_e2ee_one_time_prekeys",
  "yachat_identity_challenges",
  "yachat_identity_transactions",
  "yachat_imported_contacts",
  "yachat_message_hidden",
  "yachat_messages",
  "yachat_push_delivery_dedup",
  "yachat_push_subscriptions",
  "yachat_qr_sessions",
  "yachat_report_evidence",
  "yachat_reports",
  "yachat_sessions",
  "yachat_system_chats",
  "yachat_system_messages",
  "yachat_telegram_links",
  "yachat_typing",
  "yachat_user_blocks",
  "yachat_user_presence",
  "yachat_user_settings"
];

for (const table of serverOnlyTables) {
  assert.match(migration, new RegExp(`'${table}'`));
}

assert.match(migration, /create policy yachat_server_only_deny_all/);
assert.match(migration, /as restrictive for all to anon, authenticated/);
assert.match(
  migration,
  /revoke all privileges on table public\.%I from public, anon, authenticated/
);
assert.match(
  migration,
  /create index if not exists yachat_chats_e2ee_epoch_fk_idx[\s\S]*e2ee_epoch_id/
);
assert.match(
  migration,
  /create index if not exists yachat_messages_reply_to_message_fk_idx[\s\S]*reply_to_message_id/
);
assert.doesNotMatch(migration, /\bdrop\s+(?:index|table|column|policy)\b/i);

assert.match(database, /SERVER_ONLY_POLICY = "yachat_server_only_deny_all"/);
assert.match(database, /from public, anon, authenticated/);
assert.match(database, /create policy \{\} on \{\}/);
assert.match(database, /as restrictive/);
assert.match(database, /using \(false\)/);
assert.match(database, /with check \(false\)/);

console.log("supabase advisor hardening regression passed");
