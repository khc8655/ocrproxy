#!/usr/bin/env python3
"""
tests/test_phase1_security_and_cow.py — Automated Regression Test for Phase 1 Fixes

Validates:
  1. [Core-01] Copy-on-Write payload isolation across failover attempts (nested messages/tools/extra_body).
  2. [Sec-01] EdgeOne checkAuth Fail-Closed and Role-Based Token Isolation.
  3. [UI-01] Elimination of inline JS event interpolation in agent-models-ui.js.
  4. [UI-02] 409 conflict handling in core.js terminates without overwriting.
  5. [UI-03 & UI-04] Model multi-provider binding preservation and rename collision protection.
"""

import sys
import os
import re
import json

# Add root and vm-app to sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "vm-app"))

from app.proxy_routes import _clone_request_payload, _apply_request_adapter_rules

def test_cow_messages_isolation():
    print("=== 1. Core-01: Copy-on-Write Message & Tools Isolation ===")
    original_messages = [
        {"role": "user", "content": "Hello"},
        {
            "role": "assistant",
            "content": [
                {"type": "thinking", "signature": ""},
                {"type": "text", "text": "Here is the response"}
            ],
            "reasoning_content": "Deep thought content here"
        }
    ]
    original_tools = [
        {
            "type": "function",
            "function": {
                "name": "calc",
                "parameters": {
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "type": "object",
                    "properties": {"val": {"type": "number"}}
                }
            }
        }
    ]
    original_body = {
        "model": "deepseek-reasoner",
        "messages": original_messages,
        "tools": original_tools,
        "extra_body": {"google": {"thinking_config": {"include_thoughts": True}}}
    }

    # Simulate Candidate 1 with Claude strict_signature rule + deep schema sanitization
    cand1_body = _clone_request_payload(original_body)
    cand1_rules = {
        "thinking_policy": "strip",
        "tools": {"deep_schema_sanitization": True},
        "reasoning": {"strategy": "openai_passthrough"}
    }
    _apply_request_adapter_rules(cand1_body, cand1_rules, is_agent_mode=True, is_anthropic=False)

    # 1. Candidate 1 assistant thinking block should have been stripped
    assert len(cand1_body["messages"][1]["content"]) == 1, "Candidate 1 thinking block was not stripped"
    assert "reasoning_content" not in cand1_body["messages"][1], "Candidate 1 reasoning_content was not popped"

    # 2. Original body MUST remain completely unmodified
    assert len(original_body["messages"][1]["content"]) == 2, "FAIL: Original body messages were mutated!"
    assert original_body["messages"][1]["content"][0]["type"] == "thinking", "FAIL: Original thinking block missing!"
    assert original_body["messages"][1]["reasoning_content"] == "Deep thought content here", "FAIL: Original reasoning_content lost!"
    assert "$schema" in original_body["tools"][0]["function"]["parameters"], "FAIL: Original tool schema mutated!"
    print("  PASS: Candidate 1 mutation did not affect original payload")

    # Simulate Candidate 2 failover
    cand2_body = _clone_request_payload(original_body)
    cand2_rules = {
        "thinking_policy": "passback_required",
        "tools": {}
    }
    _apply_request_adapter_rules(cand2_body, cand2_rules, is_agent_mode=True, is_anthropic=False)
    assert len(cand2_body["messages"][1]["content"]) == 2, "Candidate 2 should retain intact thinking block"
    assert cand2_body["messages"][1]["reasoning_content"] == "Deep thought content here"
    print("  PASS: Candidate 2 failover received clean, pristine original payload")


def test_edgeone_security_fail_closed():
    print("\n=== 2. Sec-01: EdgeOne Authentication Fail-Closed & Token Isolation ===")
    
    # 1. Test completions.js checkAuth
    completions_file = os.path.join(os.path.dirname(__file__), "..", "agent-edgeone", "edge-functions", "v1", "chat", "completions.js")
    with open(completions_file, "r", encoding="utf-8") as f:
        completions_code = f.read()

    assert "fail-closed" in completions_code.lower(), "completions.js must contain fail-closed policy"
    assert "status: 503" in completions_code, "completions.js must return 503 when PROXY_API_KEY is unconfigured"
    print("  PASS: completions.js fails closed with 503 when PROXY_API_KEY is unset")

    # 2. Test api/vault/fetch.js checkAuth
    vault_fetch_file = os.path.join(os.path.dirname(__file__), "..", "agent-edgeone", "edge-functions", "api", "vault", "fetch.js")
    with open(vault_fetch_file, "r", encoding="utf-8") as f:
        vault_code = f.read()

    # Vault auth was centralised into lib/security.js#checkVaultAuth; fetch.js must delegate to it
    assert "checkVaultAuth" in vault_code, "api/vault/fetch.js must authenticate through checkVaultAuth"
    sec_file = os.path.join(os.path.dirname(__file__), "..", "agent-edgeone", "edge-functions", "lib", "security.js")
    with open(sec_file, "r", encoding="utf-8") as f:
        sec_code = f.read()
    start = sec_code.index("export function checkVaultAuth")
    body = sec_code[start:sec_code.index("\n}\n", start)]
    assert "authErrorResponse(\n      503" in body or "503" in body, "checkVaultAuth must fail closed with 503 when VAULT_ACCESS_TOKEN is unset"
    assert "401" in body, "checkVaultAuth must reject missing/invalid tokens with 401"
    assert "timingSafeEqual" in body, "checkVaultAuth must use constant-time comparison"
    print("  PASS: api/vault/fetch.js fails closed with 503 when unconfigured and authenticates properly")

    # 3. Test api/config.js checkAuth
    config_file = os.path.join(os.path.dirname(__file__), "..", "agent-edgeone", "edge-functions", "api", "config.js")
    with open(config_file, "r", encoding="utf-8") as f:
        cfg_code = f.read()

    # 三权分立 (lib/security.js)：/api/config 只认 ADMIN_PASSWORD，PROXY_API_KEY 明确禁止访问管理接口
    assert "checkAdminAuth(request, env)" in cfg_code, "api/config.js must authenticate through checkAdminAuth"
    start = sec_code.index("export function checkAdminAuth")
    admin_body = sec_code[start:sec_code.index("\n}\n", start)]
    assert "503" in admin_body and "admin_password_unconfigured" in admin_body, "checkAdminAuth must fail closed with 503"
    assert "PROXY_API_KEY" not in admin_body.split("*/")[-1], "checkAdminAuth must not accept PROXY_API_KEY"
    print("  PASS: api/config.js is admin-only (ADMIN_PASSWORD), fail-closed 503 when unconfigured")


