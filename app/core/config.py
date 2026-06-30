"""全局配置 — 从环境变量读取敏感信息"""
import os
import logging
from pydantic_settings import BaseSettings
from cryptography.fernet import Fernet

logger = logging.getLogger("config")

# 默认值常量 — 用于检测环境变量是否漏设
_DEFAULT_ADMIN_PASSWORD = "admin123"
_DEFAULT_PROXY_API_KEY = "change-me-proxy-key"


class Settings(BaseSettings):
    model_config = {"env_prefix": "", "case_sensitive": True}

    # 面板访问的 admin 密码（私有空间）
    ADMIN_PASSWORD: str = _DEFAULT_ADMIN_PASSWORD

    # agent 调用 /v1/* 必须带的 key（自定义 key 鉴权）
    PROXY_API_KEY: str = _DEFAULT_PROXY_API_KEY

    # 加密数据库中存储的上游 Key 用的密钥（Fernet）
    # 生成方式: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    ENCRYPT_KEY: str = ""

    # SQLite 路径 — 默认指向魔搭创空间的持久化卷 /mnt/workspace
    # 本地开发时可通过 env DB_PATH=data/proxy.db 覆盖
    # 注意: /mnt/workspace 在 build 时不存在, 仅运行时由平台挂载
    DB_PATH: str = "/mnt/workspace/proxy.db"

    # 挂载等待 - 创空间持久化卷可能需要几秒才完成挂载
    # 启动时最多等待这么多秒, 检测目录可写
    MOUNT_WAIT_SEC: int = 30

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

    # 上游单次请求超时（秒） — 调小避免吃掉魔搭网关 17s 硬超时预算
    # connect 和 read 都用这个值; 总 fallback 预算见 SCHEDULE_TOTAL_BUDGET_SEC
    UPSTREAM_TIMEOUT_SEC: int = 12

    # 整体调度预算(秒) - 跑完这么久还没成功就放弃, 避免被 Envoy 17s 切断
    # 留 2s buffer 给响应序列化
    SCHEDULE_TOTAL_BUDGET_SEC: int = 15

    # Fernet 实例 (不存为 pydantic 字段)
    _fernet_instance: Fernet | None = None

    @property
    def fernet(self) -> Fernet:
        if self._fernet_instance is None:
            if not self.ENCRYPT_KEY:
                raise RuntimeError(
                    "ENCRYPT_KEY not set! Refusing to start. "
                    "Generate one: python -c "
                    "\"from cryptography.fernet import Fernet; "
                    "print(Fernet.generate_key().decode())\""
                )
            self._fernet_instance = Fernet(self.ENCRYPT_KEY.encode())
        return self._fernet_instance


def validate_runtime_config() -> None:
    """启动时强制检查关键环境变量 — 漏设则拒绝启动。

    在 main.py lifespan 启动阶段调用，避免静默降级。
    """
    if not settings.ENCRYPT_KEY:
        raise RuntimeError(
            "ENCRYPT_KEY not set! Refusing to start. "
            "Generate one: python -c "
            "\"from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())\""
        )
    if settings.ADMIN_PASSWORD == _DEFAULT_ADMIN_PASSWORD:
        raise RuntimeError(
            "ADMIN_PASSWORD is still the default 'admin123'! "
            "Set ADMIN_PASSWORD env var to a strong custom value."
        )
    if settings.PROXY_API_KEY == _DEFAULT_PROXY_API_KEY:
        raise RuntimeError(
            "PROXY_API_KEY is still the default 'change-me-proxy-key'! "
            "Set PROXY_API_KEY env var to a strong custom value."
        )


settings = Settings()
