"""
health.py — Cloud Function (Python / FastAPI) health check.

File-system prefix is `/health`, so EdgeOne strips that before calling
FastAPI.  We define the route at `/` which matches any path under
`/health` (only `/health` is the realistic entry).
"""

import time
import os
from fastapi import FastAPI

app = FastAPI(title="OCRProxy Agent Relay — Health")


@app.get("/")
async def health():
    return {
        "status": "ok",
        "runtime_hint": "cloud-function-python",
        "config_loaded": bool(os.environ.get("AGENT_CONFIG_JSON")),
        "model_count": 0,  # populated at module init; not available here
        "timestamp": time.time(),
    }
