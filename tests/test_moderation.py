from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server import moderation


class QueueCursor:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.queries: list[str] = []

    def execute(self, query, params=None):
        self.queries.append(" ".join(str(query).lower().split()))

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None


class ModerationTests(unittest.TestCase):
    def test_phone_ban_matches_common_russian_number_forms(self):
        keys = moderation._contact_keys("8 (999) 000-00-00")

        self.assertIn("89990000000", keys)
        self.assertIn("79990000000", keys)
        self.assertIn("+79990000000", keys)

    def test_forbidden_contact_blocks_auth(self):
        cursor = QueueCursor([{"contact_key": "79990000000", "permanent": True}])

        with self.assertRaises(HTTPException) as raised:
            moderation.ensure_account_allowed(cursor, contact_key="79990000000")

        self.assertEqual(raised.exception.status_code, 403)
        self.assertIn("запрещён", raised.exception.detail.lower())

    def test_unauthorized_telegram_callback_never_touches_database(self):
        update = {
            "callback_query": {
                "id": "callback-1",
                "data": "report:dismiss:11111111-1111-4111-8111-111111111111",
                "from": {"id": 42},
                "message": {"message_id": 7, "chat": {"id": 5893181200}},
            }
        }
        with (
            patch.object(moderation, "moderator_telegram_ids", return_value={"5893181200"}),
            patch.object(moderation, "_telegram_api", return_value={}) as telegram,
            patch.object(moderation, "connect_db") as connect,
        ):
            handled = moderation.handle_moderation_callback(update)

        self.assertTrue(handled)
        connect.assert_not_called()
        self.assertEqual(telegram.call_args.args[0], "answerCallbackQuery")

    def test_permanent_ban_marks_contact_and_leaves_deleted_account_tombstone(self):
        cursor = QueueCursor()
        moderation._delete_permanently_banned_account(
            cursor,
            user={"id": "user-1", "contact_key": "79990000000", "contact": "+7 999 000-00-00"},
            report_id="11111111-1111-4111-8111-111111111111",
            moderator_id="5893181200",
        )

        sql = "\n".join(cursor.queries)
        self.assertIn("insert into yachat_banned_contacts", sql)
        self.assertIn("delete from yachat_messages", sql)
        self.assertIn("update public_users", sql)
        self.assertIn("deletion_reason = 'permanent_moderation_ban'", sql)
        self.assertNotIn("delete from public_users", sql)

    def test_report_header_contains_reason_and_inline_message(self):
        header = moderation._report_header(
            {
                "id": "11111111-1111-4111-8111-111111111111",
                "kind": "message",
                "reason": "угрозы в личной переписке",
                "reported_display_name": "Нарушитель",
                "reporter_display_name": "Автор",
            },
            "🕓 29.07.2026 · 10:20\n👤 Нарушитель\n\nтекст сообщения",
        )

        self.assertIn("Причина пользователя", header)
        self.assertIn("угрозы в личной переписке", header)
        self.assertIn("<blockquote>", header)
        self.assertNotIn("TXT", header)

    def test_long_transcript_is_split_into_readable_telegram_messages(self):
        transcript = moderation.EVIDENCE_SEPARATOR.join(
            f"🕓 29.07.2026 · 10:{index:02d}\n👤 Пользователь\n\n{'текст ' * 140}"
            for index in range(12)
        )

        chunks = moderation._transcript_chunks(transcript)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) < moderation.TELEGRAM_MESSAGE_LIMIT for chunk in chunks))
        self.assertTrue(all("<blockquote>" in chunk for chunk in chunks))

    def test_report_delivery_uses_messages_and_never_documents(self):
        calls: list[tuple[str, dict]] = []

        def telegram(method, payload):
            calls.append((method, payload))
            if method == "sendMessage":
                return {"result": {"message_id": 10 + len(calls)}}
            return {}

        with (
            patch.object(moderation, "_telegram_api", side_effect=telegram),
            patch.object(moderation, "moderation_chat_id", return_value="5893181200"),
        ):
            delivery = moderation.send_moderation_report(
                {
                    "id": "11111111-1111-4111-8111-111111111111",
                    "kind": "chat",
                    "reason": "спам",
                },
                "🕓 29.07.2026 · 10:20\n👤 Пользователь\n\nсообщение",
            )

        self.assertIsNotNone(delivery)
        self.assertTrue(all(method != "sendDocument" for method, _ in calls))
        self.assertGreaterEqual(sum(method == "sendMessage" for method, _ in calls), 2)


if __name__ == "__main__":
    unittest.main()
