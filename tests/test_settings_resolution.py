"""tests/test_settings_resolution.py — Layer 1: runtime settings resolution after the
v20261020-07 dedupe (settings via settings.schema.json + get_setting).

Guards behaviours the old hand-written fallback chains had and the schema
aliases silently changed:

  R1  Agent first-byte timeout is NOT taken from KB timeouts
      (upstream_timeout_sec / upstream_timeout_chat; init_config writes
      upstream_timeout_chat=45 and a KB-mode settings save writes 15).
  R2  403 cooldown is NOT taken from the quota/arrears cooldown (cooldown_quota_sec).
  R3  The per-request timeout a route sets (req_config["request_timeout_sec"], e.g. OCR
      60 s) beats a saved global upstream_timeout_sec — real schedule() against a
      slow local upstream.
  R4  EdgeOne hub exports plain string keys ("KeyA": "sk-xxx") in manifest and fetch.
"""
import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "vm-app"))
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")


def r1_r2():
    from app.settings_schema import get_setting
    for cfg in ({"upstream_timeout_sec": 15}, {"upstream_timeout_chat": 45, "request_timeout_sec": 12}):
        v = get_setting(cfg, "agent_first_byte_timeout_sec", 120.0)
        assert float(v) == 120.0, f"R1: agent first-byte timeout picked up a KB timeout: {cfg} -> {v}"
    assert float(get_setting({"agent_first_byte_timeout_sec": 200}, "agent_first_byte_timeout_sec", 120.0)) == 200
    v = get_setting({"cooldown_quota_sec": 1800}, "cooldown_403_sec", 600.0)
    assert float(v) == 600.0, f"R2: 403 cooldown picked up cooldown_quota_sec -> {v}"
    print("PASS R1/R2: no cross-policy aliases (first-byte vs KB timeout, 403 vs quota)")


DELAY = 6.5


class _Slow(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        time.sleep(DELAY)
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


async def _r3(port):
    from app import scheduler
    cfg = {
        "upstream_timeout_sec": 5,          # saved global KB timeout (schema min 5)
        "request_timeout_sec": 15,             # what the OCR route sets for this request
        "request_total_budget_sec": 30,
        "max_retries": 1,
        "providers": {"p": {"base_url": f"http://127.0.0.1:{port}", "keys": {"k": "sk"}}},
        "candidates": {"ocr": [{"provider": "p", "key": "k", "model": "m"}]},
    }

    def build(cand, api_key, base_url):
        return "POST", f"http://127.0.0.1:{port}/ocr", {"authorization": "Bearer sk"}, {"x": 1}

    t0 = time.time()
    sr = await scheduler.schedule(cfg, "ocr", build, category="kb", request_model="ocr")
    return sr, time.time() - t0


def r3():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Slow)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        try:
            sr, dt = asyncio.run(_r3(srv.server_address[1]))
        except Exception as e:
            raise AssertionError(f"R3: per-request request_timeout_sec (15s) lost to upstream_timeout_sec (5s): {e}")
        assert dt >= DELAY - 0.5, dt
    finally:
        srv.shutdown()
    print(f"PASS R3: route timeout beats global upstream_timeout_sec ({dt:.1f}s upstream answered)")


def r4():
    js = r"""
import { isVaultExportableKey, toVaultProviderView } from './agent-edgeone/edge-functions/lib/config.js';
const cfg = { base_url: 'https://x', keys: { KeyA: 'sk-a', KeyB: { key: 'sk-b' }, L: { key: 'sk-l', origin: 'local' }, E: '' } };
const v = toVaultProviderView('p', cfg, null, { includeSecrets: false });
const out = { a: isVaultExportableKey('sk-a'), keys: v.keys };
console.log(JSON.stringify(out));
"""
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO_ROOT, capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    keys = out["keys"] if isinstance(out["keys"], list) else list(out["keys"])
    assert out["a"] is True and "KeyA" in keys and "KeyB" in keys and "L" not in keys and "E" not in keys, out
    print("PASS R4: EdgeOne hub exports plain string keys, still hides local ones")


if __name__ == "__main__":
    r1_r2()
    r3()
    r4()
