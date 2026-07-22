"""ЯЧат server package.

Digital ID is an internal database lookup key. It must never leave the server in
normal account/bootstrap responses, even when a new endpoint accidentally reuses
the legacy ``public_account`` serializer.
"""

from __future__ import annotations

import re
import sys
from typing import Any

from . import index as _index
from server import digital_id_protocol as _digital_id_protocol


_LATIN_DIGITAL_ID = re.compile(r"^[ABCDEFGHJKLMNPQRSTUVWXYZ]{2,3}[0-9]{3,4}$")
_CYRILLIC_DIGITAL_ID = re.compile(r"^[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ]{2,3}[0-9]{3,4}$")


def _normalize_digital_id(value: Any) -> str:
    normalized = re.sub(r"[^A-ZА-ЯЁ0-9]+", "", str(value or "").upper()).replace("Ё", "Е")
    if normalized.startswith("YC") and len(normalized) == 8:
        normalized = normalized[2:]
    normalized = normalized[:6]
    return normalized if len(normalized) == 6 and (
        _LATIN_DIGITAL_ID.fullmatch(normalized) or _CYRILLIC_DIGITAL_ID.fullmatch(normalized)
    ) else ""


def _format_digital_id(value: Any) -> str:
    normalized = _normalize_digital_id(value)
    return f"{normalized[:3]} — {normalized[3:]}" if normalized else ""


_index.normalize_digital_id = _normalize_digital_id
_index.format_digital_id = _format_digital_id

_original_public_account = _index.public_account


def _private_public_account(row: dict[str, Any], session_token: str = "") -> dict[str, Any]:
    account = _original_public_account(row, session_token)
    account.pop("digitalId", None)
    account.pop("rawDigitalId", None)
    return account


_index.public_account = _private_public_account

# Keep the verification implementation outside /api so Vercel does not count a
# helper module as another serverless function. Existing imports remain stable.
sys.modules.setdefault(f"{__name__}.digital_id", _digital_id_protocol)
