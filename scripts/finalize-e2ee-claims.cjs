const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const apiPath = path.join(root, "api", "index.py");

function replaceRequired(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Unable to patch ${label}.`);
  return content.replace(before, after);
}

async function main() {
  let source = await fs.readFile(apiPath, "utf8");

  const encryptedMarker = '        "encrypted": True,';
  const encryptedOccurrences = source.split(encryptedMarker).length - 1;
  if (encryptedOccurrences !== 2) {
    throw new Error(`Expected 2 legacy encrypted claims, found ${encryptedOccurrences}.`);
  }
  source = source.replaceAll(
    encryptedMarker,
    '        "encrypted": False,\n        "e2eePhase": "phase2",'
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

  if (source.split('"e2eePhase": "phase2"').length - 1 !== 2) {
    throw new Error("The public API does not report the E2EE phase 2 rollout honestly.");
  }
  if (source.split('"e2eePolicy"').length - 1 < 2) {
    throw new Error("Chat E2EE policy is missing from API responses.");
  }

  await fs.writeFile(apiPath, source, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
