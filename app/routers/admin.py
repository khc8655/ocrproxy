"""管理 API — 供应商/Key/端点/候选 CRUD

候选不再手动新增: 创建 endpoint 或 key 时自动生成该供应商下的所有组合
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy.orm import Session
from datetime import datetime, timezone
import httpx
import logging

from app.db.database import get_db
from app.db.models import Provider, ProviderKey, ModelEndpoint, Candidate
from app.core.crypto import encrypt_key, decrypt_key, mask_key
from app.core.scheduler import regenerate_candidates_for_provider, reorder_candidates_seq
from app.core.config import settings

logger = logging.getLogger("admin")

router = APIRouter(prefix="/api/admin", tags=["Admin"])


# ======== Provider ========

class ProviderIn(BaseModel):
    name: str
    base_url: str
    enabled: bool = True

class ProviderPatch(BaseModel):
    name: Optional[str] = None
    base_url: Optional[str] = None
    enabled: Optional[bool] = None

class ProviderOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int; name: str; base_url: str; enabled: bool


@router.get("/providers", response_model=List[ProviderOut])
def list_providers(db: Session = Depends(get_db)):
    return db.query(Provider).order_by(Provider.id).all()

@router.post("/providers", response_model=ProviderOut)
def create_provider(data: ProviderIn, db: Session = Depends(get_db)):
    p = Provider(**data.model_dump())
    db.add(p); db.commit(); db.refresh(p)
    return p

@router.put("/providers/{pid}", response_model=ProviderOut)
def update_provider(pid: int, data: ProviderPatch, db: Session = Depends(get_db)):
    p = db.query(Provider).filter(Provider.id == pid).first()
    if not p: raise HTTPException(404, "Provider not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit(); db.refresh(p)
    return p

@router.delete("/providers/{pid}")
def delete_provider(pid: int, db: Session = Depends(get_db)):
    p = db.query(Provider).filter(Provider.id == pid).first()
    if not p: raise HTTPException(404, "Provider not found")
    db.delete(p); db.commit()
    return {"ok": True}


# ======== ProviderKey ========

class KeyIn(BaseModel):
    model_config = {"protected_namespaces": ()}
    provider_id: int
    label: str
    api_key: str
    enabled: bool = True

class KeyPatch(BaseModel):
    model_config = {"protected_namespaces": ()}
    label: Optional[str] = None
    api_key: Optional[str] = None
    enabled: Optional[bool] = None

class KeyOut(BaseModel):
    model_config = {"protected_namespaces": (), "from_attributes": True}
    id: int; provider_id: int; label: str; api_key_masked: str; enabled: bool


@router.get("/keys", response_model=List[KeyOut])
def list_keys(db: Session = Depends(get_db)):
    rows = db.query(ProviderKey).order_by(ProviderKey.provider_id, ProviderKey.id).all()
    return [KeyOut(id=r.id, provider_id=r.provider_id, label=r.label,
                   api_key_masked=mask_key(decrypt_key(r.encrypted_key)), enabled=r.enabled)
            for r in rows]


class KeyTestIn(BaseModel):
    """实测一个 Key 是否能调通上游 - 不写库, 仅做联通性验证"""
    model_config = {"protected_namespaces": ()}
    provider_id: int
    api_key: str
    # 可选: 不传则探 GET /v1/models, 传则探 POST /v1/chat/completions (用最便宜的 ping)
    test_model: Optional[str] = None
    timeout_sec: int = 10


class KeyTestOut(BaseModel):
    ok: bool
    http_status: Optional[int] = None
    msg: str
    elapsed_ms: int = 0
    models_count: Optional[int] = None


@router.post("/keys/test", response_model=KeyTestOut)
async def test_key(data: KeyTestIn, db: Session = Depends(get_db)):
    """实测 Key 联通性 - 不写库.

    用 GET {base_url}/v1/models 探活, 返回 200 视为成功.
    部分上游(如硅基流动)无 /v1/models 端点, 此时会返回 404,
    前端可提示用户"无法自动探活, 请选择跳过测试强制保存".
    """
    import time as _time
    p = db.query(Provider).filter(Provider.id == data.provider_id).first()
    if not p:
        raise HTTPException(404, "Provider not found")
    if not data.api_key.strip():
        raise HTTPException(400, "api_key cannot be empty")
    url = p.base_url.rstrip("/") + "/v1/models"
    headers = {"Authorization": f"Bearer {data.api_key.strip()}"}
    start = _time.time()
    try:
        async with httpx.AsyncClient(timeout=data.timeout_sec) as client:
            r = await client.get(url, headers=headers)
        elapsed = int((_time.time() - start) * 1000)
        if r.status_code == 200:
            count = None
            try:
                body = r.json()
                if isinstance(body, dict) and isinstance(body.get("data"), list):
                    count = len(body["data"])
            except Exception:
                pass
            return KeyTestOut(ok=True, http_status=200,
                              msg=f"联通成功 ({count} 个模型可见)" if count else "联通成功",
                              elapsed_ms=elapsed, models_count=count)
        if r.status_code in (401, 403):
            return KeyTestOut(ok=False, http_status=r.status_code,
                              msg=f"鉴权失败 ({r.status_code}) - Key 无效或已过期",
                              elapsed_ms=elapsed)
        if r.status_code == 404:
            return KeyTestOut(ok=False, http_status=404,
                              msg="上游无 /v1/models 端点 - 无法自动探活, 可选择跳过测试强制保存",
                              elapsed_ms=elapsed)
        return KeyTestOut(ok=False, http_status=r.status_code,
                          msg=f"上游返回 HTTP {r.status_code}: {r.text[:200]}",
                          elapsed_ms=elapsed)
    except httpx.TimeoutException:
        return KeyTestOut(ok=False, msg=f"上游超时 (> {data.timeout_sec}s)",
                          elapsed_ms=int((_time.time() - start) * 1000))
    except Exception as e:
        logger.warning("Key test failed for provider=%s: %s", p.name, e)
        return KeyTestOut(ok=False, msg=f"连接失败: {type(e).__name__}: {str(e)[:200]}",
                          elapsed_ms=int((_time.time() - start) * 1000))


@router.post("/keys", response_model=KeyOut)
def create_key(data: KeyIn, db: Session = Depends(get_db)):
    if not db.query(Provider).filter(Provider.id == data.provider_id).first():
        raise HTTPException(404, "Provider not found")
    # 重复检测: 同供应商下 label 唯一
    exists = db.query(ProviderKey).filter(
        ProviderKey.provider_id == data.provider_id,
        ProviderKey.label == data.label,
    ).first()
    if exists:
        raise HTTPException(409, f"该供应商下已存在 label='{data.label}' 的 Key")
    # 重复检测: 同供应商下 api_key 不能重复
    all_keys = db.query(ProviderKey).filter(ProviderKey.provider_id == data.provider_id).all()
    new_dec = data.api_key
    for k in all_keys:
        if decrypt_key(k.encrypted_key) == new_dec:
            raise HTTPException(409, f"该供应商下已存在相同的 API Key (label='{k.label}')")
    k = ProviderKey(provider_id=data.provider_id, label=data.label,
                    encrypted_key=encrypt_key(data.api_key), enabled=data.enabled)
    db.add(k); db.commit(); db.refresh(k)
    # 自动生成候选
    regenerate_candidates_for_provider(db, data.provider_id)
    return KeyOut(id=k.id, provider_id=k.provider_id, label=k.label,
                  api_key_masked=mask_key(data.api_key), enabled=k.enabled)

@router.put("/keys/{kid}", response_model=KeyOut)
def update_key(kid: int, data: KeyPatch, db: Session = Depends(get_db)):
    k = db.query(ProviderKey).filter(ProviderKey.id == kid).first()
    if not k: raise HTTPException(404, "Key not found")
    old_enabled = k.enabled
    if data.label is not None: k.label = data.label
    if data.api_key is not None: k.encrypted_key = encrypt_key(data.api_key)
    if data.enabled is not None: k.enabled = data.enabled
    db.commit(); db.refresh(k)
    # 启用状态变化时重建候选
    if data.enabled is not None and data.enabled != old_enabled:
        regenerate_candidates_for_provider(db, k.provider_id)
    return KeyOut(id=k.id, provider_id=k.provider_id, label=k.label,
                  api_key_masked=mask_key(decrypt_key(k.encrypted_key)), enabled=k.enabled)

@router.delete("/keys/{kid}")
def delete_key(kid: int, db: Session = Depends(get_db)):
    k = db.query(ProviderKey).filter(ProviderKey.id == kid).first()
    if not k: raise HTTPException(404, "Key not found")
    pid = k.provider_id
    db.delete(k); db.commit()
    regenerate_candidates_for_provider(db, pid)
    return {"ok": True}


# ======== ModelEndpoint ========

class EndpointIn(BaseModel):
    model_config = {"protected_namespaces": ()}
    provider_id: int
    model_type: str   # ocr/embedding/reranker/chat
    model_id: str
    enabled: bool = True

class EndpointPatch(BaseModel):
    model_config = {"protected_namespaces": ()}
    model_id: Optional[str] = None
    enabled: Optional[bool] = None

class EndpointOut(BaseModel):
    model_config = {"protected_namespaces": ()}
    id: int; provider_id: int; model_type: str; model_id: str; enabled: bool


@router.get("/endpoints", response_model=List[EndpointOut])
def list_endpoints(db: Session = Depends(get_db)):
    rows = db.query(ModelEndpoint).order_by(ModelEndpoint.model_type, ModelEndpoint.id).all()
    return [EndpointOut(id=r.id, provider_id=r.provider_id, model_type=r.model_type,
                        model_id=r.model_id, enabled=r.enabled) for r in rows]

@router.post("/endpoints", response_model=EndpointOut)
def create_endpoint(data: EndpointIn, db: Session = Depends(get_db)):
    if data.model_type not in ("ocr", "embedding", "reranker", "chat"):
        raise HTTPException(400, "model_type must be one of ocr/embedding/reranker/chat")
    if not db.query(Provider).filter(Provider.id == data.provider_id).first():
        raise HTTPException(404, "Provider not found")
    # 同供应商同类型只能有一个
    exists = db.query(ModelEndpoint).filter(
        ModelEndpoint.provider_id == data.provider_id,
        ModelEndpoint.model_type == data.model_type,
    ).first()
    if exists:
        raise HTTPException(409, f"该供应商下已存在 {data.model_type} 类型的端点 (model_id={exists.model_id})")
    e = ModelEndpoint(provider_id=data.provider_id, model_type=data.model_type,
                      model_id=data.model_id, enabled=data.enabled)
    db.add(e); db.commit(); db.refresh(e)
    # 自动生成候选
    regenerate_candidates_for_provider(db, data.provider_id)
    return EndpointOut(id=e.id, provider_id=e.provider_id, model_type=e.model_type,
                       model_id=e.model_id, enabled=e.enabled)

@router.put("/endpoints/{eid}", response_model=EndpointOut)
def update_endpoint(eid: int, data: EndpointPatch, db: Session = Depends(get_db)):
    e = db.query(ModelEndpoint).filter(ModelEndpoint.id == eid).first()
    if not e: raise HTTPException(404, "Endpoint not found")
    old_enabled = e.enabled
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(e, k, v)
    db.commit(); db.refresh(e)
    if data.enabled is not None and data.enabled != old_enabled:
        regenerate_candidates_for_provider(db, e.provider_id)
    return EndpointOut(id=e.id, provider_id=e.provider_id, model_type=e.model_type,
                       model_id=e.model_id, enabled=e.enabled)

@router.delete("/endpoints/{eid}")
def delete_endpoint(eid: int, db: Session = Depends(get_db)):
    e = db.query(ModelEndpoint).filter(ModelEndpoint.id == eid).first()
    if not e: raise HTTPException(404, "Endpoint not found")
    pid = e.provider_id
    db.delete(e); db.commit()
    regenerate_candidates_for_provider(db, pid)
    return {"ok": True}


# ======== Candidate ========

class CandidatePatch(BaseModel):
    model_config = {"protected_namespaces": ()}
    seq: Optional[int] = None
    enabled: Optional[bool] = None

class CandidateOut(BaseModel):
    model_config = {"protected_namespaces": ()}
    id: int; endpoint_id: int; key_id: int; model_type: str; seq: int; weight: int = 10
    enabled: bool
    consecutive_failures: int; cooldown_until: Optional[datetime]
    last_success_at: Optional[datetime]; last_failure_at: Optional[datetime]
    last_status: str; last_error: Optional[str]
    provider_name: str = ""; key_label: str = ""; model_id: str = ""


@router.get("/candidates", response_model=List[CandidateOut])
def list_candidates(db: Session = Depends(get_db)):
    rows = (db.query(Candidate, ModelEndpoint, ProviderKey, Provider)
            .join(ModelEndpoint, Candidate.endpoint_id == ModelEndpoint.id)
            .join(ProviderKey, Candidate.key_id == ProviderKey.id)
            .join(Provider, ModelEndpoint.provider_id == Provider.id)
            .order_by(Candidate.model_type, Candidate.seq).all())
    out = []
    for c, e, k, p in rows:
        out.append(CandidateOut(
            id=c.id, endpoint_id=c.endpoint_id, key_id=c.key_id,
            model_type=c.model_type, seq=c.seq, enabled=c.enabled,
            consecutive_failures=c.consecutive_failures, cooldown_until=c.cooldown_until,
            last_success_at=c.last_success_at, last_failure_at=c.last_failure_at,
            last_status=c.last_status or "-", last_error=c.last_error,
            provider_name=p.name, key_label=k.label, model_id=e.model_id,
        ))
    return out

@router.put("/candidates/{cid}", response_model=CandidateOut)
def update_candidate(cid: int, data: CandidatePatch, db: Session = Depends(get_db)):
    c = db.query(Candidate).filter(Candidate.id == cid).first()
    if not c: raise HTTPException(404, "Candidate not found")
    # 改 seq 不自动 reorder — 排序交换需要两次 PUT 用原始 seq, reorder 会破坏交换
    # 用户点"整理序号"按钮时才统一 reorder
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(c, k, v)
    db.commit(); db.refresh(c)
    e = db.query(ModelEndpoint).filter(ModelEndpoint.id == c.endpoint_id).first()
    k = db.query(ProviderKey).filter(ProviderKey.id == c.key_id).first()
    p = db.query(Provider).filter(Provider.id == e.provider_id).first() if e else None
    return CandidateOut(id=c.id, endpoint_id=c.endpoint_id, key_id=c.key_id,
                        model_type=c.model_type, seq=c.seq, enabled=c.enabled,
                        consecutive_failures=c.consecutive_failures, cooldown_until=c.cooldown_until,
                        last_success_at=c.last_success_at, last_failure_at=c.last_failure_at,
                        last_status=c.last_status or "-", last_error=c.last_error,
                        provider_name=p.name if p else "", key_label=k.label if k else "",
                        model_id=e.model_id if e else "")

@router.delete("/candidates/{cid}")
def delete_candidate(cid: int, db: Session = Depends(get_db)):
    c = db.query(Candidate).filter(Candidate.id == cid).first()
    if not c: raise HTTPException(404, "Candidate not found")
    mt = c.model_type
    db.delete(c); db.commit()
    reorder_candidates_seq(db, mt)
    return {"ok": True}

@router.post("/candidates/{cid}/reset")
def reset_candidate(cid: int, db: Session = Depends(get_db)):
    c = db.query(Candidate).filter(Candidate.id == cid).first()
    if not c: raise HTTPException(404, "Candidate not found")
    c.consecutive_failures = 0
    c.cooldown_until = None
    c.last_error = None
    c.last_status = "reset"
    db.commit()
    return {"ok": True}

@router.post("/candidates/reorder")
def reorder_all(db: Session = Depends(get_db)):
    """整理所有类型的 seq 连续化"""
    for mt in ("ocr", "embedding", "reranker", "chat"):
        reorder_candidates_seq(db, mt)
    return {"ok": True}


@router.post("/candidates/{cid}/move")
def move_candidate(cid: int, dir: str, db: Session = Depends(get_db)):
    """原子上下移 - 在单事务内交换两条候选的 seq

    替代前端"两次 PUT 交换 seq"的旧实现 - 解决了快速连点 + 后台
    setInterval 刷新导致的状态错乱.
    """
    if dir not in ("up", "down"):
        raise HTTPException(400, "dir must be 'up' or 'down'")
    c = db.query(Candidate).filter(Candidate.id == cid).first()
    if not c:
        raise HTTPException(404, "Candidate not found")
    # 同类型按 seq 升序排
    siblings = (db.query(Candidate)
                .filter(Candidate.model_type == c.model_type)
                .order_by(Candidate.seq, Candidate.id).all())
    idx = next((i for i, x in enumerate(siblings) if x.id == c.id), -1)
    if idx < 0:
        raise HTTPException(500, "Candidate not in its own model_type query result")
    neighbor = None
    if dir == "up" and idx > 0:
        neighbor = siblings[idx - 1]
    elif dir == "down" and idx < len(siblings) - 1:
        neighbor = siblings[idx + 1]
    if neighbor is None:
        return {"ok": True, "moved": False, "reason": f"already at {'top' if dir == 'up' else 'bottom'}"}
    # 原子交换 - 单事务一次 commit
    c.seq, neighbor.seq = neighbor.seq, c.seq
    db.commit()
    return {"ok": True, "moved": True}


# ======== Agent 接入信息 ========

class AgentInfoOut(BaseModel):
    """Agent 接入所需的配置信息 - 仅供已登录管理员查看"""
    base_url: str
    proxy_api_key: str  # 完整返回 - 已登录管理员可见, 用于复制接入
    model_types: list
    examples: dict


@router.get("/agent-info", response_model=AgentInfoOut)
def agent_info():
    """返回 agent 接入此代理所需的全部配置.

    用于面板"接入信息" tab 一键复制到 Cherry Studio / Cline / Continue 等客户端.
    base_url 不在服务端固定 - 由前端拿到 location.origin 拼接 /v1.
    这里返回相对路径占位符 "<ORIGIN>/v1", 前端替换.
    """
    return AgentInfoOut(
        base_url="<ORIGIN>/v1",
        proxy_api_key=settings.PROXY_API_KEY,
        model_types=[
            {"type": "ocr", "name": "OCR 文档识别", "desc": "调用时 model 字段填 'ocr'"},
            {"type": "embedding", "name": "Embedding 向量化", "desc": "调用时 model 字段填 'embedding'"},
            {"type": "reranker", "name": "Reranker 重排", "desc": "调用时 model 字段填 'reranker'"},
            {"type": "chat", "name": "Chat 对话", "desc": "调用时 model 字段填 'chat'"},
        ],
        examples={
            "_note": (
                "⚠️ 部署在魔搭创空间时, 平台网关会强占 Authorization 头, "
                "导致标准 'Bearer Token' 方式失效. 必须改用 X-Api-Key 头 "
                "或 ?api_key= query 参数. 本地/自托管部署无此问题, "
                "三种方式都可用."
            ),
            "openai_python": (
                "from openai import OpenAI\n"
                "client = OpenAI(\n"
                "    base_url='<ORIGIN>/v1',\n"
                "    api_key='placeholder',  # SDK 必传字段, 实际不用\n"
                "    default_headers={'X-Api-Key': '<PROXY_API_KEY>'},\n"
                ")\n"
                "resp = client.chat.completions.create(\n"
                "    model='chat',  # 或 ocr / embedding / reranker\n"
                "    messages=[{'role': 'user', 'content': 'hello'}],\n"
                ")"
            ),
            "curl_xapikey": (
                "# 方式 1: X-Api-Key 头 (推荐 - 兼容魔搭网关)\n"
                "curl <ORIGIN>/v1/chat/completions \\\n"
                "  -H 'X-Api-Key: <PROXY_API_KEY>' \\\n"
                "  -H 'Content-Type: application/json' \\\n"
                "  -d '{\"model\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'"
            ),
            "curl_query": (
                "# 方式 2: query 参数 (浏览器调试最方便)\n"
                "curl '<ORIGIN>/v1/chat/completions?api_key=<PROXY_API_KEY>' \\\n"
                "  -H 'Content-Type: application/json' \\\n"
                "  -d '{\"model\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'"
            ),
            "curl_bearer": (
                "# 方式 3: Bearer Token (仅自托管/非魔搭部署可用)\n"
                "curl <ORIGIN>/v1/chat/completions \\\n"
                "  -H 'Authorization: Bearer <PROXY_API_KEY>' \\\n"
                "  -H 'Content-Type: application/json' \\\n"
                "  -d '{\"model\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'"
            ),
            "cherry_studio": (
                "Cherry Studio / Cline / Continue 等客户端只支持 Bearer Token,\n"
                "在魔搭部署下无法直接接入. 解决方案二选一:\n"
                "  A. 用本项目的 OpenAI Python SDK 写法间接调用\n"
                "  B. 把本项目自托管到 VPS / Docker / 内网, 用 Bearer 直连\n"
                "  C. 部分客户端支持 Base URL 带 query, 试试:\n"
                "     <ORIGIN>/v1?api_key=<PROXY_API_KEY>"
            ),
        },
    )


