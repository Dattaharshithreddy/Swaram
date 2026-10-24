"""Optional API-key protection for when Swaram runs on a public cloud server.

Voicebox is built to run on the user's own machine, so it has no login. When
the server is reachable from the internet (a cloud GPU serving the mobile
app), anyone who finds the URL could use the GPU and read the voice
profiles. Set ``SWARAM_API_KEY`` to require a key on every request:

    Authorization: Bearer <key>     (what OpenAI SDKs send)
    X-API-Key: <key>

Without the variable nothing changes, so the desktop app keeps working
locally exactly as before. ``/health`` and CORS preflights stay open so
load balancers and browsers can still reach the server.
"""

from __future__ import annotations

import hmac
import os

from starlette.types import ASGIApp, Receive, Scope, Send

API_KEY_ENV_VAR = "SWARAM_API_KEY"
OPEN_PATHS = frozenset({"/health"})
MIN_KEY_LENGTH = 16


def configured_key() -> str | None:
    key = os.environ.get(API_KEY_ENV_VAR, "").strip()
    return key or None


def _presented_key(headers: dict[bytes, bytes]) -> str | None:
    auth = headers.get(b"authorization", b"").decode("latin-1").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    key = headers.get(b"x-api-key", b"").decode("latin-1").strip()
    return key or None


class ApiKeyMiddleware:
    """Reject requests without the configured key (pure ASGI, so streaming
    responses and the mounted MCP app are unaffected)."""

    def __init__(self, app: ASGIApp, api_key: str):
        if len(api_key) < MIN_KEY_LENGTH:
            raise ValueError(
                f"{API_KEY_ENV_VAR} must be at least {MIN_KEY_LENGTH} characters. "
                "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(32))\""
            )
        self.app = app
        self.api_key = api_key.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if scope["type"] == "http" and (scope.get("method") == "OPTIONS" or path in OPEN_PATHS):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        presented = _presented_key(headers)
        if presented is not None and hmac.compare_digest(presented.encode(), self.api_key):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return

        body = b'{"detail":"Missing or wrong API key. Send it as: Authorization: Bearer <key>"}'
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"www-authenticate", b"Bearer"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
