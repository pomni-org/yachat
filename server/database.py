"""Supabase Postgres connection helpers shared by every API entry point."""

import os
import time

import psycopg
from fastapi import HTTPException
from psycopg import sql


SUPABASE_DATABASE_ENV = "SUPABASE_DB_URL"
DATABASE_NOT_CONFIGURED_DETAIL = (
    "Supabase database is not configured. Set SUPABASE_DB_URL in Vercel."
)


def database_url() -> str:
    return os.getenv(SUPABASE_DATABASE_ENV, "").strip()


def database_env_name() -> str:
    return SUPABASE_DATABASE_ENV if database_url() else ""


def auth_secret() -> str:
    return os.getenv("YACHAT_AUTH_SECRET") or database_url() or "yachat-dev-secret"


def require_database() -> str:
    url = database_url()
    if not url:
        raise HTTPException(status_code=503, detail=DATABASE_NOT_CONFIGURED_DETAIL)
    return url


def _connection_error_category(error: psycopg.Error) -> str:
    """Return a log-safe Supabase connection failure category."""

    detail = str(error).lower()
    categories = (
        (("password authentication failed", "authentication failed"), "auth_failed"),
        (("tenant or user not found", "invalid tenant"), "pooler_tenant_not_found"),
        (("could not translate host name", "name or service not known"), "dns_failed"),
        (("timeout expired", "connection timed out", "connect timeout"), "timeout"),
        (("network is unreachable", "no route to host"), "network_unreachable"),
        (("ssl", "certificate"), "tls_failed"),
        (("invalid dsn", "missing '=' after"), "invalid_connection_string"),
    )
    for markers, category in categories:
        if any(marker in detail for marker in markers):
            return category
    return "postgres_operational_error"


def connect_db():
    """Open one short-lived Vercel connection through Supavisor transaction mode.

    Supavisor transaction pooling does not support prepared statements, so
    psycopg's automatic preparation is explicitly disabled.
    """

    url = require_database()
    try:
        attempts = max(1, min(int(os.getenv("YACHAT_DB_CONNECT_ATTEMPTS", "2")), 3))
    except ValueError:
        attempts = 2
    try:
        timeout = max(2, min(int(os.getenv("YACHAT_DB_CONNECT_TIMEOUT_SECONDS", "3")), 8))
    except ValueError:
        timeout = 3

    retryable = {"timeout", "dns_failed", "network_unreachable", "postgres_operational_error"}
    last_error: psycopg.Error | None = None
    for attempt in range(1, attempts + 1):
        try:
            return psycopg.connect(
                url,
                autocommit=True,
                connect_timeout=timeout,
                prepare_threshold=None,
                application_name="yachat-vercel",
            )
        except psycopg.Error as error:
            last_error = error
            category = _connection_error_category(error)
            if category in retryable and attempt < attempts:
                print(
                    f"supabase_connect_retry category={category} attempt={attempt}",
                    flush=True,
                )
                time.sleep(0.18 * attempt)
                continue
            print(
                f"supabase_connect_failed category={category} "
                f"attempts={attempt} error_type={type(error).__name__}",
                flush=True,
            )
            raise

    if last_error:
        raise last_error
    raise RuntimeError("Supabase connection could not be created.")


def secure_server_tables(cursor, table_names: tuple[str, ...]) -> None:
    """Keep server-owned tables inaccessible through Supabase's Data API."""

    for table_name in table_names:
        table = sql.Identifier("public", table_name)
        cursor.execute(sql.SQL("alter table {} enable row level security").format(table))
        cursor.execute(
            sql.SQL("revoke all privileges on table {} from anon, authenticated").format(table)
        )
