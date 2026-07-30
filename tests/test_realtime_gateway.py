from __future__ import annotations

import json
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from server import realtime_gateway as realtime


class FakeWebSocket:
    def __init__(self, origin: str = "https://yachat.eu.org"):
        self.headers = {"origin": origin}
        self.sent: list[dict] = []
        self.closed: list[int] = []

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self, code=1000):
        self.closed.append(code)


class DisconnectingWebSocket(FakeWebSocket):
    def __init__(self):
        super().__init__()
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def receive_text(self):
        from fastapi import WebSocketDisconnect

        raise WebSocketDisconnect()


class FakeCursor:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query, params=None):
        return None


class FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    @contextmanager
    def cursor(self, row_factory=None):
        yield FakeCursor()


class RealtimeGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_socket_acknowledges_commands_before_upstream_subscriptions_finish(self):
        websocket = DisconnectingWebSocket()

        async def parked_upstream(gateway):
            await gateway.stopped.wait()

        with (
            patch.object(
                realtime,
                "_authenticate_socket",
                new=AsyncMock(
                    return_value=(
                        "session-token",
                        {"id": "self", "display_name": "Я"},
                    )
                ),
            ),
            patch.object(
                realtime.RealtimeGateway,
                "run_upstream",
                new=parked_upstream,
            ),
            patch.object(realtime, "_load_identity", return_value={"id": "self"}),
        ):
            await realtime.realtime_socket(websocket)

        self.assertTrue(websocket.accepted)
        ready = next(frame for frame in websocket.sent if frame["type"] == "ready")
        self.assertEqual(ready["realtimeStatus"], "connecting")

    def test_mark_read_returns_compact_ack_without_reloading_history(self):
        with (
            patch.object(realtime, "ensure_schema", return_value=None),
            patch.object(realtime, "connect_db", return_value=FakeConnection()),
            patch.object(realtime, "_session_user", return_value={"id": "self"}),
            patch.object(realtime, "require_chat_member", return_value={}),
            patch.object(
                realtime,
                "_snapshot",
                side_effect=AssertionError("mark_read must not reload messages"),
            ),
        ):
            result = realtime._execute_command(
                "session-token",
                "mark_read",
                {"chatId": "private-11111111111111111111111111111111"},
            )

        self.assertTrue(result["ok"])
        self.assertEqual(
            result["chatId"],
            "private-11111111111111111111111111111111",
        )
        self.assertIn("readAt", result)

    async def test_message_command_uses_socket_and_prioritizes_active_chat(self):
        websocket = FakeWebSocket()
        gateway = realtime.RealtimeGateway(
            websocket=websocket,
            token="session-token",
            user_id="self",
            display_name="Я",
        )
        gateway.reconcile_topics = AsyncMock()
        messages = [
            {
                "id": "message-1",
                "createdAt": datetime(2026, 7, 30, tzinfo=timezone.utc),
            }
        ]

        with patch.object(realtime, "_execute_command", return_value=messages) as execute:
            await gateway.handle_command(
                {
                    "type": "command",
                    "id": "request-1",
                    "action": "messages",
                    "payload": {
                        "chatId": "private-11111111111111111111111111111111",
                        "limit": 80,
                    },
                }
            )

        execute.assert_called_once()
        gateway.reconcile_topics.assert_awaited_once()
        self.assertEqual(
            gateway.active_chat_id,
            "private-11111111111111111111111111111111",
        )
        self.assertEqual(websocket.sent[0]["type"], "response")
        self.assertTrue(websocket.sent[0]["ok"])
        self.assertEqual(
            websocket.sent[0]["data"][0]["createdAt"],
            "2026-07-30T00:00:00+00:00",
        )

    async def test_offline_presence_uses_stored_recency_without_polling(self):
        websocket = FakeWebSocket()
        gateway = realtime.RealtimeGateway(
            websocket=websocket,
            token="session-token",
            user_id="self",
            display_name="Я",
        )
        gateway.topic_meta["private-1"] = {
            "kind": "private",
            "memberCount": 2,
            "offlineStatus": "long_ago",
        }

        await gateway.push_presence(
            {
                "chatId": "private-1",
                "members": [{"id": "self", "displayName": "Я"}],
            }
        )

        self.assertEqual(websocket.sent[0]["event"], "presence")
        self.assertEqual(websocket.sent[0]["data"]["status"], "long_ago")

    async def test_presence_returns_to_recent_after_peer_disconnects(self):
        websocket = FakeWebSocket()
        gateway = realtime.RealtimeGateway(
            websocket=websocket,
            token="session-token",
            user_id="self",
            display_name="Я",
        )
        gateway.topic_meta["private-1"] = {
            "kind": "private",
            "memberCount": 2,
            "offlineStatus": "long_ago",
        }

        await gateway.push_presence(
            {
                "chatId": "private-1",
                "members": [
                    {"id": "self", "displayName": "Я"},
                    {"id": "peer", "displayName": "Собеседник"},
                ],
            }
        )
        await gateway.push_presence(
            {
                "chatId": "private-1",
                "members": [{"id": "self", "displayName": "Я"}],
            }
        )

        self.assertEqual(websocket.sent[0]["data"]["status"], "online")
        self.assertEqual(websocket.sent[1]["data"]["status"], "recent")

    async def test_large_message_payload_is_chunked_for_video_histories(self):
        websocket = FakeWebSocket()
        gateway = realtime.RealtimeGateway(
            websocket=websocket,
            token="session-token",
            user_id="self",
            display_name="Я",
        )
        payload = {
            "type": "response",
            "id": "large-1",
            "ok": True,
            "data": {"attachment": "A" * (realtime.MAX_OUTBOUND_CHUNK_CHARS * 3)},
        }

        await gateway.send(payload)

        self.assertGreater(len(websocket.sent), 1)
        self.assertTrue(all(frame["type"] == "chunk" for frame in websocket.sent))
        self.assertEqual(
            json.loads("".join(frame["data"] for frame in websocket.sent)),
            payload,
        )

    async def test_inactive_chat_event_refreshes_list_without_reloading_history(self):
        websocket = FakeWebSocket()
        gateway = realtime.RealtimeGateway(
            websocket=websocket,
            token="session-token",
            user_id="self",
            display_name="Я",
            active_chat_id="private-11111111111111111111111111111111",
        )
        chats = [{"id": "private-22222222222222222222222222222222"}]

        with patch.object(realtime, "_execute_command", return_value=chats) as execute:
            gateway.schedule_refresh(
                chat_id="private-22222222222222222222222222222222"
            )
            await gateway.refresh_task

        self.assertEqual(execute.call_args.args[1], "chats")
        self.assertEqual(websocket.sent[0]["event"], "chats")
        self.assertEqual(websocket.sent[0]["data"], chats)

    async def test_cleanup_runs_after_session_invalidation_sets_stop_flag(self):
        websocket = FakeWebSocket()
        gateway = realtime.RealtimeGateway(
            websocket=websocket,
            token="session-token",
            user_id="self",
            display_name="Я",
        )
        gateway.stopped.set()
        gateway.close_upstream = AsyncMock()

        with patch.object(realtime, "_load_identity", return_value={"id": "self"}):
            await gateway.stop()

        self.assertTrue(gateway.cleaned)
        gateway.close_upstream.assert_awaited_once()

    def test_canonical_web_origin_is_allowed(self):
        self.assertTrue(realtime._origin_allowed(FakeWebSocket()))
        self.assertFalse(
            realtime._origin_allowed(FakeWebSocket("https://attacker.example"))
        )


if __name__ == "__main__":
    unittest.main()
