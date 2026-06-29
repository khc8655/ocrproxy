FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 非 root 运行 — 先建用户并预建可写目录
RUN useradd -m appuser && mkdir -p /app/data && chown -R appuser:appuser /app
COPY --chown=appuser:appuser . .
USER appuser

EXPOSE 7860

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
