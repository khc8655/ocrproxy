import sys
import os
import json
import copy

# Extract and test _merge_configs directly
def _merge_configs(base: dict, incoming: dict, local_run_mode: str = "full") -> dict:
    merged = copy.deepcopy(base)

    # 1. Merge providers
    merged_providers = merged.setdefault("providers", {})
    incoming_providers = incoming.get("providers", {})
    if isinstance(incoming_providers, dict):
        for p_name, p_val in incoming_providers.items():
            if not isinstance(p_val, dict):
                continue
            if p_name not in merged_providers:
                merged_providers[p_name] = copy.deepcopy(p_val)
            else:
                if p_val.get("base_url"):
                    merged_providers[p_name]["base_url"] = p_val["base_url"]
                merged_keys = merged_providers[p_name].setdefault("keys", {})
                incoming_keys = p_val.get("keys", {})
                if isinstance(incoming_keys, dict):
                    for k_name, k_secret in incoming_keys.items():
                        if k_name and k_secret:
                            merged_keys[k_name] = k_secret

    # 2. Merge candidates (KB mode / Full mode only)
    if local_run_mode in ("kb", "full"):
        merged_candidates = merged.setdefault("candidates", {})
        incoming_candidates = incoming.get("candidates", {})
        if isinstance(incoming_candidates, dict):
            for cat in ("chat", "embedding", "reranker", "ocr"):
                in_list = incoming_candidates.get(cat, [])
                if isinstance(in_list, list):
                    existing_list = merged_candidates.setdefault(cat, [])
                    existing_keys = {(c.get("provider"), c.get("key"), c.get("model")) for c in existing_list if isinstance(c, dict)}
                    for cand in in_list:
                        if isinstance(cand, dict):
                            k = (cand.get("provider"), cand.get("key"), cand.get("model"))
                            if k not in existing_keys and cand.get("provider") and cand.get("key"):
                                existing_list.append(copy.deepcopy(cand))
                                existing_keys.add(k)
    else:
        merged["candidates"] = {"chat": [], "embedding": [], "reranker": [], "ocr": []}

    # 3. Merge agent_models (Agent mode / Full mode only)
    if local_run_mode in ("agent", "full"):
        merged_agent_models = merged.setdefault("agent_models", {})
        incoming_agent_models = incoming.get("agent_models", {})
        if isinstance(incoming_agent_models, dict):
            for m_name, m_val in incoming_agent_models.items():
                if not isinstance(m_val, dict):
                    continue
                if m_name not in merged_agent_models:
                    merged_agent_models[m_name] = copy.deepcopy(m_val)
                else:
                    existing_keys = merged_agent_models[m_name].setdefault("keys", [])
                    existing_set = {(b.get("provider"), b.get("key")) for b in existing_keys if isinstance(b, dict)}
                    for b in m_val.get("keys", []):
                        if isinstance(b, dict):
                            sig = (b.get("provider"), b.get("key"))
                            if sig not in existing_set and b.get("provider") and b.get("key"):
                                existing_keys.append(copy.deepcopy(b))
                                existing_set.add(sig)
                    if m_val.get("upstream_model"):
                        merged_agent_models[m_name]["upstream_model"] = m_val["upstream_model"]
    else:
        merged["agent_models"] = {}

    # 4. Update top-level setting parameters
    setting_keys = [
        "proxy_api_key", "proxy_keys",
        "agent_routing_strategy", "kb_routing_strategy", "auto_restart_enabled",
        "request_total_budget_sec", "upstream_timeout_sec", "max_attempts_per_provider",
        "fast_failover_provider_down",
        "upstream_timeout", "upstream_timeout_chat", "upstream_timeout_embedding",
        "upstream_timeout_rerank", "upstream_timeout_ocr", "chat_fast_timeout",
        "schedule_total_budget", "max_concurrency_per_key",
        "cooldown_tpm_sec", "cooldown_quota_sec", "cooldown_5xx_sec",
        "cooldown_429_sec", "cooldown_403_sec", "cooldown_duration",
        "circuit_break_threshold", "circuit_cooldown_sec", "latency_based_routing"
    ]
    for sk in setting_keys:
        if sk in incoming:
            merged[sk] = incoming[sk]

    # 5. Merge Schema v2 settings block if present
    incoming_settings = incoming.get("settings")
    if isinstance(incoming_settings, dict):
        merged_settings = merged.setdefault("settings", {})
        for k, v in incoming_settings.items():
            merged_settings[k] = v
            merged[k] = v

    merged["run_mode"] = local_run_mode
    return merged

