"""主入口 — FastAPI app"""
import logging
import asyncio
import secrets
import time
import json
import hmac
from contextlib import asynccontextmanager
from typing import Optional
from fastapi import FastAPI, Header, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pathlib import Path

from app.core.config import settings, validate_runtime_config
from app.db.database import init_db
from app.routers import proxy_router, admin_router, stats_router

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("main")

# ======== 会话管理 (在中间件之前定义) ========
_SESSION_COOKIE = "llmproxy_admin"
_sessions: dict[str, float] = {}
_SESSION_TTL = 86400  # 1 天

# ======== 登录限速 ========
_login_fails: dict[str, list] = {}  # ip -> [timestamp, ...]
_LOGIN_MAX_FAILS = 5
_LOGIN_LOCK_SEC = 300


def _make_session() -> str:
    tok = secrets.token_urlsafe(24)
    _sessions[tok] = time.time() + _SESSION_TTL
    return tok


def _check_session(token: Optional[str]) -> bool:
    if not token or token not in _sessions:
        return False
    if _sessions[token] < time.time():
        _sessions.pop(token, None)
        return False
    return True


def _cleanup_expired_sessions():
    """清理过期会话，防止内存泄漏"""
    now = time.time()
    expired = [k for k, v in _sessions.items() if v < now]
    for k in expired:
        _sessions.pop(k, None)


async def _session_gc_loop():
    """后台任务：每小时清理一次过期会话"""
    while True:
        await asyncio.sleep(3600)
        try:
            _cleanup_expired_sessions()
        except Exception as e:
            logger.warning("session gc failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动前强制校验关键配置 — 漏设直接拒绝启动
    validate_runtime_config()
    logger.info("Initializing database at %s", settings.DB_PATH)
    init_db()
    logger.info("DB ready. Proxy API key auth: ON")
    # 启动后台会话清理任务
    gc_task = asyncio.create_task(_session_gc_loop())
    yield
    gc_task.cancel()
    # 关闭复用的 httpx client
    from app.core.scheduler import close_client
    await close_client()


app = FastAPI(
    title="Unified LLM Proxy",
    description="统一国内大模型中转 — 多 Key 轮询 · 自动故障切换 · OpenAI 兼容",
    version="2.0.0",
    lifespan=lifespan,
)


# 全局异常处理器 - 所有未捕获异常返回 JSON 而非 'Internal Server Error' 裸文本
# 调试/客户端友好, 让 OpenAI SDK 等能解析错误体
from fastapi.responses import JSONResponse as _JSONResp

@app.exception_handler(Exception)
async def _global_exc_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s: %s",
                     request.method, request.url.path, exc)
    return _JSONResp(
        status_code=500,
        content={"detail": f"{type(exc).__name__}: {str(exc)[:500]}"},
    )


app.include_router(proxy_router)
app.include_router(admin_router)
app.include_router(stats_router)


# ======== 管理API鉴权中间件 ========
from starlette.middleware.base import BaseHTTPMiddleware


class AdminAuthMiddleware(BaseHTTPMiddleware):
    """所有 /api/admin/* 和 /api/stats/* 必须带有效会话 cookie, 否则 401"""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/admin") or path.startswith("/api/stats"):
            tok = request.cookies.get(_SESSION_COOKIE)
            if not _check_session(tok):
                return Response(
                    '{"detail":"Unauthorized — please login first"}',
                    status_code=401,
                    media_type="application/json",
                )
        return await call_next(request)


app.add_middleware(AdminAuthMiddleware)


@app.get("/healthz", tags=["Meta"])
async def healthz():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    tok = request.cookies.get(_SESSION_COOKIE)
    if _check_session(tok):
        return HTMLResponse(_index_html())
    return HTMLResponse(_login_page())


@app.post("/login", tags=["Auth"])
async def login(request: Request):
    _cleanup_expired_sessions()  # 顺手清理过期会话
    ip = request.client.host if request.client else "unknown"

    # 检查 IP 是否被锁定 — 5 分钟内失败 5 次则锁 5 分钟
    fails = [t for t in _login_fails.get(ip, []) if t > time.time() - _LOGIN_LOCK_SEC]
    if len(fails) >= _LOGIN_MAX_FAILS:
        return Response(json.dumps({"ok": False, "msg": "尝试过多，已锁定 5 分钟"}),
                        status_code=429, media_type="application/json")

    body = await request.json()
    pwd = body.get("password", "")
    if hmac.compare_digest(pwd, settings.ADMIN_PASSWORD):
        _login_fails.pop(ip, None)  # 成功 → 清空该 IP 的失败计数
        tok = _make_session()
        secure = request.url.scheme == "https"
        resp = Response(json.dumps({"ok": True}))
        resp.set_cookie(_SESSION_COOKIE, tok, httponly=True, secure=secure,
                        max_age=_SESSION_TTL, samesite="lax")
        return resp
    _login_fails.setdefault(ip, []).append(time.time())
    return Response(json.dumps({"ok": False, "msg": "密码错误"}), status_code=401,
                    media_type="application/json")


@app.get("/logout", tags=["Auth"])
async def logout():
    resp = RedirectResponse("/", status_code=303)
    resp.delete_cookie(_SESSION_COOKIE)
    return resp


def _login_page() -> str:
    return """<!DOCTYPE html><html><head><meta charset="utf-8"><title>LLM Proxy 登录</title>
<style>body{font-family:sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.card{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:320px}
h2{margin:0 0 16px;color:#1a73e8}input{width:100%;padding:10px;margin:8px 0;border:1px solid #d0d7e2;border-radius:6px;box-sizing:border-box}
button{width:100%;padding:10px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-top:8px}
.err{color:#d32f2f;font-size:13px;margin-top:8px;min-height:18px}</style></head>
<body><div class="card"><h2>🔁 LLM Proxy</h2>
<p style="font-size:13px;color:#666;margin-bottom:12px">请输入管理密码</p>
<input type="password" id="pwd" placeholder="ADMIN_PASSWORD" autofocus
       onkeydown="if(event.key==='Enter')doLogin()">
<button onclick="doLogin()">登录</button>
<div id="errMsg" class="err"></div></div>
<script>
async function doLogin(){
  const pwd=document.getElementById('pwd').value;
  document.getElementById('errMsg').textContent='';
  try{
    const res=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});
    if(res.ok){location.reload();return;}
    const data=await res.json().catch(()=>({}));
    document.getElementById('errMsg').textContent=data.msg||('登录失败 ('+res.status+')');
  }catch(e){document.getElementById('errMsg').textContent='网络错误: '+e.message;}
}
</script></body></html>"""


def _index_html() -> str:
    return Path("app/templates/index.html").read_text(encoding="utf-8")
