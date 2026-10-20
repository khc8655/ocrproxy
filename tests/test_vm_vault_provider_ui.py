#!/usr/bin/env python3
"""tests/test_vm_vault_provider_ui.py — T2: 「从中枢按需拉取供应商」真实浏览器回归。

背景：`saveProvider()` 过去用 `#p_name.disabled` 判断"新增 / 编辑"，而中枢预设分支
为了让名称只读也会 disable 它，于是保存时被误判为"编辑已有供应商"：`/vault/fetch-key`
根本不会被调用，本地只会生成一个 origin=local 且没有 Key 的空供应商。中枢按需拉取
在 UI 上完全失效（API 测试覆盖不到，只有真实点击才会暴露）。

本测试用一个真实 HTTP 中枢（manifest + fetch）拉起 VM 服务，在真实 Chromium 里
走「供应商 → 新增供应商 → 选择 EdgeOne 凭据中枢托管项 → 保存并生效」，断言：
  * 供应商以 origin=vault 落地，而不是 origin=local；
  * 中枢的 Key 被一并拉取（数量 > 0，值为掩码、origin=vault、只读）；
  * KB 模式下「挂载候选节点」弹窗能看到该供应商（即与 Agent 模式共用同一份本地资产）。
"""

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parent.parent
VM = ROOT / "vm-app"
ADMIN_PW = "vault-ui-admin"
PROXY_KEY = "vault-ui-pk"
HUB_TOKEN = "vault-ui-hub-token"
CHROMIUM = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser")

HUB_PROVIDER = {
    "name": "Hub Only",
    "protocol": "openai",
    "protocols": ["chat"],
    "base_url": "https://hub-only.example/v1",
    "keys": {"hk1": "sk-hub-only-1", "hk2": "sk-hub-only-2"},
}
# a hub provider that also has a local adapter script (官方预设 sensenova: openai+message)
HUB_PRESET_PROVIDER = {
    "name": "商汤日日新",
    "protocol": "openai",
    "protocols": ["chat"],
    "base_url": "https://token.sensenova.cn/v1",
    "keys": {"p1": "sk-p1", "p2": "sk-p2"},
}


class _Hub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        return (self.headers.get("authorization") or "") == f"Bearer {HUB_TOKEN}"

    def do_GET(self):
        if not self._authed():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        if self.path.split("?")[0] == "/api/vault/manifest":
            providers = {
                "hubonly": {"id": "hubonly", "name": HUB_PROVIDER["name"],
                             "protocol": HUB_PROVIDER["protocol"],
                             "protocols": HUB_PROVIDER["protocols"],
                             "base_url": HUB_PROVIDER["base_url"],
                             "keys": list(HUB_PROVIDER["keys"])},
                "sensenova": {"id": "sensenova", "name": HUB_PRESET_PROVIDER["name"],
                               "protocol": HUB_PRESET_PROVIDER["protocol"],
                               "protocols": HUB_PRESET_PROVIDER["protocols"],
                               "base_url": HUB_PRESET_PROVIDER["base_url"],
                               "keys": list(HUB_PRESET_PROVIDER["keys"])},
            }
            return self._send(200, {"ok": True, "providers": providers})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        pid = body.get("provider")
        provider = {"hubonly": HUB_PROVIDER, "sensenova": HUB_PRESET_PROVIDER}.get(pid)
        if not provider:
            return self._send(404, {"ok": False, "error": "no such provider"})
        return self._send(200, {"ok": True, "provider": pid, "provider_config": {
            "name": provider["name"], "protocol": provider["protocol"],
            "protocols": provider["protocols"], "base_url": provider["base_url"],
            "keys": provider["keys"],
        }})


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_http(url, timeout=25):
    t = time.time()
    while time.time() - t < timeout:
        try:
            httpx.get(url, timeout=1, trust_env=False)
            return True
        except Exception:
            time.sleep(0.15)
    return False


def vm_config(mode, hub_url):
    return {
        "_version": 1,
        "run_mode": mode,
        "proxy_api_key": PROXY_KEY,
        "edgeone_vault": {"edgeone_url": hub_url, "url": hub_url, "token": HUB_TOKEN},
        "providers": {"alpha": {"name": "Alpha", "origin": "local",
                                 "base_url": "https://alpha.example/v1",
                                 "protocols": ["chat"], "keys": {"k1": "sk-alpha-1"}}},
        "agent_models": {"m1": {"upstream_model": "m1",
                                 "keys": [{"provider": "alpha", "key": "k1"}]}},
        "candidates": {"chat": [{"provider": "alpha", "key": "k1", "model": "m1"}],
                       "embedding": [], "reranker": [], "ocr": []},
    }


