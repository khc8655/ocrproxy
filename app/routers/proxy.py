"""代理路由 — OpenAI 兼容 + 自定义 key 鉴权

agent 调用时 model 字段直接传四类之一: ocr / embedding / reranker / chat
路径自动按类型映射:
  chat       → 上游 /v1/chat/completions  (支持 stream)
  embedding  → 上游 /v1/embeddings
  reranker   → 上游 /v1/rerank  (SiliconFlow 风格 {query, documents})
  ocr        → 上游 /v1/chat/completions  (构造 vision 消息体)
"""
import logging
import hmac
from urllib.parse import urljoin
from typing import Optional
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.db.models import ModelEndpoint, Provider
from app.core.config import settings
from app.core.scheduler import schedule, ScheduleResult

logger = logging.getLogger("proxy")
router = APIRouter(prefix="/v1", tags=["Proxy"])


def _verify_proxy_key(authorization: Optional[str]):
    expected = settings.PROXY_API_KEY
    if not expected: return
    token = None
    if authorization:
        token = authorization[7:].strip() if authorization.startswith("Bearer ") else authorization.strip()
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(401, "Invalid or missing proxy API key")


def _provider_url(db: Session, endpoint) -> str:
    p = db.query(Provider).filter(Provider.id == endpoint.provider_id).first()
    return p.base_url if p else ""


@router.get("/models")
async def list_models(authorization: Optional[str] = Header(None),
                      db: Session = Depends(get_db)):
    _verify_proxy_key(authorization)
    return {"object": "list", "data": [
        {"id": "ocr", "object": "model", "owned_by": "llm-proxy", "model_type": "ocr"},
        {"id": "embedding", "object": "model", "owned_by": "llm-proxy", "model_type": "embedding"},
        {"id": "reranker", "object": "model", "owned_by": "llm-proxy", "model_type": "reranker"},
        {"id": "chat", "object": "model", "owned_by": "llm-proxy", "model_type": "chat"},
    ]}


@router.post("/chat/completions")
async def chat_completions(request: Request,
                           authorization: Optional[str] = Header(None),
                           db: Session = Depends(get_db)):
    _verify_proxy_key(authorization)
    body = await request.json()
    is_stream = body.get("stream", False)

    def build(ep, key, prov):
        out = dict(body); out["model"] = ep.model_id
        url = urljoin(_provider_url(db, ep).rstrip("/") + "/", "v1/chat/completions")
        return "POST", url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, out

    if is_stream:
        async def stream_handler(resp):
            async def gen():
                async for chunk in resp.aiter_bytes():
                    yield chunk
            # 返回 ScheduleResult 让 scheduler 填 routed_via
            return ScheduleResult(stream_resp=StreamingResponse(gen(), media_type="text/event-stream"))

        try:
            sr = await schedule(db, "chat", build, lambda r: r,
                                handle_stream=stream_handler, is_stream=True)
            sr.stream_resp.headers["X-Routed-Via"] = sr.routed_via
            sr.stream_resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
            return sr.stream_resp
        except RuntimeError as e:
            raise HTTPException(503, str(e))
    try:
        sr = await schedule(db, "chat", build, lambda r: r)
        resp = JSONResponse(sr.data)
        resp.headers["X-Routed-Via"] = sr.routed_via
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/embeddings")
async def embeddings(request: Request,
                      authorization: Optional[str] = Header(None),
                      db: Session = Depends(get_db)):
    _verify_proxy_key(authorization)
    body = await request.json()

    def build(ep, key, prov):
        out = dict(body); out["model"] = ep.model_id
        url = urljoin(_provider_url(db, ep).rstrip("/") + "/", "v1/embeddings")
        return "POST", url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, out
    try:
        sr = await schedule(db, "embedding", build, lambda r: r)
        resp = JSONResponse(sr.data)
        resp.headers["X-Routed-Via"] = sr.routed_via
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/rerank")
async def rerank(request: Request,
                 authorization: Optional[str] = Header(None),
                 db: Session = Depends(get_db)):
    _verify_proxy_key(authorization)
    body = await request.json()

    def build(ep, key, prov):
        out = dict(body); out["model"] = ep.model_id
        url = urljoin(_provider_url(db, ep).rstrip("/") + "/", "v1/rerank")
        return "POST", url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, out
    try:
        sr = await schedule(db, "reranker", build, lambda r: r)
        resp = JSONResponse(sr.data)
        resp.headers["X-Routed-Via"] = sr.routed_via
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/ocr")
async def ocr(request: Request,
              authorization: Optional[str] = Header(None),
              db: Session = Depends(get_db)):
    _verify_proxy_key(authorization)
    body = await request.json()
    img_b64 = body.get("image_base64")
    img_url = body.get("image_url")
    if not img_b64 and not img_url:
        raise HTTPException(400, "Must provide image_base64 or image_url")
    prompt = body.get("prompt", "请识别图片中的所有文字内容，返回纯文本。")
    img = img_url if img_url else f"data:{'image/jpeg' if img_b64.startswith('/9j/') else 'image/png'};base64,{img_b64}"

    def build(ep, key, prov):
        chat_body = {
            "model": ep.model_id,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": img}},
            ]}],
            "max_tokens": 4096, "stream": False,
        }
        url = urljoin(_provider_url(db, ep).rstrip("/") + "/", "v1/chat/completions")
        return "POST", url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, chat_body
    try:
        sr = await schedule(db, "ocr", build, lambda r: r)
        resp = JSONResponse(sr.data)
        resp.headers["X-Routed-Via"] = sr.routed_via
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except RuntimeError as e:
        raise HTTPException(503, str(e))
