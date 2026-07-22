"""ЯЧат server package.

Digital ID is an internal database lookup key. It must never leave the server in
normal account/bootstrap responses, even when a new endpoint accidentally reuses
the legacy ``public_account`` serializer.
"""

from __future__ import annotations

from typing import Any

from . import index as _index


_original_public_account = _index.public_account


def _private_public_account(row: dict[str, Any], session_token: str = "") -> dict[str, Any]:
    account = _original_public_account(row, session_token)
    account.pop("digitalId", None)
    account.pop("rawDigitalId", None)
    return account


_index.public_account = _private_public_account
