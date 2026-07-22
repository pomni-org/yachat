"""Non-disclosing HTTP boundary for the internal YaChat Digital ID key."""

from fastapi import FastAPI, HTTPException, Request


app = FastAPI(
    title="YaChat private Digital ID boundary",
    version="1.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("Pragma", "no-cache")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


@app.get("/api/digital-id")
def digital_id_is_not_public():
    raise HTTPException(status_code=404, detail="Not found.")


@app.get("/api/developer/v1/health")
def digital_id_health():
    return {
        "ok": True,
        "service": "yachat-digital-id",
        "version": "1.2.0",
        "proof": "otp-pkce-one-time-token",
        "digitalIdExposure": "database-only",
    }
