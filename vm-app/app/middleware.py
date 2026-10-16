"""
Enterprise ASGI middlewares for OCRProxy VM.
Zero-overhead native ASGI middlewares without BaseHTTPMiddleware streaming penalties.
"""

class SecurityHeadersASGIMiddleware:
    """
    Enforce enterprise security headers on all HTTP responses and mask server fingerprint.
    Operates at raw ASGI level to ensure zero streaming response overhead (critical for SSE).
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        # /v1/* endpoints allow standard cross-origin requests for client tooling.
        # /api/* admin endpoints strictly do NOT return wildcard Access-Control-Allow-Origin: *.
        is_client_api = path.startswith("/v1") or path.startswith("/api/v1")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                orig_headers = [
                    (k, v) for k, v in message.get("headers", [])
                    if k.lower() != b"server"
                ]
                orig_headers.extend([
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"x-xss-protection", b"1; mode=block"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"server", b"webserver"),
                ])
                if is_client_api:
                    orig_headers.extend([
                        (b"access-control-allow-origin", b"*"),
                        (b"access-control-allow-methods", b"GET, POST, OPTIONS"),
                        (b"access-control-allow-headers", b"*"),
                    ])
                message["headers"] = orig_headers
            await send(message)

        await self.app(scope, receive, send_wrapper)