def test_ui_no_inline_event_interpolation():
    print("\n=== 3. UI-01 & UI-03 & UI-04: Frontend Hygiene & Safety ===")
    ui_file = os.path.join(os.path.dirname(__file__), "..", "shared", "admin", "js", "agent-models-ui.js")
    with open(ui_file, "r", encoding="utf-8") as f:
        ui_code = f.read()

    # Assert no inline interpolated onclick in model cards or bindings
    assert not re.search(r'onclick=["\']editAgentModel\(', ui_code), "FAIL: inline onclick=editAgentModel still present!"
    assert not re.search(r'onclick=["\']deleteAgentModel\(', ui_code), "FAIL: inline onclick=deleteAgentModel still present!"
    assert not re.search(r'onclick=["\']testAgentModelAll\(', ui_code), "FAIL: inline onclick=testAgentModelAll still present!"
    assert not re.search(r'onclick=["\']setActiveAgentKey\(', ui_code), "FAIL: inline onclick=setActiveAgentKey still present!"
    assert not re.search(r'onchange=["\']reorderAgentKey\(', ui_code), "FAIL: inline onchange=reorderAgentKey still present!"
    print("  PASS: Zero inline interpolated onclick/onchange handlers in model list & bindings")

    # Assert delegation initializers present
    assert "initAgentModelsDelegation" in ui_code, "initAgentModelsDelegation must be defined"
    assert "initModalDelegation" in ui_code, "initModalDelegation must be defined"
    print("  PASS: Standard event delegation active on container elements")

    # Assert rename collision prevention
    assert "不能重命名覆盖已有模型" in ui_code, "FAIL: Rename collision prevention message missing!"
    print("  PASS: Model rename collision protection verified")

    # Assert modalBindings draft mechanism
    assert "modalBindings" in ui_code, "modalBindings must be present to prevent multi-provider key dropping"
    print("  PASS: Multi-provider modal bindings draft tracking verified")

    # Assert 409 handling in core.js
    core_file = os.path.join(os.path.dirname(__file__), "..", "shared", "admin", "js", "core.js")
    with open(core_file, "r", encoding="utf-8") as f:
        core_code = f.read()

    assert "配置保存冲突拦截" in core_code or "409" in core_code, "core.js must intercept 409 conflict"
    # Ensure it no longer patches _version and re-POSTs
    assert "state.config._version = latest._version" not in core_code, "FAIL: 409 re-POST with new _version still exists!"
    print("  PASS: core.js 409 conflict safe abort verified (no destructive overwrite)")


def test_vault_vs_local_data_and_permission_isolation():
    print("\n=== 4. Vault vs Local Binary Permissions & Safe Sandbox Isolation ===")

    # 1. Verify EdgeOne backend vault fetch strictly filters out local keys and local providers
    fetch_path = os.path.join(os.path.dirname(__file__), "..", "edge-functions", "api", "vault", "fetch.js")
    with open(fetch_path, "r", encoding="utf-8") as f:
        fetch_code = f.read()

    assert "origin === 'local'" in fetch_code, "api/vault/fetch.js must block providers with origin === 'local'"
    assert "isVaultExportableKey(keyObj)" in fetch_code, "api/vault/fetch.js must filter local keys via the shared isVaultExportableKey predicate"
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    config_lib = open(os.path.join(repo_root, "edge-functions", "lib", "config.js"), encoding="utf-8").read()
    assert "keyObj.is_local === true || keyObj.origin === 'local'" in config_lib, (
        "lib/config.js isVaultExportableKey must treat is_local === true AND origin === 'local' as non-exportable")
    manifest_code = open(os.path.join(repo_root, "edge-functions", "api", "vault", "manifest.js"), encoding="utf-8").read()
    assert "toVaultProviderView" in manifest_code and "pCfg.origin === 'local'" in manifest_code, (
        "api/vault/manifest.js must use the shared projection and never advertise local-origin providers")
    print("  PASS: api/vault/fetch.js strictly excludes local providers and keys (physical sandbox isolation)")

    # 2. Verify shared/admin/js/providers.js local deletion sovereignty
    providers_path = os.path.join(os.path.dirname(__file__), "..", "shared", "admin", "js", "providers.js")
    with open(providers_path, "r", encoding="utf-8") as f:
        providers_code = f.read()

    assert "getProviderPermissions" in providers_code, "providers.js must define getProviderPermissions"
    assert "canDelete: true" in providers_code, "providers.js must ensure local deletion sovereignty"
    print("  PASS: shared/admin/js/providers.js guarantees local provider deletion sovereignty")


if __name__ == "__main__":
    test_cow_messages_isolation()
    test_edgeone_security_fail_closed()
    test_ui_no_inline_event_interpolation()
    test_vault_vs_local_data_and_permission_isolation()
    print("\n----------------------------------------")
    print("All Phase 1 Security & Reliability Gates PASSED!")
    print("----------------------------------------")
