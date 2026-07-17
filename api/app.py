"""Production entry point with stable Web Push credentials.

Environment-provided VAPID keys still win. When they are absent, YaChat derives a
separate P-256 key from the server authentication secret using domain-separated
HMAC. The private key never leaves the server process.
"""

import base64
import hashlib
import hmac
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
DATABASE_ENV_NAMES = (
    "YACHAT_USERS_DB_URL",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_POOLER",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_URL_NO_SSL",
    "NEON_DATABASE_URL",
    "NEON_DATABASE_URL_UNPOOLED",
    "SUPABASE_DB_URL",
)


def base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def server_secret() -> str:
    explicit = os.getenv("YACHAT_AUTH_SECRET", "").strip()
    if explicit:
        return explicit
    for name in DATABASE_ENV_NAMES:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return "yachat-dev-secret"


def ensure_vapid_environment() -> None:
    if os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip() and os.getenv("YACHAT_VAPID_PRIVATE_KEY", "").strip():
        return

    digest = hmac.new(
        server_secret().encode("utf-8"),
        b"yachat-web-push-v1",
        hashlib.sha256,
    ).digest()
    private_value = int.from_bytes(digest, "big") % (P256_ORDER - 1) + 1
    private_key = ec.derive_private_key(private_value, ec.SECP256R1())
    public_raw = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")

    os.environ.setdefault("YACHAT_VAPID_PUBLIC_KEY", base64url(public_raw))
    os.environ.setdefault("YACHAT_VAPID_PRIVATE_KEY", private_pem)
    os.environ.setdefault("YACHAT_VAPID_SUBJECT", "mailto:push@yachat.vercel.app")


ensure_vapid_environment()

from api.index import app  # noqa: E402,F401
