"""
Unit and regression tests for Upstream Error Sanitization and 413 Fast Abort.
Ensures raw HTML error pages (e.g. Nginx 413 / Cloudflare 502) never leak to client AI SDKs.
"""
import sys
import os
import json
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "vm-app")))

from app.logger_utils import clean_upstream_error_text

try:
    from app.scheduler import AllCandidatesFailedError
    from app.proxy_routes import _error_response_body
    HAS_FASTAPI_DEPS = True
except ImportError:
    HAS_FASTAPI_DEPS = False


class TestUpstreamErrorSanitization(unittest.TestCase):

    def test_clean_nginx_413_html(self):
        raw_html = (
            "<html>\r\n"
            "<head><title>413 Request Entity Too Large</title></head>\r\n"
            "<body>\r\n"
            "<center><h1>413 Request Entity Too Large</h1></center>\r\n"
            "<hr><center>nginx/1.24.0</center>\r\n"
            "</body>\r\n"
            "</html>"
        )
        cleaned = clean_upstream_error_text(raw_html, status_code=413)
        self.assertNotIn("<html>", cleaned)
        self.assertNotIn("<title>", cleaned)
        self.assertNotIn("</html>", cleaned)
        self.assertIn("413 Request Entity Too Large", cleaned)
        self.assertIn("too large", cleaned.lower())

    def test_clean_cloudflare_502_html(self):
        raw_html = (
            "<!DOCTYPE html>\n"
            "<html>\n"
            "<head><title>502 Bad Gateway</title></head>\n"
            "<body>\n"
            "<h1>Bad Gateway</h1>\n"
            "<p>The web server reported a bad gateway error.</p>\n"
            "</body>\n"
            "</html>"
        )
        cleaned = clean_upstream_error_text(raw_html, status_code=502)
        self.assertNotIn("<title>", cleaned)
        self.assertNotIn("<body>", cleaned)
        self.assertIn("502 Bad Gateway", cleaned)

    def test_clean_plain_text_and_json(self):
        plain_text = "Model rate limit exceeded, please retry after 10s"
        cleaned = clean_upstream_error_text(plain_text, status_code=429)
        self.assertEqual(cleaned, plain_text)

        empty_cleaned = clean_upstream_error_text("", status_code=500)
        self.assertIn("HTTP 500", empty_cleaned)

    def test_error_response_body_with_html_413(self):
        if not HAS_FASTAPI_DEPS:
            self.skipTest("FastAPI / httpx dependencies not installed in local environment")
        html_413 = "<html><head><title>413 Request Entity Too Large</title></head><body><h1>413</h1></body></html>"
        exc = AllCandidatesFailedError(
            message="Candidate openagents:khc6 failed",
            last_status_code=413,
            last_response_body=html_413
        )
        resp = _error_response_body(exc)
        self.assertEqual(resp.status_code, 413)
        body = json.loads(resp.body.decode("utf-8"))
        self.assertIn("error", body)
        err = body["error"]
        self.assertEqual(err.get("type"), "invalid_request_error")
        self.assertEqual(err.get("code"), "request_too_large")
        self.assertNotIn("<html>", err.get("message", ""))
        self.assertIn("413 Request Entity Too Large", err.get("message", ""))

    def test_error_response_body_with_standard_json_error(self):
        if not HAS_FASTAPI_DEPS:
            self.skipTest("FastAPI / httpx dependencies not installed in local environment")
        upstream_json = json.dumps({
            "error": {
                "message": "The model deepseek-v4 does not exist",
                "type": "invalid_request_error",
                "code": "model_not_found"
            }
        })
        exc = AllCandidatesFailedError(
            message="Candidate test failed",
            last_status_code=404,
            last_response_body=upstream_json
        )
        resp = _error_response_body(exc)
        self.assertEqual(resp.status_code, 404)
        body = json.loads(resp.body.decode("utf-8"))
        self.assertEqual(body["error"]["code"], "model_not_found")
        self.assertEqual(body["error"]["message"], "The model deepseek-v4 does not exist")


if __name__ == "__main__":
    unittest.main()
