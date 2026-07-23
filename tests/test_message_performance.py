from __future__ import annotations

import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import BackgroundTasks

import api.message as message_api


class FakeCursor:
    def __init__(self, mode: str):
        self.mode = mode
        self.queries: list[str] = []
        self.current = ""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, query, params=None):
        self.current = " ".join(str(query).lower().split())
        self.queries.append(self.current)

    def executemany(self, query, rows):
        self.current = " ".join(str(query).lower().split())
        self.queries.append(self.current)

    def fetchone(self):
        if "insert into yachat_messages" in self.current:
            return {
                "id": "11111111-1111-4111-8111-111111111111",
                "chat_id": "chat-1",
                "sender_id": "self",
                "text": "быстро",
                "formatted_html": "<strong>быстро</strong>",
                "attachments": [],
                "created_at": "2026-07-23T00:00:00Z",
            }
        return None

    def fetchall(self):
        if "select user_id from yachat_chat_members" in self.current:
            return [{"user_id": "peer"}]
        if "select id, sender_id from yachat_messages" in self.current:
            return [{"id": "m1", "sender_id": "self"}]
        if "select m.id from yachat_messages m" in self.current:
            return [{"id": "m1"}] if self.mode == "delete-self" else []
        if "delete from yachat_messages" in self.current and "returning id" in self.current:
            return [{"id": "m1"}]
        return []


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


class MessagePerformanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_returns_compact_ack_and_queues_push(self):
        cursor = FakeCursor("send")
        tasks = BackgroundTasks()
        payload = {
            "chatId": "chat-1",
            "clientMessageId": "11111111-1111-4111-8111-111111111111",
            "text": "быстро",
            "formattedHtml": "<strong>быстро</strong>",
            "attachments": [],
        }
        user = {"id": "self", "username": "self", "display_name": "Я"}
        chat = {"id": "chat-1", "kind": "private", "can_send": True, "title": ""}

        with (
            patch.object(message_api, "require_user", return_value=user),
            patch.object(message_api, "read_json_payload", return_value=payload),
            patch.object(message_api, "clean_chat_id", return_value="chat-1"),
            patch.object(message_api, "prepare_rich_message", return_value=("<strong>быстро</strong>", "быстро")),
            patch.object(message_api, "clean_attachments", return_value=[]),
            patch.object(message_api, "connect_db", return_value=FakeConnection(cursor)),
            patch.object(message_api, "require_chat_member", return_value=chat),
            patch.object(message_api, "require_chat_messaging_allowed", return_value=None),
            patch.object(message_api, "message_payload", side_effect=lambda row, user_id: {
                "id": row["id"],
                "chatId": row["chat_id"],
                "text": row["text"],
                "formattedHtml": row["formatted_html"],
            }),
        ):
            result = await message_api.send_message(object(), tasks)

        self.assertTrue(result["ok"])
        self.assertEqual(result["message"]["text"], "быстро")
        self.assertEqual(result["message"]["formattedHtml"], "<strong>быстро</strong>")
        self.assertNotIn("chats", result)
        self.assertNotIn("messages", result)
        self.assertEqual(result["pushQueued"], 1)
        self.assertEqual(len(tasks.tasks), 1)
        self.assertTrue(any("with touched_chat as" in query for query in cursor.queries))

    async def test_delete_for_everyone_physically_deletes_rows(self):
        cursor = FakeCursor("delete-everyone")
        payload = {"chatId": "chat-1", "messageIds": ["m1"], "scope": "everyone"}
        with (
            patch.object(message_api, "require_user", return_value={"id": "self"}),
            patch.object(message_api, "read_json_payload", return_value=payload),
            patch.object(message_api, "clean_chat_id", return_value="chat-1"),
            patch.object(message_api, "connect_db", return_value=FakeConnection(cursor)),
            patch.object(message_api, "resolve_message_chat_id", return_value="chat-1"),
            patch.object(message_api, "require_chat_member", return_value={"id": "chat-1"}),
        ):
            result = await message_api.delete_message(object())

        self.assertEqual(result["physicallyDeletedIds"], ["m1"])
        self.assertTrue(any(query.startswith("delete from yachat_messages") for query in cursor.queries))
        self.assertFalse(any("set deleted_at" in query for query in cursor.queries))
        self.assertNotIn("chats", result)
        self.assertNotIn("messages", result)

    async def test_delete_for_self_collects_message_after_every_member_hides_it(self):
        cursor = FakeCursor("delete-self")
        payload = {"chatId": "chat-1", "messageIds": ["m1"], "scope": "self"}
        with (
            patch.object(message_api, "require_user", return_value={"id": "self"}),
            patch.object(message_api, "read_json_payload", return_value=payload),
            patch.object(message_api, "clean_chat_id", return_value="chat-1"),
            patch.object(message_api, "connect_db", return_value=FakeConnection(cursor)),
            patch.object(message_api, "resolve_message_chat_id", return_value="chat-1"),
            patch.object(message_api, "require_chat_member", return_value={"id": "chat-1"}),
        ):
            result = await message_api.delete_message(object())

        self.assertEqual(result["physicallyDeletedIds"], ["m1"])
        self.assertTrue(any("insert into yachat_message_hidden" in query for query in cursor.queries))
        self.assertTrue(any(query.startswith("delete from yachat_messages") for query in cursor.queries))


if __name__ == "__main__":
    unittest.main()
