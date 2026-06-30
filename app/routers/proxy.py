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


def _join_upstream(base_url: str, path: str) -> str:
    """拼接上游 URL, 容错用户填写 base_url 的几种常见方式:

    - https://api.siliconflow.cn        →  https://api.siliconflow.cn/v1/chat/completions
    - https://api.siliconflow.cn/        →  同上
    - https://api.siliconflow.cn/v1      →  https://api.siliconflow.cn/v1/chat/completions  (不重复加 /v1)
    - https://api.siliconflow.cn/v1/     →  同上

    path 形如 'chat/completions' 或 'embeddings' (无前导 /, 无 v1/ 前缀).
    """
    base = base_url.rstrip("/")
    # 如果用户已经在 base_url 末尾带了 /v1, 不要再加一次
    if base.endswith("/v1"):
        return f"{base}/{path.lstrip('/')}"
    return f"{base}/v1/{path.lstrip('/')}"


def _verify_proxy_key(authorization: Optional[str],
                      x_api_key: Optional[str] = None,
                      query_api_key: Optional[str] = None):
    """校验 proxy api key, 支持 3 种传递方式:

    1. Authorization: Bearer <key>     标准 OpenAI 兼容方式
    2. X-Api-Key: <key>                自定义头, 魔搭/CDN 网关不动它
    3. ?api_key=<key>                  query 参数, 浏览器调试方便

    任一通过即放行. 解决: 部分网关(魔搭 EAS/阿里云 SLB)会改写或剥离
    Authorization 头, 导致服务端收到的 token 跟环境变量不一致.
    """
    expected = settings.PROXY_API_KEY
    if not expected:
        return
    candidates = []
    if authorization:
        token = authorization[7:].strip() if authorization.startswith("Bearer ") else authorization.strip()
        candidates.append(token)
    if x_api_key:
        candidates.append(x_api_key.strip())
    if query_api_key:
        candidates.append(query_api_key.strip())
    for tok in candidates:
        if tok and hmac.compare_digest(tok, expected):
            return  # 任一通过即放行
    raise HTTPException(401, "Invalid or missing proxy API key")


def _provider_url(db: Session, endpoint) -> str:
    p = db.query(Provider).filter(Provider.id == endpoint.provider_id).first()
    return p.base_url if p else ""


@router.get("/models")
async def list_models(authorization: Optional[str] = Header(None),
                      x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
                      api_key: Optional[str] = None,
                      db: Session = Depends(get_db)):
    _verify_proxy_key(authorization, x_api_key, api_key)
    return {"object": "list", "data": [
        {"id": "ocr", "object": "model", "owned_by": "llm-proxy", "model_type": "ocr"},
        {"id": "embedding", "object": "model", "owned_by": "llm-proxy", "model_type": "embedding"},
        {"id": "reranker", "object": "model", "owned_by": "llm-proxy", "model_type": "reranker"},
        {"id": "chat", "object": "model", "owned_by": "llm-proxy", "model_type": "chat"},
    ]}


@router.get("/debug-headers")
async def debug_headers(request: Request,
                        authorization: Optional[str] = Header(None),
                        x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
                        api_key: Optional[str] = None):
    """调试端点 - 让运维看清服务端实际收到什么 header.

    用法: GET /v1/debug-headers?api_key=<PROXY_API_KEY>
    必须传正确的 api_key (走 query 不被网关改写) 才能访问.
    返回的 expected_key_repr 用 repr() 包括引号 - 能看出有没有隐形空白.
    """
    _verify_proxy_key(authorization, x_api_key, api_key)
    expected = settings.PROXY_API_KEY
    return {
        "authorization_header_present": authorization is not None,
        "authorization_header_len": len(authorization) if authorization else 0,
        "authorization_header_first10": authorization[:10] if authorization else None,
        "x_api_key_present": x_api_key is not None,
        "x_api_key_len": len(x_api_key) if x_api_key else 0,
        "query_api_key_present": api_key is not None,
        "expected_key_len": len(expected),
        "expected_key_first6": expected[:6],
        "expected_key_last4": expected[-4:],
        "expected_key_repr": repr(expected),
        "client_host": request.client.host if request.client else None,
        "all_headers_keys": sorted(request.headers.keys()),
    }


@router.post("/chat/completions")
async def chat_completions(request: Request,
                           authorization: Optional[str] = Header(None),
                           x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
                           api_key: Optional[str] = None,
                           db: Session = Depends(get_db)):
    _verify_proxy_key(authorization, x_api_key, api_key)
    body = await request.json()
    is_stream = body.get("stream", False)

    def build(ep, key, prov):
        out = dict(body); out["model"] = ep.model_id
        url = _join_upstream(_provider_url(db, ep), "chat/completions")
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
                      x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
                      api_key: Optional[str] = None,
                      db: Session = Depends(get_db)):
    _verify_proxy_key(authorization, x_api_key, api_key)
    body = await request.json()

    def build(ep, key, prov):
        out = dict(body); out["model"] = ep.model_id
        url = _join_upstream(_provider_url(db, ep), "embeddings")
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
                 x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
                 api_key: Optional[str] = None,
                 db: Session = Depends(get_db)):
    _verify_proxy_key(authorization, x_api_key, api_key)
    body = await request.json()

    def build(ep, key, prov):
        out = dict(body); out["model"] = ep.model_id
        url = _join_upstream(_provider_url(db, ep), "rerank")
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
              x_api_key: Optional[str] = Header(None, alias="X-Api-Key"),
              api_key: Optional[str] = None,
              db: Session = Depends(get_db)):
    _verify_proxy_key(authorization, x_api_key, api_key)
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
        url = _join_upstream(_provider_url(db, ep), "chat/completions")
        return "POST", url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, chat_body
    try:
        sr = await schedule(db, "ocr", build, lambda r: r)
        resp = JSONResponse(sr.data)
        resp.headers["X-Routed-Via"] = sr.routed_via
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except RuntimeError as e:
        raise HTTPException(503, str(e))
