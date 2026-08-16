#!/usr/bin/env python3
"""
OCRProxy 初始化脚本 - 生成加密密钥和初始配置文件。
由 install.sh 调用，不直接运行。
"""
import os
import sys
import json
import secrets
import string

def generate_random_key(length: int = 40) -> str:
    """Generate a cryptographically secure random string."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def generate_fernet_key() -> str:
    """Generate a Fernet encryption key."""
    from cryptography.fernet import Fernet
    return Fernet.generate_key().decode()


def create_env_file(env_path: str, config_dir: str, proxy_key: str, admin_pass: str, encrypt_key: str, port: int = 8787):
    """Create .env file with generated secrets."""
    content = f"""# ocrproxy 环境变量配置
# 此文件包含敏感密钥，权限已设置为 600
# 生成时间: 自动安装

# 代理服务监听地址 (仅本地监听，由 Caddy 反向代理)
APP_HOST=127.0.0.1
APP_PORT={port}

# 代理 API Key - 客户端调用 /v1/* 接口时使用的密钥
PROXY_API_KEY={proxy_key}

# 管理员密码 - 登录后台管理面板使用的密码
ADMIN_PASSWORD={admin_pass}

# 配置文件加密密钥 (Fernet key)
ENCRYPT_KEY={encrypt_key}

# 配置文件存储目录
CONFIG_DIR={config_dir}
"""
    with open(env_path, 'w') as f:
        f.write(content)
    os.chmod(env_path, 0o600)


def init_config(config_dir: str, encrypt_key: str, import_path: str = None):
    """Create initial encrypted config file."""
    from cryptography.fernet import Fernet

    os.makedirs(config_dir, exist_ok=True)
    config_file = os.path.join(config_dir, "proxy_config.enc")
    fernet = Fernet(encrypt_key.encode())

    if import_path and os.path.exists(import_path):
        # Import from existing proxy_config JSON file
        with open(import_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        print(f"  [✓] 从 {import_path} 导入现有配置")
    else:
        # Create minimal template config
        config = {
            "upstream_timeout": 12,
            "schedule_total_budget": 15,
            "max_concurrency_per_key": 5,
            "cooldown_429_sec": 60,
            "cooldown_403_sec": 600,
            "providers": {},
            "candidates": {
                "chat": [],
                "embedding": [],
                "reranker": [],
                "ocr": []
            }
        }
        print("  [✓] 创建空白配置模板（请通过管理面板添加供应商和 Key）")

    data = json.dumps(config, ensure_ascii=False, indent=2).encode('utf-8')
    encrypted = fernet.encrypt(data)

    tmp_file = config_file + '.tmp'
    with open(tmp_file, 'wb') as f:
        f.write(encrypted)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp_file, 0o600)
    os.rename(tmp_file, config_file)
    # fsync the directory so the rename survives a power loss
    dir_fd = os.open(config_dir, os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    print(f"  [✓] 加密配置文件已创建: {config_file}")


def main():
    import_path = sys.argv[1] if len(sys.argv) > 1 else None
    config_dir = sys.argv[2] if len(sys.argv) > 2 else "/opt/ocrproxy/config"
    env_path = sys.argv[3] if len(sys.argv) > 3 else "/opt/ocrproxy/.env"
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 8787

    print("\n" + "=" * 60)
    print("  OCRProxy 初始化 - 生成密钥和配置")
    print("=" * 60)

    # Generate secrets
    print("\n[1/3] 生成加密密钥...")
    encrypt_key = generate_fernet_key()
    proxy_key = generate_random_key(40)
    admin_pass = generate_random_key(24)
    print(f"  [✓] Fernet 加密密钥已生成")
    print(f"  [✓] PROXY_API_KEY: {proxy_key}")
    print(f"  [✓] ADMIN_PASSWORD: {admin_pass}")

    # Create .env file
    print("\n[2/3] 创建环境变量文件...")
    create_env_file(env_path, config_dir, proxy_key, admin_pass, encrypt_key, port)
    print(f"  [✓] .env 文件已创建: {env_path} (权限 600)")

    # Initialize config
    print("\n[3/3] 创建加密配置文件...")
    init_config(config_dir, encrypt_key, import_path)

    print("\n" + "=" * 60)
    print("  初始化完成！请妥善保存以下密钥：")
    print("=" * 60)
    print(f"\n  PROXY_API_KEY  = {proxy_key}")
    print(f"  ADMIN_PASSWORD = {admin_pass}")
    print(f"\n  配置目录: {config_dir}")
    print(f"  环境变量: {env_path}")
    print("\n" + "=" * 60 + "\n")

    # Return secrets for the caller
    result = {
        "proxy_key": proxy_key,
        "admin_pass": admin_pass,
        "encrypt_key": encrypt_key,
    }
    # Also write to a temporary file for the install script to read
    secrets_file = os.path.join(config_dir, ".install_secrets.json")
    with open(secrets_file, 'w') as f:
        json.dump(result, f)
    os.chmod(secrets_file, 0o600)


if __name__ == "__main__":
    main()
