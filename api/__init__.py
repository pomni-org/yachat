"""ЯЧат server package.

Digital ID is an internal database lookup key. It must never leave the server in
normal account/bootstrap responses or through a direct HTTP lookup endpoint.
"""

from __future__ import annotations

from functools import wraps
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request

from . import index as _index


_original_public_account = _index.public_account
_original_fastapi_get = FastAPI.get


def _private_public_account(row: dict[str, Any], session_token: str = "") -> dict[str, Any]:
    account = _original_public_account(row, session_token)
    account.pop("digitalId", None)
    account.pop("rawDigitalId", None)
    return account


def _privacy_guarded_get(self: FastAPI, path: str, *args: Any, **kwargs: Any) -> Callable:
    decorator = _original_fastapi_get(self, path, *args, **kwargs)
    if path != "/api/digital-id":
        return decorator

    def register_blocked_endpoint(endpoint: Callable) -> Callable:
        @wraps(endpoint)
        async def blocked_digital_id(request: Request) -> None:
            raise HTTPException(status_code=404, detail="Not found.")

        return decorator(blocked_digital_id)

    return register_blocked_endpoint


_index.public_account = _private_public_account
FastAPI.get = _privacy_guarded_get
