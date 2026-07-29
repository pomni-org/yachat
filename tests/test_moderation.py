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

    def test_permanent_ban_marks_contact_and_deletes_account_data(self):
        cursor = QueueCursor()
        moderation._delete_permanently_banned_account(
            cursor,
            user={"id": "user-1", "contact_key": "79990000000", "contact": "+7 999 000-00-00"},
            report_id="11111111-1111-4111-8111-111111111111",
            moderator_id="5893181200",
        )

        sql = "\n".join(cursor.queries)
        self.assertIn("insert into yachat_banned_contacts", sql)
        self.assertIn("delete from yachat_messages where sender_id", sql)
        self.assertIn("delete from public_users where id", sql)


if __name__ == "__main__":
    unittest.main()
