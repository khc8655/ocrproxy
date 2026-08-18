"""
ocrproxy VM 版本主应用入口
将 EdgeOne 版本的所有功能整合为一个独立的 FastAPI 应用。
"""
import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .proxy_routes import router as proxy_router
from .admin_routes import router as admin_router
from .scheduler import close_client
from .config_store import clear_cache, get_config

# Load .env file
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
# Reduce httpx noise: only log warnings and errors from the HTTP client
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("ocrproxy")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.environ.get("PROXY_API_KEY"):
        logger.warning("PROXY_API_KEY is not set — every /v1 request will be rejected with 401.")
    yield
    # Clean up resources on shutdown.
    await close_client()
    logger.info("OCRProxy shutdown complete.")


app = FastAPI(title="OCRProxy VM", version="3.1.0", lifespan=lifespan)

# Mount routers
# Proxy routes at /v1/* (and /api/v1/* for transparent routing)
app.include_router(proxy_router)
app.include_router(proxy_router, prefix="/api")

# Admin routes at /api/admin/*
app.include_router(admin_router)

# Serve admin panel + self-hosted vendor assets (font-awesome, chart.js).
# Vendor files are immutable per version — allow browser caching; the HTML
# itself is sent with Cache-Control: no-cache so panel updates are picked up
# on the next regular refresh instead of living in heuristic cache for days.
STATIC_DIR = Path(__file__).parent.parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

_NO_CACHE_HTML_HEADERS = {"Cache-Control": "no-cache, must-revalidate"}


@app.get("/")
async def admin_page():
    """Serve the admin panel HTML."""
    admin_file = STATIC_DIR / "admin.html"
    if admin_file.exists():
        return FileResponse(str(admin_file), media_type="text/html",
                            headers=_NO_CACHE_HTML_HEADERS)
    return JSONResponse(status_code=404, content={"error": "Admin panel not found"})


@app.get("/admin")
async def admin_page_alias():
    """Alias for admin panel."""
    return await admin_page()


@app.get("/health")
async def health_check():
    """Health check endpoint for monitoring."""
    try:
        # Verify config can be read
        await get_config()
        return {"status": "ok"}
    except Exception as e:
        logger.error("Health check failed: %s", e)
        return JSONResponse(
            status_code=503,
            content={"status": "error"}
        )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("APP_PORT", "8787"))
    host = os.environ.get("APP_HOST", "127.0.0.1")
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level="info",
        access_log=True,
    )
