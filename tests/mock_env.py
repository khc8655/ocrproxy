"""
Lightweight mock environment for running offline regression tests without external dependencies (httpx, fastapi, starlette).
"""
import sys
import types
from unittest.mock import MagicMock

if "httpx" not in sys.modules:
    try:
        import httpx
    except ImportError:
        class _HttpxMock(types.ModuleType): pass
        httpx = _HttpxMock("httpx")
        class HTTPError(Exception): pass
        class RequestError(HTTPError): pass
        class TransportError(RequestError): pass
        class TimeoutException(RequestError): pass
        class PoolTimeout(TimeoutException): pass
        class ConnectError(TransportError): pass
        class ConnectTimeout(TimeoutException): pass
        class ReadError(TransportError): pass
        class WriteError(TransportError): pass
        class RemoteProtocolError(TransportError): pass
        class ReadTimeout(TimeoutException): pass
        class WriteTimeout(TimeoutException): pass
        class Timeout:
            def __init__(self, timeout=None, *, connect=None, read=None, write=None, pool=None):
                self.connect = connect
                self.read = read
                self.write = write
                self.pool = pool
        class Limits:
            def __init__(self, max_connections=None, max_keepalive_connections=None, keepalive_expiry=None):
                self.max_connections = max_connections
                self.max_keepalive_connections = max_keepalive_connections
                self.keepalive_expiry = keepalive_expiry
        class AsyncClient:
            def __init__(self, *args, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc_val, exc_tb):
                pass
            async def aclose(self):
                pass
            async def send(self, *args, **kwargs):
                return MagicMock()
        httpx.HTTPError = HTTPError
        httpx.RequestError = RequestError
        httpx.TransportError = TransportError
        httpx.TimeoutException = TimeoutException
        httpx.PoolTimeout = PoolTimeout
        httpx.ConnectError = ConnectError
        httpx.ConnectTimeout = ConnectTimeout
        httpx.ReadError = ReadError
        httpx.WriteError = WriteError
        httpx.RemoteProtocolError = RemoteProtocolError
        httpx.ReadTimeout = ReadTimeout
        httpx.WriteTimeout = WriteTimeout
        httpx.AsyncClient = AsyncClient
        httpx.Timeout = Timeout
        httpx.Limits = Limits
        sys.modules["httpx"] = httpx

if "starlette" not in sys.modules:
    try:
        import starlette
    except ImportError:
        import json
        class StreamingResponse:
            def __init__(self, content, status_code=200, headers=None, media_type=None):
                self.status_code = status_code
                self.headers = headers or {}
                self.body_iterator = content
        class JSONResponse:
            def __init__(self, content, status_code=200, headers=None):
                self.status_code = status_code
                self.headers = headers or {}
                self.content = content
                self.body = json.dumps(content).encode("utf-8")
        class Response:
            def __init__(self, content=b"", status_code=200, headers=None, media_type=None):
                self.status_code = status_code
                self.headers = headers or {}
                self.body = content
        class Request:
            def __init__(self, scope=None):
                self.scope = scope or {}
                self._json = None
                self.query_params = {}
            async def json(self):
                return self._json if self._json is not None else {}
        mock_starlette = MagicMock()
        mock_starlette_responses = MagicMock()
        mock_starlette_responses.StreamingResponse = StreamingResponse
        mock_starlette_responses.JSONResponse = JSONResponse
        mock_starlette_responses.Response = Response
        mock_starlette_requests = MagicMock()
        mock_starlette_requests.Request = Request
        sys.modules["starlette"] = mock_starlette
        sys.modules["starlette.responses"] = mock_starlette_responses
        sys.modules["starlette.requests"] = mock_starlette_requests

if "fastapi" not in sys.modules:
    try:
        import fastapi
    except ImportError:
        mock_fastapi = MagicMock()
        mock_fastapi_responses = MagicMock()
        mock_fastapi_responses.StreamingResponse = sys.modules["starlette.responses"].StreamingResponse
        mock_fastapi_responses.JSONResponse = sys.modules["starlette.responses"].JSONResponse
        mock_fastapi_responses.Response = sys.modules["starlette.responses"].Response
        class APIRouter:
            def __init__(self, *args, **kwargs):
                pass
            def get(self, *args, **kwargs):
                return lambda f: f
            def post(self, *args, **kwargs):
                return lambda f: f
            def put(self, *args, **kwargs):
                return lambda f: f
            def delete(self, *args, **kwargs):
                return lambda f: f
        mock_fastapi.APIRouter = APIRouter
        mock_fastapi.Request = Request
        sys.modules["fastapi"] = mock_fastapi
        sys.modules["fastapi.responses"] = mock_fastapi_responses
