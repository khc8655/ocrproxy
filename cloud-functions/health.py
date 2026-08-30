from fastapi import FastAPI
from fastapi.responses import JSONResponse
import time

app = FastAPI()

@app.get("")
@app.get("/")
@app.get("/health")
@app.get("/v1/health")
async def health():
    return JSONResponse(
        content={
            "status": "ok",
            "runtime_hint": "cloud-function-python",
            "timestamp": time.time()
        },
        headers={"cache-control": "no-store"}
    )
