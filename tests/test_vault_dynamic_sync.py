"""
Test suite for EdgeOne Vault dynamic sync and runtime lazy-fetch fallback.
Verifies that:
1. vault_sync_endpoint imports new providers from remote manifest that don't exist locally.
4. Strict 3-role privilege separation: vault operations strictly use VAULT_ACCESS_TOKEN and never fall back to ADMIN_PASSWORD.
"""
import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock, patch, MagicMock

# Add vm-app to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "vm-app"))

import types
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
        class AsyncClient: pass
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
        sys.modules["httpx"] = httpx

if "starlette" not in sys.modules:
    try:
        import starlette
    except ImportError:
        class StreamingResponse:
            def __init__(self, content, status_code=200, headers=None, media_type=None):
                self.status_code = status_code
                self.headers = headers or {}
        class JSONResponse:
            def __init__(self, content, status_code=200, headers=None):
                self.status_code = status_code
                self.headers = headers or {}
        class Response:
            def __init__(self, content=b"", status_code=200, headers=None, media_type=None):
                self.status_code = status_code
                self.headers = headers or {}
        mock_starlette = MagicMock()
        mock_starlette_responses = MagicMock()
        mock_starlette_responses.StreamingResponse = StreamingResponse
        mock_starlette_responses.JSONResponse = JSONResponse
        mock_starlette_responses.Response = Response
        sys.modules["starlette"] = mock_starlette
        sys.modules["starlette.responses"] = mock_starlette_responses

if "fastapi" not in sys.modules:
    try:
        import fastapi
    except ImportError:
        mock_fastapi = MagicMock()
        mock_fastapi_responses = MagicMock()
        mock_fastapi_responses.StreamingResponse = sys.modules["starlette.responses"].StreamingResponse
        mock_fastapi_responses.JSONResponse = sys.modules["starlette.responses"].JSONResponse
        mock_fastapi_responses.Response = sys.modules["starlette.responses"].Response
        mock_fastapi.APIRouter = MagicMock(return_value=MagicMock())
        mock_fastapi.Request = MagicMock
        sys.modules["fastapi"] = mock_fastapi
        sys.modules["fastapi.responses"] = mock_fastapi_responses

from app import config_store


class TestVaultDynamicSync(unittest.IsolatedAsyncioTestCase):

    async def test_strict_three_role_separation_no_admin_password_fallback(self):
        """Verify that vault operations strictly use VAULT_ACCESS_TOKEN and never fall back to ADMIN_PASSWORD."""
        from app.admin_routes import _get_vault_credentials

        fake_cfg = {"edgeone_vault": {"url": "https://vault.example.com"}}
        async def fake_get_config():
            return fake_cfg

        with patch("app.admin_routes.get_config", side_effect=fake_get_config), \
             patch.dict(os.environ, {"ADMIN_PASSWORD": "admin-pass-12345", "PROXY_API_KEY": "client-key-54321"}, clear=True):
            # When neither VAULT_ACCESS_TOKEN nor EDGEONE_VAULT_TOKEN is set
            url, token = await _get_vault_credentials({})
            self.assertEqual(url, "https://vault.example.com")
            self.assertEqual(token, "", "Must NOT fall back to ADMIN_PASSWORD or PROXY_API_KEY")

        with patch("app.admin_routes.get_config", side_effect=fake_get_config), \
             patch.dict(os.environ, {"VAULT_ACCESS_TOKEN": "vault-token-xyz", "ADMIN_PASSWORD": "admin-pass-12345"}, clear=True):
            # When VAULT_ACCESS_TOKEN is set
            url, token = await _get_vault_credentials({})
            self.assertEqual(url, "https://vault.example.com")
            self.assertEqual(token, "vault-token-xyz", "Must use VAULT_ACCESS_TOKEN")


if __name__ == "__main__":
    unittest.main()
