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
                message["headers"] = orig_headers
            await send(message)

        await self.app(scope, receive, send_wrapper)
