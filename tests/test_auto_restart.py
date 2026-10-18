import unittest
from pathlib import Path


class TestAutoRestartRemoved(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent.parent

    def test_auto_restart_module_removed(self):
        auto_restart_py = self.root / "vm-app" / "app" / "auto_restart.py"
        self.assertFalse(auto_restart_py.exists(), "auto_restart.py should be completely deleted")

    def test_main_py_clean(self):
        main_py = self.root / "vm-app" / "app" / "main.py"
        content = main_py.read_text(encoding="utf-8")
        self.assertNotIn("auto_restart", content)
        self.assertNotIn("sync_auto_restart_worker", content)

    def test_admin_routes_py_clean(self):
        admin_routes = self.root / "vm-app" / "app" / "admin_routes.py"
        content = admin_routes.read_text(encoding="utf-8")
        self.assertNotIn("auto_restart", content)

    def test_init_config_py_clean(self):
        init_config = self.root / "vm-app" / "scripts" / "init_config.py"
        content = init_config.read_text(encoding="utf-8")
        self.assertNotIn("auto_restart", content)

    def test_admin_html_clean(self):
        admin_html = self.root / "shared" / "admin" / "admin.html"
        content = admin_html.read_text(encoding="utf-8")
        self.assertNotIn("s_autoRestart", content)
        self.assertNotIn("每日定时平滑重启", content)

    def test_settings_js_clean(self):
        settings_js = self.root / "shared" / "admin" / "js" / "settings.js"
        content = settings_js.read_text(encoding="utf-8")
        self.assertNotIn("s_autoRestart", content)
        self.assertNotIn("auto_restart_enabled", content)
        self.assertNotIn("toggleAutoRestartTimeInput", content)


if __name__ == "__main__":
    unittest.main()
