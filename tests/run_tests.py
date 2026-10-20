#!/usr/bin/env python3
"""tests/run_tests.py — Layered Test Runner for OCRProxy

Usage:
  python tests/run_tests.py --layer=core   # Layer 1: Core Logic & Presets (Node.js ESM + CoW Python)
  python tests/run_tests.py --layer=api    # Layer 2: Backend API Routes & Cascading Deletion
  python tests/run_tests.py --layer=ui     # Layer 3: Headless UI Structure & Style Validation
  python tests/run_tests.py --layer=e2e    # Layer 4: Full Matrix E2E Test Suite
  python tests/run_tests.py --layer=all    # All Layers

Rules:
  - Real requests and assertions only. Zero mock frameworks.
  - Fail-fast with informative layer summaries.
"""

import sys
import os
import argparse
import subprocess
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_EXE = sys.executable


def run_command(cmd, desc, env=None):
    print(f"\n========================================================")
    print(f"▶ [{desc}]")
    print(f"  Command: {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    print(f"========================================================")
    t0 = time.time()
    res = subprocess.run(cmd, cwd=REPO_ROOT, shell=isinstance(cmd, str), env=env)
    elapsed = time.time() - t0
    if res.returncode != 0:
        print(f"❌ FAILED: {desc} (Exit {res.returncode}, elapsed: {elapsed:.2f}s)")
        return False
    print(f"✓ PASSED: {desc} (elapsed: {elapsed:.2f}s)")
    return True


def run_layer_core():
    print("\n########################################################")
    print("### Layer 1: Core Pure-Logic & Upstream Protocol Tests")
    print("########################################################")
    # 1. EdgeOne ESM Pure-Logic unit tests (198 tests)
    ok1 = run_command(["node", "agent-edgeone/scripts/test-units.mjs"], "EdgeOne ESM Units & Preset Hub")
    if not ok1:
        return False

    # 2. Python CoW and Token Isolation Tests
    ok2 = run_command([PYTHON_EXE, "tests/test_phase1_security_and_cow.py"], "Python CoW & Fail-Closed Token Isolation")
    if not ok2:
        return False
    return run_command([PYTHON_EXE, "tests/test_agent_metrics.py"], "VM Agent Dashboard Summary (tokens / TTFT / failures)")


def run_layer_api():
    print("\n########################################################")
    print("### Layer 2: Backend API Routes & Lifecycle Integration")
    print("########################################################")
    ok1 = run_command([PYTHON_EXE, "tests/test_api_layer.py"], "FastAPI API Auth, Cascade Deletion & Vault Pull Rules")
    if not ok1:
        return False
    ok2 = run_command([PYTHON_EXE, "tests/test_backend_contract.py"], "Shared UI Backend Contract (VM vs EdgeOne)")
    return ok2


def run_layer_ui():
    print("\n########################################################")
    print("### Layer 3: Headless UI Structure & Style Matrix")
    print("########################################################")
    # Validates UI single-source components and CSS styles
    ok = run_command([PYTHON_EXE, "tests/test_phase1_security_and_cow.py"], "UI Event Delegation & No Inline Handler Assertions")
    if not ok:
        return False
    return run_command([PYTHON_EXE, "tests/test_ui_no_horizontal_overflow.py"], "Narrow Viewport No Horizontal Overflow (VM vs EdgeOne)")


def run_layer_e2e():
    print("\n########################################################")
    print("### Layer 4: Full Matrix E2E Playwright Suite")
    print("########################################################")
    return run_command([PYTHON_EXE, "tests/test_vm_full_matrix_e2e.py"], "VM Full Matrix E2E Browser & Backend Integration")


def main():
    parser = argparse.ArgumentParser(description="OCRProxy Layered Test Runner")
    parser.add_argument(
        "--layer",
        choices=["core", "api", "ui", "e2e", "all"],
        default="all",
        help="Test layer to execute (core | api | ui | e2e | all)"
    )
    args = parser.parse_args()

    layers_to_run = []
    if args.layer == "core":
        layers_to_run.append(("core", run_layer_core))
    elif args.layer == "api":
        layers_to_run.append(("api", run_layer_api))
    elif args.layer == "ui":
        layers_to_run.append(("ui", run_layer_ui))
    elif args.layer == "e2e":
        layers_to_run.append(("e2e", run_layer_e2e))
    elif args.layer == "all":
        layers_to_run.append(("core", run_layer_core))
        layers_to_run.append(("api", run_layer_api))
        layers_to_run.append(("ui", run_layer_ui))
        layers_to_run.append(("e2e", run_layer_e2e))

    total_t0 = time.time()
    for layer_name, runner_fn in layers_to_run:
        passed = runner_fn()
        if not passed:
            print(f"\n❌ Test suite aborted due to failure in layer: {layer_name}")
            sys.exit(1)

    total_elapsed = time.time() - total_t0
    print("\n========================================================")
    print(f"🎉 ALL REQUESTED TEST LAYERS COMPLETED SUCCESSFULLY! ({total_elapsed:.2f}s)")
    print("========================================================\n")


if __name__ == "__main__":
    main()
