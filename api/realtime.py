"""Authenticated WebSocket transport for YaChat messenger state.

The browser opens one WebSocket to this endpoint. Database mutations are fanned
out between Vercel instances through Supabase Broadcast, while all durable reads
still pass through the existing YaChat authorization and serializers.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from psycopg.rows import dict_row
from realtime import (
    AsyncRealtimeChannel,
    AsyncRealtimeClient,
    RealtimeSubscribeStates,
)

from api.index import (
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    ensure_schema,
    hash_secret,
    normalize_username,
    require_chat_member,
)
from api.messenger_fast import _snapshot, get_messages_fast, list_user_chats_fast


DEFAULT_SUPABASE_URL = "https://uptlvqtlrgdkixjmmrwd.supabase.co"
DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_MhMy_eycXuY0mMT_o4z5LQ_aIVGhqpK"
AUTH_TIMEOUT_SECONDS = 8
COMMAND_TIMEOUT_SECONDS = 20
MAX_FRAME_BYTES = 32 * 1024
MAX_OUTBOUND_CHUNK_CHARS = 32 * 1024
MAX_CHAT_CHANNELS = 96
REFRESH_DEBOUNCE_SECONDS = 0.055
COMMAND_RATE_LIMIT = 80
COMMAND_RATE_WINDOW_SECONDS = 10
PRESENCE_TOUCH_INTERVAL_SECONDS = 300
UPSTREAM_HEALTH_INTERVAL_SECONDS = 5
UPSTREAM_EVENTS = (
    "access_changed",
    "chat_changed",
    "chat_deleted",
    "chats_changed",
    "profile_changed",
    "receipt_changed",
    "system_changed",
    "typing",
)


app = FastAPI(title="YaChat WebSocket API", version="1.0.0")


def _supabase_realtime_url() -> str:
    project_url = next(
        (
            value.strip()
            for value in (
                os.getenv("SUPABASE_URL"),
                os.getenv("SUPABASE_PROJECT_URL"),
                DEFAULT_SUPABASE_URL,
            )
            if value and value.strip()
        ),
        DEFAULT_SUPABASE_URL,
    ).rstrip("/")
    return f"{project_url}/realtime/v1"


def _supabase_publishable_key() -> str:
    return next(
        (
            value.strip()
            for value in (
                os.getenv("SUPABASE_PUBLISHABLE_KEY"),
                os.getenv("SUPABASE_ANON_KEY"),
                DEFAULT_SUPABASE_PUBLISHABLE_KEY,
            )
            if value and value.strip()
        ),
        DEFAULT_SUPABASE_PUBLISHABLE_KEY,
    )


def _origin_allowed(websocket: WebSocket) -> bool:
    origin = str(websocket.headers.get("origin") or "").strip().rstrip("/")
    if not origin:
        return False
    return origin in {item.rstrip("/") for item in configured_cors_origins()}


def _session_user(cursor, token: str) -> dict[str, Any]:
    cursor.execute(
        """
        select u.*
        from yachat_sessions s
        join public_users u on u.id = s.user_id
        where s.token_hash = %s
          and s.expires_at > now()
          and u.deleted_at is null
        limit 1
        """,
        (hash_secret(token),),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Sign in first.")
    return dict(row)


def _touch_presence(cursor, user_id: str) -> None:
    cursor.execute(
        """
        insert into yachat_user_presence(user_id, last_seen_at, updated_at)
        values (%s, now(), now())
        on conflict(user_id) do update
        set last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        """,
        (user_id,),
    )


def _load_identity(token: str, *, touch_presence: bool = False) -> dict[str, Any]:
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            user = _session_user(cursor, token)
            if touch_presence:
                _touch_presence(cursor, str(user["id"]))
            return user


def _load_topics(token: str, active_chat_id: str = "") -> dict[str, Any]:
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            user = _session_user(cursor, token)
            user_id = str(user["id"])
            _touch_presence(cursor, user_id)
            cursor.execute(
                """
                select
                    c.id,
                    c.kind,
                    c.realtime_topic_key,
                    c.updated_at,
                    count(all_members.user_id)::integer as member_count,
                    max(peer_presence.last_seen_at) as peer_last_seen_at
                from yachat_chats c
                join yachat_chat_members own_member
                  on own_member.chat_id = c.id
                 and own_member.user_id = %s
                join yachat_chat_members all_members
                  on all_members.chat_id = c.id
                left join yachat_user_presence peer_presence
                  on peer_presence.user_id = all_members.user_id
                 and all_members.user_id <> %s
                where c.kind <> 'saved'
                group by
                    c.id,
                    c.kind,
                    c.realtime_topic_key,
                    c.updated_at
                order by
                    (c.id = %s) desc,
                    c.updated_at desc,
                    c.id
                """,
                (user_id, user_id, active_chat_id),
            )
            chats = []
            now = datetime.now(timezone.utc)
            for row in cursor.fetchall():
                if not row.get("realtime_topic_key"):
                    continue
                last_seen = row.get("peer_last_seen_at")
                if last_seen and last_seen.tzinfo is None:
                    last_seen = last_seen.replace(tzinfo=timezone.utc)
                offline_status = (
                    "recent"
                    if last_seen and now - last_seen <= timedelta(days=7)
                    else "long_ago"
                )
                chats.append(
                    {
                        "id": str(row["id"]),
                        "kind": str(row["kind"]),
                        "topic": f"yachat:chat:{row['realtime_topic_key']}",
                        "memberCount": int(row["member_count"] or 0),
                        "offlineStatus": offline_status,
                    }
                )
            return {
                "userId": user_id,
                "displayName": str(
                    user.get("display_name")
                    or user.get("preview_name")
                    or user.get("username")
                    or "ЯЧат"
                ),
                "userTopic": f"yachat:user:{user['realtime_event_key']}",
                "chats": chats,
            }


def _execute_command(token: str, action: str, payload: dict[str, Any]) -> Any:
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            user = _session_user(cursor, token)
            user_id = str(user["id"])

            if action in {"snapshot", "sync"}:
                chat_id = clean_chat_id(payload.get("chatId"), allow_empty=True)
                username = normalize_username(payload.get("username"))
                return _snapshot(
                    user_id,
                    chat_id,
                    username,
                    message_limit=80,
                    connection=connection,
                )

            if action == "chats":
                return list_user_chats_fast(user_id, connection=connection)

            if action == "messages":
                chat_id = clean_chat_id(payload.get("chatId"))
                limit = max(1, min(int(payload.get("limit") or 80), 150))
                after = str(payload.get("after") or "").strip()
                return get_messages_fast(
                    chat_id,
                    user_id,
                    limit=limit,
                    after=after,
                    connection=connection,
                )

            if action == "mark_read":
                chat_id = clean_chat_id(payload.get("chatId"))
                if not chat_id.startswith("yachat-"):
                    require_chat_member(cursor, chat_id, user_id)
                    cursor.execute(
                        """
                        update yachat_chat_members
                        set last_read_at = now()
                        where chat_id = %s and user_id = %s
                        """,
                        (chat_id, user_id),
                    )
                return {
                    "ok": True,
                    "chatId": chat_id,
                    "readAt": datetime.now(timezone.utc),
                }

    raise HTTPException(status_code=400, detail="Unsupported realtime action.")


def _public_error(error: Exception) -> tuple[int, str]:
    if isinstance(error, HTTPException):
        return int(error.status_code), str(error.detail)
    if isinstance(error, (ValueError, TypeError)):
        return 400, "Invalid realtime request."
    return 500, "Realtime operation failed."


def _presence_members(channel: AsyncRealtimeChannel) -> list[dict[str, str]]:
    members: dict[str, dict[str, str]] = {}
    for key, entries in channel.presence_state().items():
        for entry in entries:
            user_id = str(entry.get("userId") or key or "")
            if not user_id:
                continue
            members[user_id] = {
                "id": user_id,
                "displayName": str(entry.get("displayName") or ""),
            }
    return list(members.values())


@dataclass
class RealtimeGateway:
    websocket: WebSocket
    token: str
    user_id: str
    display_name: str
    active_chat_id: str = ""
    upstream: AsyncRealtimeClient | None = None
    user_channel: AsyncRealtimeChannel | None = None
    chat_channels: dict[str, AsyncRealtimeChannel] = field(default_factory=dict)
    topic_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    events: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    stopped: asyncio.Event = field(default_factory=asyncio.Event)
    upstream_ready: asyncio.Event = field(default_factory=asyncio.Event)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    reconcile_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    command_hits: deque[float] = field(default_factory=deque)
    last_presence_touch_at: float = field(default_factory=time.monotonic)
    refresh_task: asyncio.Task[None] | None = None
    upstream_task: asyncio.Task[None] | None = None
    relay_task: asyncio.Task[None] | None = None
    needs_reconcile: bool = False
    refresh_requested: bool = False
    refresh_needs_full: bool = False
    refresh_chat_ids: set[str] = field(default_factory=set)
    needs_upstream_catchup: bool = False
    cleaned: bool = False

    async def send(self, payload: dict[str, Any]) -> None:
        if self.stopped.is_set():
            return
        encoded = jsonable_encoder(payload)
        serialized = json.dumps(
            encoded,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        async with self.send_lock:
            if len(serialized) <= MAX_OUTBOUND_CHUNK_CHARS:
                await self.websocket.send_json(encoded)
                return
            chunk_id = secrets.token_urlsafe(12)
            chunks = [
                serialized[index:index + MAX_OUTBOUND_CHUNK_CHARS]
                for index in range(0, len(serialized), MAX_OUTBOUND_CHUNK_CHARS)
            ]
            for index, chunk in enumerate(chunks):
                await self.websocket.send_json(
                    {
                        "type": "chunk",
                        "chunkId": chunk_id,
                        "index": index,
                        "total": len(chunks),
                        "data": chunk,
                    }
                )

    def enforce_rate_limit(self) -> None:
        now = time.monotonic()
        cutoff = now - COMMAND_RATE_WINDOW_SECONDS
        while self.command_hits and self.command_hits[0] < cutoff:
            self.command_hits.popleft()
        if len(self.command_hits) >= COMMAND_RATE_LIMIT:
            raise HTTPException(status_code=429, detail="Too many realtime commands.")
        self.command_hits.append(now)

    async def refresh_identity_if_due(self) -> None:
        now = time.monotonic()
        if now - self.last_presence_touch_at < PRESENCE_TOUCH_INTERVAL_SECONDS:
            return
        await asyncio.to_thread(_load_identity, self.token, touch_presence=True)
        self.last_presence_touch_at = now

    def enqueue(self, payload: dict[str, Any]) -> None:
        if not self.stopped.is_set():
            self.events.put_nowait(payload)

    def broadcast_callback(
        self,
        chat_id: str,
        event_name: str,
    ) -> Callable[[dict[str, Any]], None]:
        def callback(packet: dict[str, Any]) -> None:
            self.enqueue(
                {
                    "kind": "broadcast",
                    "chatId": chat_id,
                    "event": event_name,
                    "data": dict(packet.get("payload") or {}),
                }
            )

        return callback

    def presence_callback(
        self,
        chat_id: str,
        channel: AsyncRealtimeChannel,
    ) -> Callable[[], None]:
        def callback() -> None:
            self.enqueue(
                {
                    "kind": "presence",
                    "chatId": chat_id,
                    "members": _presence_members(channel),
                }
            )

        return callback

    async def subscribe_channel(
        self,
        channel: AsyncRealtimeChannel,
        *,
        track_presence: bool,
    ) -> None:
        subscribed = asyncio.get_running_loop().create_future()

        def on_subscribe(
            state: RealtimeSubscribeStates,
            error: Exception | None,
        ) -> None:
            if subscribed.done():
                return
            if state == RealtimeSubscribeStates.SUBSCRIBED:
                subscribed.set_result(None)
            elif state in {
                RealtimeSubscribeStates.CHANNEL_ERROR,
                RealtimeSubscribeStates.TIMED_OUT,
                RealtimeSubscribeStates.CLOSED,
            }:
                subscribed.set_exception(error or RuntimeError(str(state)))

        await channel.subscribe(on_subscribe)
        await asyncio.wait_for(subscribed, timeout=8)
        if track_presence:
            await channel.track(
                {
                    "userId": self.user_id,
                    "displayName": self.display_name,
                    "connectedAt": datetime.now(timezone.utc).isoformat(),
                }
            )

    async def subscribe_user_topic(self, topic: str) -> None:
        if not self.upstream:
            return
        channel = self.upstream.channel(
            topic,
            {
                "config": {
                    "broadcast": {"ack": False, "self": False},
                    "presence": {"key": "", "enabled": False},
                    "private": False,
                }
            },
        )
        for event_name in UPSTREAM_EVENTS:
            channel.on_broadcast(
                event_name,
                self.broadcast_callback("", event_name),
            )
        await self.subscribe_channel(channel, track_presence=False)
        self.user_channel = channel

    async def subscribe_chat(self, meta: dict[str, Any]) -> None:
        if not self.upstream:
            return
        chat_id = str(meta["id"])
        track_presence = str(meta.get("kind") or "") == "private"
        channel = self.upstream.channel(
            str(meta["topic"]),
            {
                "config": {
                    "broadcast": {"ack": False, "self": False},
                    "presence": {
                        "key": self.user_id if track_presence else "",
                        "enabled": track_presence,
                    },
                    "private": False,
                }
            },
        )
        for event_name in UPSTREAM_EVENTS:
            channel.on_broadcast(
                event_name,
                self.broadcast_callback(chat_id, event_name),
            )
        if track_presence:
            channel.on_presence_sync(self.presence_callback(chat_id, channel))
        await self.subscribe_channel(channel, track_presence=track_presence)
        self.chat_channels[chat_id] = channel

    async def reconcile_topics(self, snapshot: dict[str, Any] | None = None) -> None:
        async with self.reconcile_lock:
            if not self.upstream:
                return
            if snapshot is None:
                snapshot = await asyncio.to_thread(
                    _load_topics,
                    self.token,
                    self.active_chat_id,
                )
            self.display_name = str(snapshot["displayName"])
            ordered = list(snapshot["chats"])
            if self.active_chat_id:
                ordered.sort(
                    key=lambda item: str(item["id"]) != self.active_chat_id
                )
            desired = {
                str(item["id"]): item
                for item in ordered[:MAX_CHAT_CHANNELS]
            }
            self.topic_meta = desired

            for chat_id in list(self.chat_channels):
                current = self.chat_channels[chat_id]
                desired_meta = desired.get(chat_id)
                current_topic = current.topic.removeprefix("realtime:")
                if desired_meta and current_topic == desired_meta["topic"]:
                    continue
                with suppress(Exception):
                    await self.upstream.remove_channel(current)
                self.chat_channels.pop(chat_id, None)

            missing = [
                meta
                for chat_id, meta in desired.items()
                if chat_id not in self.chat_channels
            ]
            for index in range(0, len(missing), 16):
                await asyncio.gather(
                    *(self.subscribe_chat(meta) for meta in missing[index:index + 16])
                )

    async def close_upstream(self) -> None:
        upstream = self.upstream
        self.upstream = None
        self.user_channel = None
        channels = list(self.chat_channels.values())
        self.chat_channels.clear()
        self.topic_meta.clear()
        if not upstream:
            return
        for channel in channels:
            with suppress(Exception):
                await channel.untrack()
            with suppress(Exception):
                await upstream.remove_channel(channel)
        with suppress(Exception):
            await upstream.close()

    async def run_upstream(self) -> None:
        retry_delay = 1.0
        while not self.stopped.is_set():
            try:
                self.upstream_ready.clear()
                self.upstream = AsyncRealtimeClient(
                    _supabase_realtime_url(),
                    token=_supabase_publishable_key(),
                    auto_reconnect=True,
                    max_retries=6,
                    initial_backoff=0.8,
                    timeout=10,
                )
                topics = await asyncio.to_thread(
                    _load_topics,
                    self.token,
                    self.active_chat_id,
                )
                self.display_name = str(topics["displayName"])
                await self.subscribe_user_topic(str(topics["userTopic"]))
                await self.reconcile_topics(topics)
                retry_delay = 1.0
                self.upstream_ready.set()
                self.enqueue({"kind": "status", "status": "ready"})
                if self.needs_upstream_catchup:
                    self.needs_upstream_catchup = False
                    self.schedule_refresh()
                while not self.stopped.is_set():
                    try:
                        await asyncio.wait_for(
                            self.stopped.wait(),
                            timeout=UPSTREAM_HEALTH_INTERVAL_SECONDS,
                        )
                    except TimeoutError:
                        if not self.upstream or not self.upstream.is_connected:
                            raise RuntimeError("Realtime upstream disconnected.")
            except asyncio.CancelledError:
                raise
            except Exception:
                self.upstream_ready.clear()
                self.enqueue({"kind": "status", "status": "degraded"})
                await self.close_upstream()
                if self.stopped.is_set():
                    break
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 20)

    async def publish_typing(self, chat_id: str, typing: bool) -> dict[str, Any]:
        if not chat_id or chat_id.startswith("yachat-"):
            return {"ok": True, "chatId": chat_id, "typing": False}
        channel = self.chat_channels.get(chat_id)
        if not channel:
            self.active_chat_id = chat_id
            await self.reconcile_topics()
            channel = self.chat_channels.get(chat_id)
        if not channel:
            raise HTTPException(status_code=403, detail="Chat access denied.")
        await channel.send_broadcast(
            "typing",
            {
                "chatId": chat_id,
                "userId": self.user_id,
                "displayName": self.display_name,
                "typing": bool(typing),
                "at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {"ok": True, "chatId": chat_id, "typing": bool(typing)}

    async def push_presence(self, event: dict[str, Any]) -> None:
        chat_id = str(event.get("chatId") or "")
        meta = self.topic_meta.get(chat_id) or {}
        members = list(event.get("members") or [])
        peer_online = any(str(item.get("id") or "") != self.user_id for item in members)
        if peer_online:
            meta["offlineStatus"] = "recent"
        await self.send(
            {
                "type": "event",
                "event": "presence",
                "data": {
                    "chatId": chat_id,
                    "status": "online"
                    if str(meta.get("kind")) == "private" and peer_online
                    else str(meta.get("offlineStatus") or "long_ago"),
                    "members": members,
                    "subscriberCount": int(meta.get("memberCount") or 0),
                },
            }
        )

    def schedule_refresh(
        self,
        *,
        reconcile: bool = False,
        chat_id: str = "",
    ) -> None:
        self.refresh_requested = True
        self.needs_reconcile = self.needs_reconcile or reconcile
        if chat_id:
            self.refresh_chat_ids.add(chat_id)
        else:
            self.refresh_needs_full = True
        if self.refresh_task and not self.refresh_task.done():
            return
        self.refresh_task = asyncio.create_task(self.push_snapshot_after_events())

    async def push_snapshot_after_events(self) -> None:
        try:
            await asyncio.sleep(REFRESH_DEBOUNCE_SECONDS)
            while self.refresh_requested and not self.stopped.is_set():
                self.refresh_requested = False
                reconcile = self.needs_reconcile
                self.needs_reconcile = False
                affected_chat_ids = set(self.refresh_chat_ids)
                self.refresh_chat_ids.clear()
                needs_full = (
                    self.refresh_needs_full
                    or not self.active_chat_id
                    or self.active_chat_id in affected_chat_ids
                )
                self.refresh_needs_full = False

                if reconcile:
                    await self.reconcile_topics()
                if needs_full:
                    data = await asyncio.to_thread(
                        _execute_command,
                        self.token,
                        "snapshot",
                        {"chatId": self.active_chat_id},
                    )
                    event_name = "snapshot"
                else:
                    data = await asyncio.to_thread(
                        _execute_command,
                        self.token,
                        "chats",
                        {},
                    )
                    event_name = "chats"
                await self.send(
                    {
                        "type": "event",
                        "event": event_name,
                        "data": data,
                    }
                )
        except asyncio.CancelledError:
            raise
        except HTTPException as error:
            if error.status_code == 401:
                with suppress(Exception):
                    await self.websocket.close(code=4401)
                self.stopped.set()
        except Exception:
            await self.send(
                {
                    "type": "event",
                    "event": "status",
                    "data": {"status": "degraded"},
                }
            )
        finally:
            if self.refresh_task is asyncio.current_task():
                self.refresh_task = None
            if self.refresh_requested and not self.stopped.is_set():
                self.refresh_task = asyncio.create_task(self.push_snapshot_after_events())

    async def relay_events(self) -> None:
        while not self.stopped.is_set():
            event = await self.events.get()
            kind = str(event.get("kind") or "")
            if kind == "status":
                await self.send(
                    {
                        "type": "event",
                        "event": "status",
                        "data": {"status": str(event.get("status") or "degraded")},
                    }
                )
                continue
            if kind == "presence":
                await self.push_presence(event)
                continue

            event_name = str(event.get("event") or "")
            data = dict(event.get("data") or {})
            chat_id = str(event.get("chatId") or data.get("chatId") or "")
            if event_name == "typing":
                data.setdefault("chatId", chat_id)
                await self.send(
                    {
                        "type": "event",
                        "event": "typing",
                        "data": data,
                    }
                )
                continue

            self.schedule_refresh(
                reconcile=(
                    event_name in {"access_changed", "chat_deleted"}
                    or (
                        event_name == "chats_changed"
                        and str(data.get("entity") or "") == "membership"
                    )
                ),
                chat_id=chat_id,
            )

    async def handle_command(self, frame: dict[str, Any]) -> None:
        request_id = str(frame.get("id") or "")[:80]
        action = str(frame.get("action") or "")[:64]
        payload = frame.get("payload")
        payload = dict(payload) if isinstance(payload, dict) else {}
        try:
            self.enforce_rate_limit()
            if action == "ping":
                await self.refresh_identity_if_due()
                data: Any = {
                    "ok": True,
                    "serverTime": datetime.now(timezone.utc),
                }
            elif action == "typing":
                chat_id = clean_chat_id(payload.get("chatId"))
                data = await self.publish_typing(chat_id, bool(payload.get("typing")))
            elif action == "set_active":
                self.active_chat_id = clean_chat_id(
                    payload.get("chatId"),
                    allow_empty=True,
                )
                if (
                    self.active_chat_id
                    and not self.active_chat_id.startswith("yachat-")
                    and self.active_chat_id not in self.chat_channels
                ):
                    await self.reconcile_topics()
                data = {"ok": True, "chatId": self.active_chat_id}
            else:
                if (
                    action in {"snapshot", "sync", "chats", "messages", "mark_read"}
                    and not self.upstream_ready.is_set()
                ):
                    self.needs_upstream_catchup = True
                data = await asyncio.wait_for(
                    asyncio.to_thread(
                        _execute_command,
                        self.token,
                        action,
                        payload,
                    ),
                    timeout=COMMAND_TIMEOUT_SECONDS,
                )
                if action in {"snapshot", "sync", "messages", "mark_read"}:
                    requested_chat_id = str(payload.get("chatId") or "")
                    if requested_chat_id and requested_chat_id != self.active_chat_id:
                        self.active_chat_id = requested_chat_id
                        if (
                            not requested_chat_id.startswith("yachat-")
                            and requested_chat_id not in self.chat_channels
                        ):
                            await self.reconcile_topics()
            if request_id:
                await self.send(
                    {
                        "type": "response",
                        "id": request_id,
                        "ok": True,
                        "data": data,
                    }
                )
        except Exception as error:
            status_code, detail = _public_error(error)
            if request_id:
                await self.send(
                    {
                        "type": "response",
                        "id": request_id,
                        "ok": False,
                        "error": detail,
                        "status": status_code,
                    }
                )
            if status_code == 401:
                with suppress(Exception):
                    await self.websocket.close(code=4401)
                self.stopped.set()

    async def stop(self) -> None:
        if self.cleaned:
            return
        self.cleaned = True
        self.stopped.set()
        if self.refresh_task:
            self.refresh_task.cancel()
        await self.close_upstream()
        for task in (self.refresh_task, self.upstream_task, self.relay_task):
            if task and task is not asyncio.current_task():
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
        with suppress(Exception):
            await asyncio.to_thread(_load_identity, self.token, touch_presence=True)


async def _authenticate_socket(websocket: WebSocket) -> tuple[str, dict[str, Any]]:
    raw = await asyncio.wait_for(
        websocket.receive_text(),
        timeout=AUTH_TIMEOUT_SECONDS,
    )
    if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="Realtime frame is too large.")
    try:
        frame = json.loads(raw)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=400, detail="Invalid realtime frame.") from error
    if not isinstance(frame, dict) or frame.get("type") != "auth":
        raise HTTPException(status_code=401, detail="Realtime authentication required.")
    token = str(frame.get("token") or "").strip()
    if not token or len(token) > 512:
        raise HTTPException(status_code=401, detail="Realtime authentication required.")
    user = await asyncio.to_thread(_load_identity, token, touch_presence=True)
    return token, user


@app.websocket("/api/realtime")
async def realtime_socket(websocket: WebSocket) -> None:
    if not _origin_allowed(websocket):
        await websocket.close(code=4403)
        return

    await websocket.accept()
    gateway: RealtimeGateway | None = None
    try:
        token, user = await _authenticate_socket(websocket)
        gateway = RealtimeGateway(
            websocket=websocket,
            token=token,
            user_id=str(user["id"]),
            display_name=str(
                user.get("display_name")
                or user.get("preview_name")
                or user.get("username")
                or "ЯЧат"
            ),
        )
        gateway.relay_task = asyncio.create_task(gateway.relay_events())
        gateway.upstream_task = asyncio.create_task(gateway.run_upstream())
        await gateway.send(
            {
                "type": "ready",
                "protocol": 1,
                "transport": "websocket",
                "realtimeStatus": "connecting",
            }
        )

        while not gateway.stopped.is_set():
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
                await websocket.close(code=4400)
                break
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await gateway.send(
                    {
                        "type": "error",
                        "status": 400,
                        "error": "Invalid realtime frame.",
                    }
                )
                continue
            if not isinstance(frame, dict) or frame.get("type") != "command":
                continue
            await gateway.handle_command(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except HTTPException as error:
        with suppress(Exception):
            await websocket.send_json(
                {
                    "type": "error",
                    "status": int(error.status_code),
                    "error": str(error.detail),
                }
            )
            await websocket.close(code=4401 if error.status_code == 401 else 4400)
    except Exception:
        with suppress(Exception):
            await websocket.send_json(
                {
                    "type": "error",
                    "status": 500,
                    "error": "Realtime connection failed.",
                }
            )
            await websocket.close(code=1011)
    finally:
        if gateway:
            await gateway.stop()
