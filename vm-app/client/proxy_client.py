#!/usr/bin/env python3
from __future__ import annotations
"""
OCRProxy 客户端 TLS 适配模块
================================

解决阿里云对未备案域名的 TLS 1.2 拦截问题。

阿里云 DPI (深度包检测) 会拦截发往未备案域名的 TLS 1.2 ClientHello，
只允许 TLS 1.3 通过。但部分客户端环境（macOS 系统 Python、旧版 Windows
Python 等）的 SSL 库不支持 TLS 1.3，导致连接被重置。

本模块提供两种解决方案：
  1. 如果当前 Python 支持 TLS 1.3 → 直接创建 OpenAI 客户端
  2. 如果不支持 → 使用 uv 安装自带 OpenSSL 3.x 的独立 Python

用法:
  from proxy_client import create_client

  client = create_client(
      base_url="https://a.jjb0888.cn:8449/v1",
      api_key="your-api-key",
  )
  # client 就是一个标准的 openai.OpenAI 实例
  resp = client.chat.completions.create(
      model="chat",
      messages=[{"role": "user", "content": "你好"}],
  )

诊断模式 (直接运行本文件):
  python3 proxy_client.py

自动安装现代 Python:
  python3 proxy_client.py --setup
"""

import os
import sys
import ssl
import subprocess
import shutil
import json
from pathlib import Path

DEFAULT_BASE_URL = "https://a.jjb0888.cn:8449/v1"
DEFAULT_API_KEY = ""


def get_ssl_info() -> dict:
    """获取当前 Python 的 SSL 信息。"""
    info = {
        "python_version": sys.version.split()[0],
        "ssl_version": ssl.OPENSSL_VERSION,
        "tls13_supported": False,
        "tls13_error": "",
    }
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.load_default_certs()
        info["tls13_supported"] = True
    except (ValueError, AttributeError) as e:
        info["tls13_error"] = str(e)
    return info


def supports_tls13() -> bool:
    """检查当前 Python 是否真正支持 TLS 1.3。"""
    info = get_ssl_info()
    return info["tls13_supported"]