async def run_browser(mode, port):
    from playwright.async_api import async_playwright
    base = f"http://127.0.0.1:{port}"
    async with async_playwright() as p:
        launch = {"headless": True, "args": ["--no-sandbox"]}
        if CHROMIUM:
            launch["executable_path"] = CHROMIUM
        browser = await p.chromium.launch(**launch)
        page = await browser.new_page(viewport={"width": 1440, "height": 950})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        try:
            await page.goto(base + "/")
            await page.fill("#loginKey", ADMIN_PW)
            await page.click("#loginOverlay button[type=submit]")
            await page.wait_for_function(
                "(() => { const a = document.getElementById('app');"
                " return a && getComputedStyle(a).display !== 'none'; })()", timeout=15000)
            # the manifest is fetched in the background right after login
            await page.wait_for_function("state.vaultManifest !== null", timeout=12000)

            await page.evaluate("switchTab('providers')")
            await page.wait_for_timeout(250)
            await page.evaluate("openProviderModal()")
            await page.wait_for_function(
                "Array.from(document.querySelectorAll('#p_preset option'))"
                ".some(o => o.value.startsWith('vault:hubonly'))", timeout=12000)

            # dropdown is a SOURCE selector: custom + (VM) unimported hub providers.
            # Official presets must not be rendered as options (they are rules templates that
            # auto-apply after the provider is configured locally).
            selector = await page.evaluate(
                "(() => { const s = document.getElementById('p_preset');"
                " return { opts: Array.from(s.options).map(o => o.value),"
                "          groups: Array.from(s.querySelectorAll('optgroup')).map(g => g.label) }; })()")
            preset_ids = {"agnes", "amd", "bai", "cline", "deepseek", "google", "minimax",
                          "nvidia", "openai", "opencode", "openrouter", "sensenova",
                          "siliconflow", "stepfun", "tokenrhythm", "vertex"}
            leaked = sorted(set(selector["opts"]) & preset_ids)
            bad_groups = [g for g in selector["groups"] if "官方预设" in g]
            if leaked or bad_groups:
                raise AssertionError(
                    f"add-provider dropdown must not list official presets: leaked={leaked} groups={bad_groups}")
            if selector["opts"][:1] != [""]:
                raise AssertionError(f"first option must be the custom provider: {selector['opts'][:3]}")
            if not any(o.startswith("vault:") for o in selector["opts"]):
                raise AssertionError(f"unimported hub provider missing from dropdown: {selector['opts']}")

            # hub provider with a local adapter script: description keeps only two facts
            # (key count + adapter version) and protocols default to the adapter script.
            await page.evaluate(
                "document.getElementById('p_preset').value='vault:sensenova';onProviderPresetChange()")
            await page.wait_for_timeout(200)
            info = await page.evaluate(
                "(() => ({ desc: document.getElementById('p_desc').innerText,"
                "          chat: document.getElementById('p_proto_chat').checked,"
                "          msg: document.getElementById('p_proto_messages').checked,"
                "          hint: document.getElementById('p_proto_hint').innerText }))()")
            assert "中枢 2 个 Key" in info["desc"], info
            assert "适配脚本 v1.3.0" in info["desc"], info
            assert len(info["desc"].strip().splitlines()) <= 3, f"source description too verbose: {info['desc']!r}"
            assert info["chat"] and info["msg"], f"protocols must default from the adapter script: {info}"
            assert "已按适配脚本预选" in info["hint"], info

            # typing a preset id fills URL/protocol/rules without showing presets in the dropdown
            await page.evaluate("document.getElementById('p_preset').value='';onProviderPresetChange()")
            await page.fill("#p_name", "siliconflow")
            await page.dispatch_event("#p_name", "input")
            await page.wait_for_timeout(200)
            autofill = await page.evaluate(
                "(() => ({ url: document.getElementById('p_url').value,"
                "          desc: document.getElementById('p_desc').innerText,"
                "          chat: document.getElementById('p_proto_chat').checked }))()")
            if "siliconflow" not in autofill["url"] or "适配脚本 v1.2.0" not in autofill["desc"]:
                raise AssertionError(f"preset rules were not auto-applied by provider name: {autofill}")
            await page.evaluate("document.getElementById('p_name').value=''")
            await page.evaluate(
                "document.getElementById('p_preset').value='vault:hubonly';"
                "onProviderPresetChange()")
            await page.wait_for_timeout(200)
            await page.evaluate("saveProvider()")
            # the pull is an async HTTP round-trip; wait for the provider to land
            await page.wait_for_function(
                "(() => { const p = state.config.providers.hubonly;"
                " return p && p.origin === 'vault' && p.keys && Object.keys(p.keys).length > 0; })()",
                timeout=15000)

            res = await page.evaluate(
                "(() => { const p = state.config.providers.hubonly || {};"
                " const keys = p.keys || {};"
                " const k1 = keys.hk1 || {};"
                " return { origin: p.origin, protocol: p.protocol, base_url: p.base_url,"
                "          keyCount: Object.keys(keys).length,"
                "          keyOrigin: k1.origin, keyValue: k1.key,"
                "          keyReadOnly: k1.is_local === false }; })()")

            # KB mode: the pulled provider must be selectable for candidate binding
            kb_providers = None
            if mode == "kb":
                await page.evaluate("switchTab('models')")
                await page.wait_for_timeout(300)
                await page.evaluate("openCandidateModal('chat')")
                await page.wait_for_timeout(300)
                kb_providers = await page.evaluate(
                    "Array.from(document.querySelectorAll('#c_providerSelect option')).map(o => o.value)")
            return res, kb_providers, errors
        finally:
            await browser.close()


