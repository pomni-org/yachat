from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api" / "index.py"
SYSTEM = ROOT / "src" / "renderer" / "assets" / "system-upgrade-v29.js"
INDEX = ROOT / "src" / "renderer" / "index.html"


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return source.replace(old, new, 1)


api = API.read_text("utf-8")
api = replace_once(api, "import hashlib\n", "import base64\nimport hashlib\n", "base64 import")

vapid_helpers = '''P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551\n_vapid_key_cache: tuple[str, str] | None = None\n\n\ndef vapid_key_pair() -> tuple[str, str]:\n    global _vapid_key_cache\n    configured_public = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()\n    configured_private = os.getenv("YACHAT_VAPID_PRIVATE_KEY", "").strip()\n    if configured_public and configured_private:\n        return configured_public, configured_private\n    if _vapid_key_cache:\n        return _vapid_key_cache\n\n    try:\n        from cryptography.hazmat.primitives import serialization\n        from cryptography.hazmat.primitives.asymmetric import ec\n    except Exception:\n        return "", ""\n\n    seed = hmac.new(\n        auth_secret().encode("utf-8"),\n        b"yachat-web-push-v1",\n        hashlib.sha256,\n    ).digest()\n    scalar = int.from_bytes(seed, "big") % (P256_ORDER - 1) + 1\n    private_key = ec.derive_private_key(scalar, ec.SECP256R1())\n    public_bytes = private_key.public_key().public_bytes(\n        serialization.Encoding.X962,\n        serialization.PublicFormat.UncompressedPoint,\n    )\n    private_der = private_key.private_bytes(\n        serialization.Encoding.DER,\n        serialization.PrivateFormat.PKCS8,\n        serialization.NoEncryption(),\n    )\n    public_value = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode("ascii")\n    private_value = base64.urlsafe_b64encode(private_der).rstrip(b"=").decode("ascii")\n    _vapid_key_cache = (public_value, private_value)\n    return _vapid_key_cache\n\n\ndef vapid_public_key() -> str:\n    return vapid_key_pair()[0]\n\n\ndef vapid_private_key() -> str:\n    return vapid_key_pair()[1]\n\n\n'''

api = replace_once(
    api,
    "def send_push_to_user(user_id: str, title: str, body: str, url: str) -> None:\n",
    vapid_helpers + "def send_push_to_user(user_id: str, title: str, body: str, url: str) -> None:\n",
    "vapid helpers",
)
api = replace_once(
    api,
    '''    public_key = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()\n    private_key = os.getenv("YACHAT_VAPID_PRIVATE_KEY", "").strip()''',
    '''    public_key = vapid_public_key()\n    private_key = vapid_private_key()''',
    "push helper keys",
)
api = replace_once(
    api,
    '''                ttl=0,\n                headers={"Urgency": "high"},''',
    '''                ttl=120,\n                headers={"Urgency": "high"},''',
    "push delivery options",
)
api = replace_once(
    api,
    '''        "notifications": bool(os.getenv("YACHAT_VAPID_PUBLIC_KEY") and os.getenv("YACHAT_VAPID_PRIVATE_KEY")),''',
    '''        "notifications": bool(vapid_public_key() and vapid_private_key()),''',
    "status push flag",
)
api = replace_once(
    api,
    '''@app.get("/api/push/public-key")\ndef push_public_key():\n    key = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()\n    return {"enabled": bool(key), "publicKey": key}''',
    '''@app.get("/api/push/public-key")\ndef push_public_key():\n    key = vapid_public_key()\n    return {"enabled": bool(key), "publicKey": key}''',
    "public key endpoint",
)
API.write_text(api, "utf-8")

system = SYSTEM.read_text("utf-8")
auto_push = '''\n  let pushRefreshPromise = null;\n\n  async function refreshRealPushSubscription() {\n    if (pushRefreshPromise) return pushRefreshPromise;\n    if (!("Notification" in window) || Notification.permission !== "granted") return null;\n    if (!("serviceWorker" in navigator) || typeof enablePushNotifications !== "function") return null;\n\n    pushRefreshPromise = (async () => {\n      try {\n        await navigator.serviceWorker.ready;\n        await enablePushNotifications();\n        localStorage.setItem("yachat-push-subscription-ready-v29", String(Date.now()));\n      } catch {\n        // The next foreground opening will retry without blocking the messenger.\n      } finally {\n        pushRefreshPromise = null;\n      }\n    })();\n    return pushRefreshPromise;\n  }\n\n  window.setTimeout(() => void refreshRealPushSubscription(), 900);\n  document.addEventListener("visibilitychange", () => {\n    if (document.visibilityState === "visible") void refreshRealPushSubscription();\n  });\n  window.addEventListener("online", () => void refreshRealPushSubscription());\n'''
system = replace_once(
    system,
    '''  const observer = new MutationObserver((records) => {''',
    auto_push + '''\n  const observer = new MutationObserver((records) => {''',
    "automatic push subscription",
)
SYSTEM.write_text(system, "utf-8")

index = INDEX.read_text("utf-8")
old_screen_start = '        <section class="screen qr-screen" data-screen="qr">'
start = index.find(old_screen_start)
if start < 0:
    raise RuntimeError("device login screen start not found")
end = index.find('        <section class="screen done-screen"', start)
if end < 0:
    raise RuntimeError("device login screen end not found")
new_screen = '''        <section class="screen device-code-login-screen" data-screen="qr">\n          <button class="back-button" type="button" data-device-code-back>\n            <span class="css-icon gg-chevron-left"></span>\n            Назад\n          </button>\n          <div class="screen-copy">\n            <h1>Вход по коду</h1>\n            <p>Откройте Настройки → Безопасность на устройстве, где уже выполнен вход.</p>\n          </div>\n          <form class="auth-form device-code-login-form" data-device-code-login>\n            <label class="device-code-input-shell">\n              <input type="text" inputmode="text" enterkeyhint="done" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="7" placeholder="АБ1-234" data-device-code-input />\n            </label>\n            <div class="form-message" data-device-code-message></div>\n            <button class="main-button" type="submit" disabled>Войти</button>\n          </form>\n          <p class="device-code-location">Код действует 10 минут и используется один раз.</p>\n        </section>\n\n'''
index = index[:start] + new_screen + index[end:]
INDEX.write_text(index, "utf-8")

for path, markers in {
    API: ("def vapid_key_pair()", "ttl=120", "vapid_public_key()"),
    SYSTEM: ("refreshRealPushSubscription", "enablePushNotifications"),
    INDEX: ("data-device-code-login", "Код действует 10 минут"),
}.items():
    source = path.read_text("utf-8")
    for marker in markers:
        if marker not in source:
            raise RuntimeError(f"missing marker {marker} in {path}")

if "QR-код для входа" in INDEX.read_text("utf-8"):
    raise RuntimeError("user-facing QR markup is still present")
