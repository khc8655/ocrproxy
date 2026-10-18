import os
import unittest
from pathlib import Path

class TestV2026100913UiAndOta(unittest.TestCase):
    def test_admin_routes_proxy_api_key_fallback(self):
        admin_routes_path = Path(__file__).resolve().parent.parent / "vm-app" / "app" / "admin_routes.py"
        content = admin_routes_path.read_text(encoding="utf-8")
        self.assertIn('if not resp_data.get("proxy_api_key"):', content)
        self.assertIn('resp_data["proxy_api_key"] = os.environ.get("PROXY_API_KEY", "")', content)

    def test_admin_html_streamlined_buttons(self):
        admin_html_path = Path(__file__).resolve().parent.parent / "shared" / "admin" / "admin.html"
        content = admin_html_path.read_text(encoding="utf-8")
        
        # Verify no openCandidateModal('chat') in mtab-kb header
        self.assertNotIn("openCandidateModal('chat')", content)
        
        # Verify mtab-agents header has only openAgentModal and no syncFromEdgeOneVault in that div
        agent_idx = content.find('id="mtab-agents"')
        agent_slice = content[agent_idx:agent_idx+800]
        self.assertIn("openAgentModal()", agent_slice)
        self.assertNotIn("syncFromEdgeOneVault()", agent_slice)
        
        # Verify version badge
        self.assertIn('id="topVersionBadge"', content)

    def test_models_js_candidate_capsule_decoupled(self):
        models_js_path = Path(__file__).resolve().parent.parent / "shared" / "admin" / "js" / "models.js"
        content = models_js_path.read_text(encoding="utf-8")
        self.assertIn("toggleCandidateKeyCapsule(this)", content)
        self.assertIn("function toggleCandidateKeyCapsule(el)", content)

    def test_install_sh_no_remain_after_exit_arg_and_fast_mirrors(self):
        for script_rel in ["install.sh", "vm-app/install.sh"]:
            script_path = Path(__file__).resolve().parent.parent / script_rel
            content = script_path.read_text(encoding="utf-8")
            # Verify --remain-after-exit=no is completely removed
            self.assertNotIn("--remain-after-exit=no", content)
            # Verify domestic mirrors priority
            self.assertIn("https://ghfast.top/", content)
            self.assertIn("https://gh-proxy.com/", content)
            self.assertIn("--collect", content)

    def test_admin_html_tag_nesting_and_balance(self):
        from html.parser import HTMLParser
        class TagChecker(HTMLParser):
            def __init__(self):
                super().__init__()
                self.stack = []
                self.errors = []
                self.void_tags = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
            def handle_starttag(self, tag, attrs):
                if tag not in self.void_tags:
                    self.stack.append((tag, self.getpos()))
            def handle_endtag(self, tag):
                if tag in self.void_tags:
                    return
                if not self.stack:
                    self.errors.append(f'Unexpected closing tag </{tag}>')
                    return
                last_tag, pos = self.stack.pop()
                if last_tag != tag:
                    self.errors.append(f'Mismatched tag: expected </{last_tag}>, got </{tag}>')

        for rel in ["shared/admin/admin.html", "vm-app/static/admin.html"]:
            file_path = Path(__file__).resolve().parent.parent / rel
            checker = TagChecker()
            checker.feed(file_path.read_text(encoding="utf-8"))
            self.assertEqual(len(checker.errors), 0, f"HTML nesting errors in {rel}: {checker.errors}")

if __name__ == "__main__":
    unittest.main()