def run_mode(mode, hub_url, tmp_root):
    cfgdir = tmp_root / f"cfg-{mode}"
    cfgdir.mkdir()
    enc = Fernet.generate_key().decode()
    port = free_port()
    env = {
        **os.environ,
        "CONFIG_DIR": str(cfgdir), "ENCRYPT_KEY": enc,
        "ADMIN_PASSWORD": ADMIN_PW, "PROXY_API_KEY": PROXY_KEY,
        "APP_PORT": str(port), "APP_HOST": "127.0.0.1",
        "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
    }
    seed = ("import sys,asyncio,json;sys.path.insert(0,%r);from app import config_store;"
            "asyncio.run(config_store.save_config(json.loads(sys.argv[1])))" % str(VM))
    seed_res = subprocess.run([sys.executable, "-c", seed, json.dumps(vm_config(mode, hub_url))],
                              env=env, capture_output=True, text=True)
    assert seed_res.returncode == 0, seed_res.stderr[-800:]

    log = open(tmp_root / f"vm-{mode}.log", "w")
    proc = subprocess.Popen([sys.executable, "run_server.py"], cwd=VM, env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        assert wait_http(f"http://127.0.0.1:{port}/health"), \
            (tmp_root / f"vm-{mode}.log").read_text()[-1500:]
        return asyncio.run(run_browser(mode, port))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        log.close()


def main():
    hub_port = free_port()
    hub = ThreadingHTTPServer(("127.0.0.1", hub_port), _Hub)
    threading.Thread(target=hub.serve_forever, daemon=True).start()
    hub_url = f"http://127.0.0.1:{hub_port}"
    tmp_root = Path(tempfile.mkdtemp(prefix="vault-ui-"))
    fails = []
    try:
        for mode in ("kb", "agent"):
            res, kb_providers, errors = run_mode(mode, hub_url, tmp_root)
            print(f"\n=== {mode} 模式：从中枢按需拉取供应商 ===")
            print("  provider:", res)
            for name, ok, detail in [
                ("origin=vault", res["origin"] == "vault", f"origin={res['origin']}"),
                ("Key 已拉取", res["keyCount"] == 2, f"keyCount={res['keyCount']}"),
                ("Key 标记只读", res["keyOrigin"] == "vault" and res["keyReadOnly"], str(res)),
                ("密钥掩码下发", res["keyValue"] == "●●●●●●●●", f"value={res['keyValue']!r}"),
                ("无页面异常", not errors, "; ".join(errors[:2])),
            ]:
                print(f"  {'✓' if ok else '✗'} {name} ({detail})")
                if not ok:
                    fails.append(f"{mode}: {name} ({detail})")
            if mode == "kb":
                ok = kb_providers is not None and "hubonly" in kb_providers
                print(f"  {'✓' if ok else '✗'} KB 候选节点可选该供应商: {kb_providers}")
                if not ok:
                    fails.append(f"kb: candidate provider list missing hubonly: {kb_providers}")
    finally:
        hub.shutdown()
        shutil.rmtree(tmp_root, ignore_errors=True)

    if fails:
        print("\nFAILED:")
        for f in fails:
            print("  -", f)
        return 1
    print("\nPASS: 中枢按需拉取供应商（KB + Agent 双模式真实浏览器回归）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
