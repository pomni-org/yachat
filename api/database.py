"""Supabase Postgres connection helpers shared by every API entry point."""

import os

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


def connect_db():
    """Open one short-lived Vercel connection through Supavisor transaction mode.

    Supavisor transaction pooling does not support prepared statements, so
    psycopg's automatic preparation is explicitly disabled.
    """

    return psycopg.connect(
        require_database(),
        autocommit=True,
        connect_timeout=5,
        prepare_threshold=None,
        application_name="yachat-vercel",
    )


def secure_server_tables(cursor, table_names: tuple[str, ...]) -> None:
    """Keep server-owned tables inaccessible through Supabase's Data API."""

    for table_name in table_names:
        table = sql.Identifier("public", table_name)
        cursor.execute(sql.SQL("alter table {} enable row level security").format(table))
        cursor.execute(
            sql.SQL("revoke all privileges on table {} from anon, authenticated").format(table)
        )
