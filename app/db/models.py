"""ORM 模型

设计:
  Provider        — 一个上游平台 (siliconflow / step / aliyun ...)
  ProviderKey     — 一个平台下的多个 Key (N), 加密存储
  ModelEndpoint   — 一个平台下暴露的模型端点 (OCR/Embedding/Reranker/Chat)
                     不再有 exposed_name — agent 直接用 model_type 当 model 名
  Candidate       — (ProviderKey × ModelEndpoint) 候选组合
                     创建 endpoint/key 时自动生成, 用户只能删/排序/启停
                     seq 在该 model_type 内升序; last_status 显示最近一次结果
  UsageLog        — 调用日志 (含 fallback 链)
"""
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, ForeignKey, Index, UniqueConstraint
from datetime import datetime, timezone
from app.db.database import Base


class Provider(Base):
    __tablename__ = "providers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False, unique=True)
    base_url = Column(String(512), nullable=False)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class ProviderKey(Base):
    """一个 Provider 下的多个 Key — 加密存储"""
    __tablename__ = "provider_keys"
    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("providers.id", ondelete="CASCADE"), nullable=False)
    label = Column(String(64), nullable=False, comment="展示用标签, e.g. key1 / deepseek1")
    encrypted_key = Column(Text, nullable=False, comment="Fernet 加密后的 api_key")
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # 同一供应商下 label 唯一, 防止重复
    __table_args__ = (UniqueConstraint("provider_id", "label", name="uq_key_provider_label"),)


class ModelEndpoint(Base):
    """一个 Provider 下暴露的模型端点 — 不再有 exposed_name

    agent 调用时 model 字段直接传 model_type (ocr/embedding/reranker/chat)
    """
    __tablename__ = "model_endpoints"
    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("providers.id", ondelete="CASCADE"), nullable=False)
    model_type = Column(String(32), nullable=False, comment="ocr/embedding/reranker/chat")
    model_id = Column(String(256), nullable=False, comment="实际转发给上游的 model 字段")
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # 同一供应商下同类型模型只能有一个 (避免歧义)
    __table_args__ = (UniqueConstraint("provider_id", "model_type", name="uq_endpoint_provider_type"),)


class Candidate(Base):
    """候选 = (Key × Endpoint) — 调度实际尝试的对象

    创建 endpoint 或 key 时自动生成所有可用组合; 用户只能删/排序/启停/解冻
    seq: 在该 model_type 内的排序序号 (asc), 默认按 id 顺序
    last_status: 最近一次调用结果 (success/fail_429/fail_403/fail_5xx/fail_other/-)
    """
    __tablename__ = "candidates"
    id = Column(Integer, primary_key=True, autoincrement=True)
    endpoint_id = Column(Integer, ForeignKey("model_endpoints.id", ondelete="CASCADE"), nullable=False)
    key_id = Column(Integer, ForeignKey("provider_keys.id", ondelete="CASCADE"), nullable=False)
    model_type = Column(String(32), nullable=False, comment="冗余便于查询")
    seq = Column(Integer, default=100, comment="在该 model_type 内的排序序号, asc")
    enabled = Column(Boolean, default=True)

    # 健康状态
    consecutive_failures = Column(Integer, default=0)
    cooldown_until = Column(DateTime, nullable=True)
    last_success_at = Column(DateTime, nullable=True)
    last_failure_at = Column(DateTime, nullable=True)
    last_status = Column(String(24), default="-", comment="最近一次状态, 供面板排序用")
    last_error = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_candidate_type_seq", "model_type", "seq"),
        UniqueConstraint("endpoint_id", "key_id", name="uq_candidate_endpoint_key"),
    )


class UsageLog(Base):
    """调用日志 — 含 fallback 链"""
    __tablename__ = "usage_logs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(String(64), nullable=False)
    attempt_seq = Column(Integer, nullable=False)
    candidate_id = Column(Integer, nullable=True)
    provider_name = Column(String(128), nullable=False)
    key_label = Column(String(64), nullable=True)
    model_type = Column(String(32), nullable=False)
    model_id = Column(String(256), nullable=False)
    status = Column(String(24), nullable=False)
    http_status = Column(Integer, nullable=True)
    error_msg = Column(Text, nullable=True)
    elapsed_ms = Column(Integer, default=0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (Index("idx_log_created", "created_at"),)