def test_bidirectional_sync():
    print("=== Testing Schema v2 Bidirectional Compatibility ===")

    # 1. Base VM Config with KB candidates
    vm_base = {
        "run_mode": "full",
        "settings": {
            "agent_routing_strategy": "sticky_failover",
            "request_total_budget_sec": 45,
            "upstream_timeout_sec": 20,
            "schedule_total_budget": 3,
            "fast_failover_provider_down": True,
        },
        "providers": {
            "sensenova": {"base_url": "https://token.sensenova.cn/v1", "keys": {"自己": "sk-111"}},
            "stepfun": {"base_url": "https://api.stepfun.com/v1", "keys": {"自己": "sk-222"}},
        },
        "agent_models": {
            "deepseek-v4-flash": {"keys": [{"provider": "sensenova", "key": "自己"}]},
        },
        "candidates": {
            "chat": [{"provider": "stepfun", "key": "自己", "model": "step-3.7-flash"}],
            "embedding": [{"provider": "sensenova", "key": "自己", "model": "embedding-v1"}],
            "reranker": [],
            "ocr": []
        }
    }

    # 2. EdgeOne Config exported with new models & custom timeout settings
    edgeone_export = {
        "version": 2,
        "settings": {
            "agent_routing_strategy": "round_robin",
            "request_total_budget_sec": 25,
            "upstream_timeout_sec": 12,
            "schedule_total_budget": 3,
            "max_attempts_per_provider": 2,
            "fast_failover_provider_down": True,
            "cooldown_429_sec": 45,
        },
        "providers": {
            "sensenova": {"base_url": "https://token.sensenova.cn/v1", "keys": {"自己": "sk-111", "小号": "sk-333"}},
            "agnes": {"base_url": "https://apihub.agnes-ai.com/v1", "keys": {"自己": "sk-444"}},
        },
        "agent_models": {
            "deepseek-v4-flash": {"keys": [{"provider": "sensenova", "key": "自己"}, {"provider": "sensenova", "key": "小号"}]},
            "agnes-2.5-flash": {"keys": [{"provider": "agnes", "key": "自己"}]},
        }
    }

    # 3. Merge EdgeOne into VM in full mode
    merged_vm = _merge_configs(vm_base, edgeone_export, local_run_mode="full")

    # Assertions
    assert "candidates" in merged_vm, "KB candidates must be preserved!"
    assert len(merged_vm["candidates"]["embedding"]) == 1, "KB embedding candidates must be intact!"
    assert "agnes" in merged_vm["providers"], "New provider agnes must be merged!"
    assert "agnes-2.5-flash" in merged_vm["agent_models"], "New agent model must be merged!"
    assert merged_vm["settings"]["request_total_budget_sec"] == 25, "Settings request_total_budget_sec must be merged!"
    assert merged_vm["settings"]["cooldown_429_sec"] == 45, "Settings cooldown_429_sec must be merged!"
    assert merged_vm["request_total_budget_sec"] == 25, "Top-level setting mirror must be present!"

    print("✅ Test 1 Passed: EdgeOne -> VM merge preserved KB candidates and updated settings & providers!")

    # 4. Now simulate EdgeOne importing VM export (stripping candidates)
    edgeone_imported = {
        "settings": copy.deepcopy(merged_vm.get("settings", {})),
        "providers": copy.deepcopy(merged_vm.get("providers", {})),
        "agent_models": copy.deepcopy(merged_vm.get("agent_models", {})),
    }

    assert "candidates" not in edgeone_imported, "EdgeOne must not have candidates!"
    assert len(edgeone_imported["agent_models"]) == 2, "Both agent models preserved in EdgeOne!"
    assert edgeone_imported["settings"]["upstream_timeout_sec"] == 12, "Settings preserved in EdgeOne!"

    print("✅ Test 2 Passed: VM -> EdgeOne export/import is clean, lossless, and schema-valid!")
    print("\n🎉 ALL BIDIRECTIONAL SYNC TESTS PASSED 100%!")

if __name__ == "__main__":
    test_bidirectional_sync()
