FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 非 root 运行 — 先建用户，COPY 时直接 chown，避免多一层
RUN useradd -m appuser
COPY --chown=appuser:appuser . .
USER appuser

EXPOSE 7860

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