def _find_uv_python() -> str | None:
    """查找 uv 安装的 Python 3.12+。"""
    uv = shutil.which("uv")
    if not uv:
        return None
    try:
        result = subprocess.run(
            [uv, "python", "find", "3.12+"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            py_path = result.stdout.strip()
            if py_path and os.path.isfile(py_path):
                return py_path
    except Exception:
        pass
    return None


def _install_uv_python() -> str | None:
    """使用 uv 安装 Python 3.12 (自带 OpenSSL 3.x)。"""
    # 1. 确保 uv 已安装
    uv = shutil.which("uv")
    if not uv:
        print("[setup] 正在安装 uv...")
        if sys.platform == "win32":
            subprocess.run(
                ["powershell", "-ExecutionPolicy", "ByPass", "-c",
                 "irm https://astral.sh/uv/install.ps1 | iex"],
                check=True, shell=True
            )
        else:
            subprocess.run(
                ["bash", "-c",
                 "curl -LsSf https://astral.sh/uv/install.sh | sh"],
                check=True
            )
        # 刷新 PATH
        uv_dir = os.path.expanduser("~/.local/bin") if sys.platform != "win32" else os.path.expanduser("~\\.local\\bin")
        os.environ["PATH"] = uv_dir + os.pathsep + os.environ.get("PATH", "")
        uv = shutil.which("uv")
        if not uv:
            print("[setup] uv 安装失败，请手动安装: https://docs.astral.sh/uv/")
            return None

    # 2. 安装 Python 3.12
    print("[setup] 正在通过 uv 安装 Python 3.12 (自带 OpenSSL 3.x)...")
    result = subprocess.run(
        [uv, "python", "install", "3.12"],
        capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        print(f"[setup] uv python install 失败: {result.stderr}")
        return None

    # 3. 查找安装的 Python
    return _find_uv_python()


def _run_with_uv_python(py_path: str, base_url: str, api_key: str):
    """使用指定的 Python 创建 OpenAI 客户端 (通过子进程桥接)。

    由于当前进程的 Python 不支持 TLS 1.3，我们启动一个使用 uv Python
    的子进程来运行实际的网络请求，并通过 stdin/stdout 传递请求和响应。
    """
    # 这种方式太复杂且不实用，改为直接建议用户使用 uv Python
    raise NotImplementedError(
        "请使用 uv 安装的 Python 直接运行你的脚本。\n"
        "运行以下命令设置环境:\n"
        "  uv python install 3.12\n"
        "  uv venv --python 3.12\n"
        "  source .venv/bin/activate  # Windows: .venv\\Scripts\\activate\n"
        "  pip install openai\n"
        "然后直接使用 openai.OpenAI(...) 即可。"
    )


def create_client(
    base_url: str = DEFAULT_BASE_URL,
    api_key: str = DEFAULT_API_KEY,
    **kwargs,
):
    """
    创建一个配置好 TLS 1.3 的 OpenAI 客户端。

    如果当前 Python 支持 TLS 1.3，直接返回 openai.OpenAI 实例。
    如果不支持，打印安装指引并抛出异常。

    Args:
        base_url: 代理服务地址 (含 /v1)
        api_key: 代理服务的 API Key
        **kwargs: 传递给 openai.OpenAI 的额外参数

    Returns:
        openai.OpenAI 实例

    Raises:
        RuntimeError: 当前环境不支持 TLS 1.3 且无法自动修复
    """
    if supports_tls13():
        # 当前 Python 支持 TLS 1.3，直接创建客户端
        try:
            from openai import OpenAI
        except ImportError:
            raise ImportError("请先安装 openai: pip install openai")

        return OpenAI(api_key=api_key, base_url=base_url, **kwargs)

    # 不支持 TLS 1.3，尝试找 uv Python
    uv_python = _find_uv_python()
    if uv_python:
        raise RuntimeError(
            f"当前 Python ({sys.version.split()[0]}) 不支持 TLS 1.3。\n"
            f"检测到 uv Python: {uv_python}\n"
            f"请使用该 Python 运行你的脚本:\n"
            f"  {uv_python} -m pip install openai\n"
            f"  {uv_python} your_script.py\n"
            f"\n或者创建虚拟环境:\n"
            f"  uv venv --python 3.12\n"
            f"  source .venv/bin/activate\n"
            f"  pip install openai"
        )

    # 没有 uv Python，提示安装
    raise RuntimeError(
        f"当前 Python ({sys.version.split()[0]}, {ssl.OPENSSL_VERSION}) 不支持 TLS 1.3。\n"
        f"阿里云拦截 TLS 1.2 流量，必须使用 TLS 1.3。\n"
        f"\n解决方案 (任选其一):\n"
        f"\n方案 A - 使用 uv 安装现代 Python (推荐，一键安装):\n"
        f"  curl -LsSf https://astral.sh/uv/install.sh | sh  # Windows: powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"\n"
        f"  uv python install 3.12\n"
        f"  uv venv --python 3.12\n"
        f"  source .venv/bin/activate  # Windows: .venv\\Scripts\\activate\n"
        f"  pip install openai\n"
        f"\n方案 B - 从 python.org 安装 Python 3.12+:\n"
        f"  https://www.python.org/downloads/\n"
        f"\n方案 C - macOS Homebrew:\n"
        f"  brew install python@3.12\n"
        f"\n运行本模块的 --setup 参数可自动执行方案 A:\n"
        f"  python3 proxy_client.py --setup"
    )


def diagnose():
    """运行诊断，打印当前环境信息并测试连接。"""
    info = get_ssl_info()

    print("=" * 60)
    print("OCRProxy TLS 诊断")
    print("=" * 60)
    print(f"Python:       {info['python_version']}")
    print(f"SSL Library:  {info['ssl_version']}")
    print(f"TLS 1.3:      {'✅ 支持' if info['tls13_supported'] else '❌ 不支持'}")
    if info["tls13_error"]:
        print(f"  错误: {info['tls13_error']}")

    # 检查 uv
    uv = shutil.which("uv")
    print(f"uv:           {'✅ ' + uv if uv else '❌ 未安装'}")

    if uv:
        uv_python = _find_uv_python()
        if uv_python:
            # 检查 uv Python 的 SSL 信息
            try:
                result = subprocess.run(
                    [uv_python, "-c",
                     "import ssl; print(ssl.OPENSSL_VERSION)"],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    print(f"uv Python:    ✅ {uv_python}")
                    print(f"  SSL: {result.stdout.strip()}")
            except Exception:
                pass
        else:
            print(f"uv Python:    ⚠️ 尚未安装 (运行: uv python install 3.12)")

    print()

    # 测试连接
    if info["tls13_supported"]:
        print("--- 测试连接 (TLS 1.3) ---")
        import urllib.request
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        ctx.load_default_certs()
        req = urllib.request.Request(
            f"{DEFAULT_BASE_URL}/models",
            headers={"Authorization": f"Bearer {DEFAULT_API_KEY or 'test'}"},
        )
        try:
            resp = urllib.request.urlopen(req, context=ctx, timeout=15)
            print(f"✅ 连接成功: HTTP {resp.status}")
            if DEFAULT_API_KEY:
                data = json.loads(resp.read())
                print(f"   模型: {[m['id'] for m in data['data']]}")
        except Exception as e:
            print(f"❌ 连接失败: {type(e).__name__}: {e}")
    else:
        print("--- 连接测试 ---")
        print("❌ 当前 Python 不支持 TLS 1.3，无法连接到代理服务")
        print(f"   原因: {info['tls13_error']}")
        print()
        print("解决方法:")
        print("  1. 运行: python3 proxy_client.py --setup")
        print("  2. 或手动安装 Python 3.12+ from python.org")

    print()
    print("=" * 60)


def setup():
    """自动安装 uv 和 Python 3.12。"""
    print("=" * 60)
    print("OCRProxy 客户端环境配置")
    print("=" * 60)
    print()

    py_path = _install_uv_python()
    if py_path:
        # 验证
        result = subprocess.run(
            [py_path, "-c",
             "import ssl; print(ssl.OPENSSL_VERSION); "
             "ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); "
             "ctx.minimum_version = ssl.TLSVersion.TLSv1_3; "
             "print('TLS 1.3: OK')"],
            capture_output=True, text=True, timeout=10
        )
        print()
        print(f"✅ Python 已安装: {py_path}")
        print(f"   {result.stdout.strip()}")

        # 创建虚拟环境
        venv_path = Path.cwd() / ".venv"
        if not venv_path.exists():
            print()
            print("--- 创建虚拟环境 ---")
            uv = shutil.which("uv")
            subprocess.run(
                [uv, "venv", "--python", py_path, str(venv_path)],
                check=True
            )

            # 安装 openai
            if sys.platform == "win32":
                pip = str(venv_path / "Scripts" / "pip")
            else:
                pip = str(venv_path / "bin" / "pip")
            subprocess.run([pip, "install", "openai"], check=True)

        print()
        print("✅ 环境配置完成!")
        print()
        print("使用方法:")
        if sys.platform == "win32":
            print(f"  {venv_path}\\Scripts\\activate")
        else:
            print(f"  source {venv_path}/bin/activate")
        print("  python your_script.py")
    else:
        print()
        print("❌ 自动安装失败，请手动安装:")
        print("  https://www.python.org/downloads/")

    print()
    print("=" * 60)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="OCRProxy TLS 适配工具")
    parser.add_argument("--setup", action="store_true",
                        help="自动安装支持 TLS 1.3 的 Python 环境")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL,
                        help=f"代理服务地址 (默认: {DEFAULT_BASE_URL})")
    parser.add_argument("--api-key", default=DEFAULT_API_KEY,
                        help="代理服务 API Key (用于连接测试)")
    args = parser.parse_args()

    if args.setup:
        setup()
    else:
        DEFAULT_BASE_URL = args.base_url.rstrip("/").removesuffix("/v1") + "/v1"
        if args.api_key:
            DEFAULT_API_KEY = args.api_key
        diagnose()
