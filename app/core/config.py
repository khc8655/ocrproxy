"""全局配置 — 从环境变量读取敏感信息"""
import os
import warnings
from pydantic_settings import BaseSettings
from cryptography.fernet import Fernet


class Settings(BaseSettings):
    model_config = {"env_prefix": "", "case_sensitive": True}

    # 面板访问的 admin 密码（私有空间）
    ADMIN_PASSWORD: str = "admin123"

    # agent 调用 /v1/* 必须带的 key（自定义 key 鉴权）
    PROXY_API_KEY: str = "change-me-proxy-key"

    # 加密数据库中存储的上游 Key 用的密钥（Fernet）
    # 生成方式: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    ENCRYPT_KEY: str = ""

    # SQLite 路径
    DB_PATH: str = "data/proxy.db"

    # 单个上游 Key 的最大并发数
    MAX_CONCURRENCY_PER_KEY: int = 5

    # 连续失败多少次进入熔断
    CIRCUIT_BREAK_THRESHOLD: int = 3

    # 熔断冷却时长（秒）
    CIRCUIT_COOLDOWN_SEC: int = 300  # 5 min

    # 429 冷却时长（秒）
    COOLDOWN_429_SEC: int = 60

    # 403 冷却时长（秒）—— 通常 Key 失效，冷却更久
    COOLDOWN_403_SEC: int = 600

    # 上游请求超时（秒）
    UPSTREAM_TIMEOUT_SEC: int = 120

    # Fernet 实例 (不存为 pydantic 字段)
    _fernet_instance: Fernet | None = None

    @property
    def fernet(self) -> Fernet:
        if self._fernet_instance is None:
            if not self.ENCRYPT_KEY:
                warnings.warn(
                    "ENCRYPT_KEY not set! Using ephemeral key — "
                    "existing encrypted data will be unreadable after restart. "
                    "Set ENCRYPT_KEY in production!"
                )
                self._fernet_instance = Fernet(Fernet.generate_key())
            else:
                self._fernet_instance = Fernet(self.ENCRYPT_KEY.encode())
        return self._fernet_instance


settings = Settings()
