"""调度器 — 核心引擎

按 model_type 取候选, seq asc 排序, 跳过冷却/禁用, 失败按状态码冷却并切下一个,
连续 3 次失败熔断 5 分钟, 记录 fallback 链到 UsageLog.
"""
import asyncio
import time
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
from sqlalchemy.orm import Session
import httpx

from app.db.models import Candidate, Provider, ProviderKey, ModelEndpoint, UsageLog
from app.core.config import settings
from app.core.crypto import decrypt_key

logger = logging.getLogger("scheduler")

_key_semaphores: dict[int, asyncio.Semaphore] = {}
_key_sem_lock = asyncio.Lock()


async def _get_key_sem(key_id: int) -> asyncio.Semaphore:
    if key_id not in _key_semaphores:
        async with _key_sem_lock:
            if key_id not in _key_semaphores:
                _key_semaphores[key_id] = asyncio.Semaphore(settings.MAX_CONCURRENCY_PER_KEY)
    return _key_semaphores[key_id]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _is_available(c: Candidate) -> bool:
    if not c.enabled:
        return False
    if c.cooldown_until and c.cooldown_until > _now():
        return False
    return True


class ScheduleResult:
    """调度结果 — 包装响应数据 + 路由元信息"""
    __slots__ = ("data", "stream_resp", "routed_via", "fallback_attempts")

    def __init__(self, data=None, stream_resp=None, routed_via: str = "", fallback_attempts: int = 1):
        self.data = data
        self.stream_resp = stream_resp
        self.routed_via = routed_via           # e.g. "siliconflow/me"
        self.fallback_attempts = fallback_attempts  # 总尝试次数


async def schedule(
    db: Session,
    model_type: str,
    build_request: callable,
    handle_response: callable,
    handle_stream: Optional[callable] = None,
    is_stream: bool = False,
) -> ScheduleResult:
    """调度一次请求。model_type 决定候选范围, seq asc 遍历。"""
    request_id = uuid.uuid4().hex[:16]
    candidates = _get_candidates(db, model_type)
    if not candidates:
        raise RuntimeError(f"No available candidate for model_type={model_type}")

    last_error = None
    attempt = 0

    for c, endpoint, key, provider in candidates:
        if not _is_available(c):
            continue

        attempt += 1
        decrypted = decrypt_key(key.encrypted_key)
        if not decrypted:
            logger.warning("Candidate %d: key %s undecryptable, skip", c.id, key.label)
            continue

        sem = await _get_key_sem(key.id)
        async with sem:
            t0 = time.monotonic()
            try:
                method, url, headers, body = build_request(endpoint, decrypted, provider)
                async with httpx.AsyncClient(timeout=settings.UPSTREAM_TIMEOUT_SEC) as client:
                    if is_stream:
                        async with client.stream(method, url, json=body, headers=headers) as resp:
                            if resp.status_code in (429, 403) or resp.status_code >= 400:
                                raw = await resp.aread()
                                await _handle_fail(db, request_id, attempt, c, endpoint, key, provider,
                                                   resp.status_code, raw.decode(errors="replace")[:500],
                                                   int((time.monotonic()-t0)*1000))
                                last_error = RuntimeError(f"upstream {resp.status_code}")
                                continue
                            _mark_success(db, c)
                            _log(db, request_id, attempt, c, endpoint, key, provider,
                                 "success", resp.status_code, None, int((time.monotonic()-t0)*1000))
                            sr = await handle_stream(resp)
                            sr.routed_via = f"{provider.name}/{key.label}"
                            sr.fallback_attempts = attempt
                            return sr
                    else:
                        resp = await client.request(method, url, json=body, headers=headers)
                        elapsed = int((time.monotonic()-t0)*1000)
                        if resp.status_code in (429, 403) or resp.status_code >= 400:
                            await _handle_fail(db, request_id, attempt, c, endpoint, key, provider,
                                               resp.status_code, resp.text[:500], elapsed)
                            last_error = RuntimeError(f"upstream {resp.status_code}")
                            continue
                        _mark_success(db, c)
                        _log(db, request_id, attempt, c, endpoint, key, provider,
                             "success", resp.status_code, None, elapsed)
                        return ScheduleResult(
                            data=handle_response(resp.json()),
                            routed_via=f"{provider.name}/{key.label}",
                            fallback_attempts=attempt,
                        )

            except httpx.RequestError as e:
                elapsed = int((time.monotonic()-t0)*1000)
                await _handle_fail(db, request_id, attempt, c, endpoint, key, provider,
                                   0, str(e)[:500], elapsed)
                last_error = e
                continue
            except Exception as e:
                elapsed = int((time.monotonic()-t0)*1000)
                await _handle_fail(db, request_id, attempt, c, endpoint, key, provider,
                                   0, str(e)[:500], elapsed)
                last_error = e
                continue

    raise RuntimeError(f"All candidates failed for {model_type}. attempts={attempt} last_error={last_error}")


