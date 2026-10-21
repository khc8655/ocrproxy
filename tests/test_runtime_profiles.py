"""tests/test_runtime_profiles.py — Layer 1: 三运行时默认值唯一真理源。

校验 shared/config/runtime-profiles.json 与两端的消费方式一致：
  * profile 只包含「流程相同、数值不同」的默认值（schema 中均有同名字段）；
  * VM scheduler 的硬编码常量/默认值来自 profile，而不是各写一份；
  * EdgeOne 的 DEFAULT_SETTINGS / COOLDOWN_DURATIONS 由构建期生成，且与 JSON 一致
    （防止 lib/config.js / lib/cooldowns.js 再手写一份副本）；
  * schema 里 quota / 404 / 410 / circuit escalation / kb global 并发是独立字段，
    不再借 cooldown_403_sec 的别名表达不同策略。
"""
import json
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "vm-app"))

PROFILES_PATH = os.path.join(REPO_ROOT, "shared", "config", "runtime-profiles.json")
SCHEMA_PATH = os.path.join(REPO_ROOT, "shared", "config", "settings.schema.json")
EDGE_GENERATED = os.path.join(REPO_ROOT, "edge-functions", "lib", "generated", "runtime-profile.js")


def _load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def test_profiles_shape():
    data = _load(PROFILES_PATH)
    profiles = data.get("profiles") or {}
    assert set(profiles) == {"edgeone", "vm-agent", "vm-kb"}, profiles.keys()
    agent = profiles["vm-agent"]["settings"]
    kb = profiles["vm-kb"]["settings"]
    edge = profiles["edgeone"]["settings"]
    assert agent["agent_first_byte_timeout_sec"] == 120
    assert kb["upstream_timeout_sec"] == 15 and kb["upstream_timeout_kb"] == 60
    assert edge["upstream_timeout_sec"] == 120
    # KB-only knobs must not leak into the agent profile
    for kb_only in ("kb_max_concurrency_per_key", "kb_global_max_concurrency",
                    "ocr_max_inflight", "circuit_escalation_sec"):
        assert kb_only not in agent, f"{kb_only} must be KB-only"
    print("PASS profiles: three runtime profiles with mode-specific defaults")


def test_profile_keys_exist_in_schema():
    schema = _load(SCHEMA_PATH)
    keys = {f["key"] for f in schema["fields"]}
    profiles = _load(PROFILES_PATH)["profiles"]
    for name, prof in profiles.items():
        for key in (prof.get("settings") or {}):
            assert key in keys, f"profile {name} setting {key} has no schema field"
    # independently-configurable policies, no cross-policy aliases
    by_key = {f["key"]: f for f in schema["fields"]}
    for key, default in (("cooldown_quota_sec", 1800), ("cooldown_404_sec", 600),
                         ("cooldown_410_sec", 86400), ("circuit_escalation_sec", 1800),
                         ("kb_global_max_concurrency", 30)):
        assert key in by_key, f"missing schema field {key}"
        assert by_key[key].get("default") == default, (key, by_key[key].get("default"))
    assert "cooldown_quota_sec" not in (by_key["cooldown_403_sec"].get("aliases") or [])
    assert "upstream_timeout_chat" not in (by_key["agent_first_byte_timeout_sec"].get("aliases") or [])
    print("PASS schema: profile keys are schema fields; distinct policies are not aliases")


def test_vm_defaults_come_from_profile():
    from app import runtime_profile
    from app import scheduler
    profiles = _load(PROFILES_PATH)["profiles"]
    kb = profiles["vm-kb"]["settings"]
    agent = profiles["vm-agent"]["settings"]
    assert runtime_profile.settings({"run_mode": "agent"})["agent_first_byte_timeout_sec"] == agent["agent_first_byte_timeout_sec"]
    assert runtime_profile.settings({"run_mode": "kb"})["upstream_timeout_kb"] == kb["upstream_timeout_kb"]
    assert scheduler._KB_DEFAULT_KEY_CONCURRENCY == kb["kb_max_concurrency_per_key"]
    assert scheduler._GLOBAL_MAX_CONCURRENCY == kb["kb_global_max_concurrency"]
    assert scheduler.DEFAULT_COOLDOWN_410_SEC == agent["cooldown_410_sec"]
    print("PASS VM: scheduler constants resolve from the shared profile")


def test_edge_generated_module_matches_profile():
    js = r"""
import { RUNTIME_PROFILE, DEFAULT_SETTINGS, COOLDOWN_DURATIONS, CIRCUIT_BREAKER_THRESHOLD } from './edge-functions/lib/generated/runtime-profile.js';
console.log(JSON.stringify({ profile: RUNTIME_PROFILE, settings: DEFAULT_SETTINGS, cooldowns: COOLDOWN_DURATIONS, threshold: CIRCUIT_BREAKER_THRESHOLD }));
"""
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO_ROOT,
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    edge = _load(PROFILES_PATH)["profiles"]["edgeone"]
    assert out["settings"] == edge["settings"], "generated DEFAULT_SETTINGS drifted from runtime-profiles.json"
    cooldowns = dict(edge["cooldowns"])
    threshold = cooldowns.pop("CIRCUIT_BREAKER_THRESHOLD", 3)
    assert out["cooldowns"] == cooldowns, "generated COOLDOWN_DURATIONS drifted"
    assert out["threshold"] == threshold
    assert out["profile"]["settings"] == edge["settings"]
    print("PASS Edge: generated runtime-profile.js matches the JSON source")


def test_edge_sources_have_no_hand_copied_defaults():
    cfg = open(os.path.join(REPO_ROOT, "edge-functions", "lib", "config.js"), encoding="utf-8").read()
    cds = open(os.path.join(REPO_ROOT, "edge-functions", "lib", "cooldowns.js"), encoding="utf-8").read()
    assert "generated/runtime-profile.js" in cfg and "generated/runtime-profile.js" in cds
    assert "circuit_cooldown_sec: 60" not in cfg, "hand-copied circuit cooldown resurrected"
    assert "TPM_429: 60" not in cds.split("generated/runtime-profile.js")[-1], "hand-copied cooldown table resurrected"
    print("PASS Edge: no hand-copied defaults/cooldown tables")


if __name__ == "__main__":
    test_profiles_shape()
    test_profile_keys_exist_in_schema()
    test_vm_defaults_come_from_profile()
    test_edge_generated_module_matches_profile()
    test_edge_sources_have_no_hand_copied_defaults()
    print("\nALL RUNTIME PROFILE CHECKS PASSED")
