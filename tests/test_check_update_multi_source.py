#!/usr/bin/env python3
"""
Unit tests for multi-source OTA update check logic in admin_routes.py.
Verifies fallback chain (GitHub -> ghfast mirror -> jsDelivr CDN) and
network error reporting without false positive 'already latest' bugs.
"""
import sys
import unittest
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch

# Mock third-party dependencies before importing admin_routes
sys.modules['httpx'] = MagicMock()
sys.modules['fastapi'] = MagicMock()
sys.modules['fastapi.responses'] = MagicMock()
sys.modules['pydantic'] = MagicMock()

# FastAPI router mock
mock_router = MagicMock()
def mock_decorator(*args, **kwargs):
    def wrapper(f):
        return f
    return wrapper
mock_router.get = mock_decorator
mock_router.post = mock_decorator
mock_router.delete = mock_decorator
mock_router.put = mock_decorator

with patch('fastapi.APIRouter', return_value=mock_router):
    sys.path.insert(0, 'vm-app')
    from app import admin_routes
    from app.admin_routes import (
        _parse_version_tuple,
        check_system_update_endpoint,
    )


class TestMultiSourceCheckUpdate(unittest.TestCase):
    def test_version_tuple_parsing(self):
        self.assertEqual(_parse_version_tuple("v2026.10.06-01"), (2026, 10, 6, 1))
        self.assertEqual(_parse_version_tuple("v2026.10.09-11"), (2026, 10, 9, 11))
        self.assertTrue(_parse_version_tuple("v2026.10.09-11") > _parse_version_tuple("v2026.10.06-01"))
        self.assertFalse(_parse_version_tuple("v2026.10.06-01") > _parse_version_tuple("v2026.10.09-11"))

    def test_check_update_first_source_succeeds(self):
        request = MagicMock()
        with patch.object(admin_routes, '_check_auth', return_value=True), \
             patch.object(admin_routes, '_load_local_version_info', return_value={"version": "v2026.10.06-01"}), \
             patch('app.admin_routes.JSONResponse', side_effect=lambda content, status_code=200: content):

            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {
                "version": "v2026.10.09-11",
                "release_date": "2026-10-09",
                "title": "国内机器 OTA 更新多源轮询"
            }

            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(return_value=mock_resp)
            mock_client_instance.__aenter__.return_value = mock_client_instance
            mock_client_instance.__aexit__.return_value = None

            with patch('app.admin_routes.httpx.AsyncClient', return_value=mock_client_instance):
                result = asyncio.run(check_system_update_endpoint(request))

                self.assertTrue(result["ok"])
                self.assertFalse(result["network_error"])
                self.assertTrue(result["has_update"])
                self.assertEqual(result["current_version"], "v2026.10.06-01")
                self.assertEqual(result["latest_version"], "v2026.10.09-11")

    def test_check_update_fallback_to_second_source(self):
        """First source (GitHub) raises TimeoutException; second source (ghfast) succeeds."""
        request = MagicMock()
        with patch.object(admin_routes, '_check_auth', return_value=True), \
             patch.object(admin_routes, '_load_local_version_info', return_value={"version": "v2026.10.06-01"}), \
             patch('app.admin_routes.JSONResponse', side_effect=lambda content, status_code=200: content):

            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {
                "version": "v2026.10.09-11",
                "release_date": "2026-10-09",
                "title": "国内机器 OTA 更新多源轮询"
            }

            async def mock_get(url):
                if "raw.githubusercontent.com/khc8655" in url and "ghfast.top" not in url:
                    raise Exception("Connection timed out to raw.githubusercontent.com")
                return mock_resp

            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(side_effect=mock_get)
            mock_client_instance.__aenter__.return_value = mock_client_instance
            mock_client_instance.__aexit__.return_value = None

            with patch('app.admin_routes.httpx.AsyncClient', return_value=mock_client_instance):
                result = asyncio.run(check_system_update_endpoint(request))

                self.assertTrue(result["ok"])
                self.assertFalse(result["network_error"])
                self.assertTrue(result["has_update"])
                self.assertEqual(result["latest_version"], "v2026.10.09-11")

    def test_check_update_all_sources_fail_returns_network_error(self):
        """All sources fail; must return network_error=True and NOT report as 'already latest'."""
        request = MagicMock()
        with patch.object(admin_routes, '_check_auth', return_value=True), \
             patch.object(admin_routes, '_load_local_version_info', return_value={"version": "v2026.10.06-01"}), \
             patch('app.admin_routes.JSONResponse', side_effect=lambda content, status_code=200: content):

            async def mock_get(url):
                raise Exception(f"All connections timed out for {url}")

            mock_client_instance = AsyncMock()
            mock_client_instance.get = AsyncMock(side_effect=mock_get)
            mock_client_instance.__aenter__.return_value = mock_client_instance
            mock_client_instance.__aexit__.return_value = None

            with patch('app.admin_routes.httpx.AsyncClient', return_value=mock_client_instance):
                result = asyncio.run(check_system_update_endpoint(request))

                self.assertFalse(result["ok"])
                self.assertTrue(result["network_error"])
                self.assertFalse(result["has_update"])
                self.assertEqual(result["current_version"], "v2026.10.06-01")
                self.assertIn("未能连接到 GitHub 或国内镜像更新源", result["notice"])


if __name__ == '__main__':
    unittest.main()
