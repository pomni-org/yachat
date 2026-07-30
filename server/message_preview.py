from __future__ import annotations

import json
from typing import Any


PHOTO_PREVIEW = "📷 Фото"
VIDEO_PREVIEW = "📹 Видео"
EMOJI_PREVIEW = "😀 Эмодзи"
ATTACHMENTS_PREVIEW = "🗂️ Вложения"


def _attachment_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [dict(item) for item in value if isinstance(item, dict)]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list):
            return [dict(item) for item in parsed if isinstance(item, dict)]
    return []


def _attachment_kind(attachment: dict[str, Any]) -> str:
    kind = str(attachment.get("kind") or "").strip().lower()
    mime = str(
        attachment.get("mime")
        or attachment.get("type")
        or attachment.get("dataMime")
        or ""
    ).strip().lower()
    if kind in {"image", "photo"} or mime.startswith("image/"):
        return "image"
    if kind in {"video", "movie"} or mime.startswith("video/"):
        return "video"
    return "file"


def attachment_preview(attachments: Any) -> str:
    items = _attachment_list(attachments)
    if not items:
        return ""
    kinds = {_attachment_kind(item) for item in items}
    if kinds == {"image"}:
        return PHOTO_PREVIEW
    if kinds == {"video"}:
        return VIDEO_PREVIEW
    return ATTACHMENTS_PREVIEW


def _emoji_base(codepoint: int) -> bool:
    return (
        0x1F000 <= codepoint <= 0x1FAFF
        or 0x2600 <= codepoint <= 0x27BF
        or codepoint
        in {
            0x00A9,
            0x00AE,
            0x203C,
            0x2049,
            0x2122,
            0x2139,
            0x2194,
            0x2195,
            0x2196,
            0x2197,
            0x2198,
            0x2199,
            0x21A9,
            0x21AA,
            0x231A,
            0x231B,
            0x2328,
            0x23CF,
            0x23E9,
            0x23EA,
            0x23EB,
            0x23EC,
            0x23ED,
            0x23EE,
            0x23EF,
            0x23F0,
            0x23F1,
            0x23F2,
            0x23F3,
            0x23F8,
            0x23F9,
            0x23FA,
            0x24C2,
            0x25AA,
            0x25AB,
            0x25B6,
            0x25C0,
            0x25FB,
            0x25FC,
            0x25FD,
            0x25FE,
            0x2934,
            0x2935,
            0x2B05,
            0x2B06,
            0x2B07,
            0x2B1B,
            0x2B1C,
            0x2B50,
            0x2B55,
            0x3030,
            0x303D,
            0x3297,
            0x3299,
        }
    )


def _consume_emoji_atom(codepoints: list[int], index: int) -> int:
    if index >= len(codepoints) or not _emoji_base(codepoints[index]):
        return -1
    index += 1
    while index < len(codepoints) and (
        codepoints[index] in {0xFE0E, 0xFE0F}
        or 0x1F3FB <= codepoints[index] <= 0x1F3FF
        or 0xE0020 <= codepoints[index] <= 0xE007F
    ):
        index += 1
    return index


def is_single_emoji(value: Any) -> bool:
    text = str(value or "").strip()
    if not text or any(character.isspace() for character in text):
        return False
    codepoints = [ord(character) for character in text]

    if (
        len(codepoints) == 2
        and all(0x1F1E6 <= codepoint <= 0x1F1FF for codepoint in codepoints)
    ):
        return True

    if (
        len(codepoints) in {2, 3}
        and (
            ord("0") <= codepoints[0] <= ord("9")
            or codepoints[0] in {ord("#"), ord("*")}
        )
        and codepoints[-1] == 0x20E3
        and (len(codepoints) == 2 or codepoints[1] == 0xFE0F)
    ):
        return True

    index = _consume_emoji_atom(codepoints, 0)
    if index < 0:
        return False
    while index < len(codepoints) and codepoints[index] == 0x200D:
        index = _consume_emoji_atom(codepoints, index + 1)
        if index < 0:
            return False
    return index == len(codepoints)


def message_preview_text(text: Any, attachments: Any = None) -> str:
    attachment_text = attachment_preview(attachments)
    if attachment_text:
        return attachment_text
    clean_text = str(text or "").replace("\x00", "").strip()
    if not clean_text:
        return ""
    return EMOJI_PREVIEW if is_single_emoji(clean_text) else clean_text


def compact_attachment_metadata(value: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for item in _attachment_list(value)[:8]:
        try:
            size = max(0, int(item.get("size") or 0))
        except (TypeError, ValueError):
            size = 0
        result.append(
            {
                "id": str(item.get("id") or "")[:80],
                "kind": _attachment_kind(item),
                "name": str(item.get("name") or "file")[:180] or "file",
                "mime": str(item.get("mime") or "application/octet-stream")[:120],
                "size": size,
                "dataUrl": "",
            }
        )
    return result
