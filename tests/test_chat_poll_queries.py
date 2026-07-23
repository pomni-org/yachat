from __future__ import annotations

import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

import api.chat_poll as chat_poll_api


class FakeCursor:
    def __init__(self):
        self.queries: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, query, params=None):
        self.queries.append(" ".join(str(query).lower().split()))

    def fetchall(self):
        return [
            {
                "id": "chat-1",
                "kind": "private",
                "title": "",
                "owner_id": "self",
                "locked": False,
                "pinned": False,
                "can_send": True,
                "created_at": "2026-07-23T00:00:00Z",
                "updated_at": "2026-07-23T00:01:00Z",
                "members": [
                    {
                        "id": "self",
                        "username": "self",
                        "preview_name": "Я",
                        "display_name": "Я",
                    },
                    {
                        "id": "peer",
                        "username": "peer",
                        "preview_name": "Собеседник",
                        "display_name": "Собеседник",
                    },
                ],
                "latest_text": "быстрый ответ",
                "latest_created_at": "2026-07-23T00:02:00Z",
                "attachment_kind": "",
                "unread_count": 2,
                "blocked_by_me": False,
                "blocked_me": False,
            }
        ]


class FakeConnection:
    def __init__(self, cursor: FakeCursor):
        self.fake_cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    @contextmanager
    def cursor(self, row_factory=None):
        yield self.fake_cursor


class ChatPollQueryTests(unittest.TestCase):
    def test_regular_chats_are_loaded_in_one_query(self):
        cursor = FakeCursor()
        systems = [{"id": "yachat-favorites", "kind": "saved"}]

        with (
            patch.object(chat_poll_api, "ensure_schema", return_value=None),
            patch.object(chat_poll_api, "system_rows", return_value=systems),
        ):
            result = chat_poll_api.poll_chats("self", connection=FakeConnection(cursor))

        self.assertEqual(len(cursor.queries), 1)
        query = cursor.queries[0]
        self.assertIn("left join lateral", query)
        self.assertIn("jsonb_agg", query)
        self.assertIn("unread_count", query)
        self.assertIn("yachat_user_blocks", query)

        chat = result[1]
        self.assertEqual(chat["id"], "chat-1")
        self.assertEqual(chat["title"], "Собеседник")
        self.assertEqual(chat["subtitle"], "@peer")
        self.assertEqual(chat["participantIds"], ["self", "peer"])
        self.assertEqual(chat["lastMessage"], "быстрый ответ")
        self.assertEqual(chat["unread"], 2)
        self.assertTrue(chat["canSend"])

    def test_json_member_payload_accepts_driver_and_text_forms(self):
        members = [{"id": "peer", "username": "peer"}]
        self.assertEqual(chat_poll_api._json_list(members), members)
        self.assertEqual(chat_poll_api._json_list(json.dumps(members)), members)
        self.assertEqual(chat_poll_api._json_list("not-json"), [])


if __name__ == "__main__":
    unittest.main()
