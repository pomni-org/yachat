const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const apiPath = path.join(root, "api", "index.py");
const fastPath = path.join(root, "api", "messenger_fast.py");

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Unable to patch ${label}.`);
  return content.replace(before, after);
}

async function patchCoreApi() {
  let source = await fs.readFile(apiPath, "utf8");

  const encryptedMarker = '        "encrypted": True,';
  const encryptedOccurrences = source.split(encryptedMarker).length - 1;
  if (encryptedOccurrences !== 2) {
    throw new Error(`Expected 2 legacy encrypted claims, found ${encryptedOccurrences}.`);
  }
  source = source.replaceAll(
    encryptedMarker,
    '        "encrypted": False,\n        "e2eePhase": "phase5",'
  );

  source = replaceRequired(
    source,
    `                row = cursor.fetchone()
                return dict(row) if row else None`,
    `                row = cursor.fetchone()
                if row:
                    cursor.execute(
                        """
                        update yachat_sessions
                        set last_seen_at = now()
                        where token_hash = %s
                          and last_seen_at < now() - interval '5 minutes'
                        """,
                        (hash_secret(token),),
                    )
                return dict(row) if row else None`,
    "session activity heartbeat"
  );

  source = source.replaceAll(
    `        "description": str(row_value(chat, "description")),`,
    `        "description": str(row_value(chat, "description")),
        "e2eePolicy": str(row_value(chat, "e2ee_policy")) or "legacy",
        "e2eeEpochId": str(row_value(chat, "e2ee_epoch_id")),
        "e2eeEnabledAt": row_value(chat, "e2ee_enabled_at") or None,`
  );

  source = replaceRequired(
    source,
    `        select m.text, m.attachments, m.created_at`,
    `        select m.text, m.attachments, m.e2ee_mode, m.created_at`,
    "direct encrypted chat preview"
  );
  source = replaceRequired(
    source,
    `                select distinct on (m.chat_id) m.chat_id, m.text, m.attachments, m.created_at`,
    `                select distinct on (m.chat_id) m.chat_id, m.text, m.attachments, m.e2ee_mode, m.created_at`,
    "cached encrypted chat preview"
  );

  const previewMarker = `        "lastMessage": str(row_value(last, "text")) or attachment_text,`;
  const previewOccurrences = source.split(previewMarker).length - 1;
  if (previewOccurrences !== 2) {
    throw new Error(`Expected 2 chat preview projections, found ${previewOccurrences}.`);
  }
  source = source.replaceAll(
    previewMarker,
    `        "lastMessage": (
            attachment_text
            if attachment_text
            else "Защищённое сообщение"
            if str(row_value(last, "e2ee_mode")) == "encrypted"
            else str(row_value(last, "text"))
        ),`
  );

  if (source.split('"e2eePhase": "phase5"').length - 1 !== 2) {
    throw new Error("The public API does not report the E2EE phase 5 rollout honestly.");
  }
  if (source.split('"e2eePolicy"').length - 1 < 2) {
    throw new Error("Chat E2EE policy is missing from core API responses.");
  }

  await fs.writeFile(apiPath, source, "utf8");
}

async function patchFastMessenger() {
  let source = await fs.readFile(fastPath, "utf8");

  source = replaceRequired(
    source,
    `                    c.pinned, c.can_send, c.invite_code, c.created_at, c.updated_at`,
    `                    c.pinned, c.can_send, c.invite_code, c.created_at, c.updated_at,
                    c.e2ee_policy, c.e2ee_epoch_id, c.e2ee_enabled_at`,
    "fast chat E2EE fields"
  );

  source = replaceRequired(
    source,
    `                    m.text,
                    m.created_at,`,
    `                    m.text,
                    m.e2ee_mode,
                    m.created_at,`,
    "fast encrypted chat preview mode"
  );

  source = replaceRequired(
    source,
    `                        "description": str(row_value(chat, "description")),`,
    `                        "description": str(row_value(chat, "description")),
                        "e2eePolicy": str(row_value(chat, "e2ee_policy")) or "legacy",
                        "e2eeEpochId": str(row_value(chat, "e2ee_epoch_id")),
                        "e2eeEnabledAt": row_value(chat, "e2ee_enabled_at") or None,`,
    "fast chat E2EE policy projection"
  );

  source = replaceRequired(
    source,
    `                        "lastMessage": str(row_value(last, "text"))
                        or _attachment_label(str(row_value(last, "attachment_kind"))),`,
    `                        "lastMessage": (
                            _attachment_label(str(row_value(last, "attachment_kind")))
                            or "Защищённое сообщение"
                            if str(row_value(last, "e2ee_mode")) == "encrypted"
                            else str(row_value(last, "text"))
                            or _attachment_label(str(row_value(last, "attachment_kind")))
                        ),`,
    "fast protected chat preview"
  );

  if (!source.includes('"e2eePolicy"') || !source.includes("m.e2ee_mode")) {
    throw new Error("Fast messenger E2EE policy projection is incomplete.");
  }
  await fs.writeFile(fastPath, source, "utf8");
}

async function main() {
  await patchCoreApi();
  await patchFastMessenger();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