def _get_candidates(db: Session, model_type: str) -> list:
    return (db.query(Candidate, ModelEndpoint, ProviderKey, Provider)
            .join(ModelEndpoint, Candidate.endpoint_id == ModelEndpoint.id)
            .join(ProviderKey, Candidate.key_id == ProviderKey.id)
            .join(Provider, ModelEndpoint.provider_id == Provider.id)
            .filter(Candidate.model_type == model_type,
                    Candidate.enabled == True,
                    ModelEndpoint.enabled == True,
                    ProviderKey.enabled == True,
                    Provider.enabled == True)
            .order_by(Candidate.seq.asc()).all())


def _mark_success(db: Session, c: Candidate):
    c.consecutive_failures = 0
    c.cooldown_until = None
    c.last_success_at = _now()
    c.last_status = "success"
    db.commit()


async def _handle_fail(db, request_id, attempt, c, endpoint, key, provider,
                       http_status, error_text, elapsed_ms):
    now = _now()
    c.consecutive_failures += 1
    c.last_failure_at = now
    c.last_error = (error_text or "")[:500]

    status_tag = "fail_other"
    cooldown_sec = 0
    if http_status == 429:
        status_tag = "fail_429"; cooldown_sec = settings.COOLDOWN_429_SEC
    elif http_status == 403:
        status_tag = "fail_403"; cooldown_sec = settings.COOLDOWN_403_SEC
    elif http_status and 500 <= http_status < 600:
        status_tag = "fail_5xx"; cooldown_sec = 30

    if c.consecutive_failures >= settings.CIRCUIT_BREAK_THRESHOLD:
        cooldown_sec = max(cooldown_sec, settings.CIRCUIT_COOLDOWN_SEC)
        logger.warning("Candidate %d circuit-broken for %ds (consecutive=%d)",
                       c.id, cooldown_sec, c.consecutive_failures)

    if cooldown_sec > 0:
        c.cooldown_until = now + timedelta(seconds=cooldown_sec)

    c.last_status = status_tag
    db.commit()

    _log(db, request_id, attempt, c, endpoint, key, provider,
         status_tag, http_status, (error_text or "")[:500], elapsed_ms)


def _log(db, request_id, attempt, c, endpoint, key, provider,
         status, http_status, error_msg, elapsed_ms):
    try:
        db.add(UsageLog(
            request_id=request_id, attempt_seq=attempt, candidate_id=c.id,
            provider_name=provider.name, key_label=key.label,
            model_type=endpoint.model_type, model_id=endpoint.model_id,
            status=status, http_status=http_status, error_msg=error_msg, elapsed_ms=elapsed_ms,
        ))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error("Failed to write usage log: %s", e)


# ======== 候选自动生成 ========

def regenerate_candidates_for_provider(db: Session, provider_id: int):
    """某供应商下 endpoint 或 key 增删/启停时, 重新生成该供应商所有候选。

    策略: 对该供应商下每个 (endpoint, key) 组合:
      - 若候选已存在 → 保留 (不动 seq/状态)
      - 若不存在 → 创建, seq = 该 model_type 内现有最大 seq + 1
    同时清理已失效的候选 (endpoint 或 key 被删的)
    """
    endpoints = db.query(ModelEndpoint).filter(ModelEndpoint.provider_id == provider_id).all()
    keys = db.query(ProviderKey).filter(ProviderKey.provider_id == provider_id).all()

    existing = {(c.endpoint_id, c.key_id): c for c in
                db.query(Candidate).filter(
                    Candidate.endpoint_id.in_([e.id for e in endpoints]) if endpoints else False,
                ).all()} if endpoints else {}

    for ep in endpoints:
        for k in keys:
            if (ep.id, k.id) in existing:
                continue
            # 计算 seq = 该 model_type 当前最大 seq + 1
            max_seq = db.query(Candidate).filter(Candidate.model_type == ep.model_type) \
                .order_by(Candidate.seq.desc()).first()
            new_seq = (max_seq.seq + 1) if max_seq else 1
            c = Candidate(endpoint_id=ep.id, key_id=k.id, model_type=ep.model_type,
                          seq=new_seq, enabled=True)
            db.add(c)
    db.commit()


def reorder_candidates_seq(db: Session, model_type: str):
    """整理某 model_type 的 seq, 让其连续 1,2,3..."""
    cands = db.query(Candidate).filter(Candidate.model_type == model_type) \
        .order_by(Candidate.seq.asc(), Candidate.id.asc()).all()
    for i, c in enumerate(cands, 1):
        c.seq = i
    db.commit()
