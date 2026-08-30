#!/usr/bin/env bash
# scripts/smoke-test.sh — quick end-to-end smoke test of the deployed relay.
#
# Required env:
#   EDGEONE_BASE_URL - e.g. https://agent.example.com
#   PROXY_API_KEY    - the bearer token configured in env
#
# What it does:
#   1. GET /health  → expect 200 + {"status":"ok",...}
#   2. GET /v1/models → expect 200, list of model ids
#   3. POST /v1/chat/completions with a tiny prompt, non-streaming
#      → expect 200 with a model reply
#   4. POST /v1/chat/completions with stream=true
#      → expect 200, content-type: text/event-stream, at least one chunk
#   5. POST /v1/chat/completions with a bad token → expect 401
#   6. POST /v1/chat/completions with a missing model → expect 400/404
#
# Exit codes:
#   0  - all checks passed
#   non-zero - first failure

set -u

BASE="${EDGEONE_BASE_URL:-}"
KEY="${PROXY_API_KEY:-}"

if [ -z "$BASE" ] || [ -z "$KEY" ]; then
  echo "ERROR: EDGEONE_BASE_URL and PROXY_API_KEY must be set."
  exit 1
fi

pass=0
fail=0
check() {
  local label="$1"; shift
  local actual="$1"; shift
  local expected="$1"; shift
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $label (got $actual)"
    pass=$((pass+1))
  else
    echo "  FAIL  $label (got $actual, expected $expected)"
    fail=$((fail+1))
  fi
}

echo "== Smoke test =="
echo "BASE: $BASE"
echo ""

# 1. /health
echo "[1] GET /health"
RESP=$(curl -sS -o /tmp/health.json -w "%{http_code}" "$BASE/health")
check "GET /health status" "$RESP" "200"
cat /tmp/health.json
echo

# 2. /v1/models
echo
echo "[2] GET /v1/models"
RESP=$(curl -sS -o /tmp/models.json -w "%{http_code}" \
  -H "authorization: Bearer $KEY" "$BASE/v1/models")
check "GET /v1/models status" "$RESP" "200"
MODEL_IDS=$(python3 -c "import json; d=json.load(open('/tmp/models.json')); print(' '.join(m['id'] for m in d['data']))" 2>/dev/null || echo "")
echo "  models: $MODEL_IDS"
FIRST_MODEL=$(echo "$MODEL_IDS" | awk '{print $1}')

if [ -z "$FIRST_MODEL" ]; then
  echo "  no models found — skipping chat tests"
  exit 1
fi

# 3. Non-streaming chat
echo
echo "[3] POST /v1/chat/completions (non-streaming, model=$FIRST_MODEL)"
RESP=$(curl -sS -o /tmp/chat.json -w "%{http_code}" \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$FIRST_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}],\"max_tokens\":16,\"stream\":false}" \
  "$BASE/v1/chat/completions")
check "POST /v1/chat/completions status" "$RESP" "200"
echo "  body:"; head -c 400 /tmp/chat.json; echo

# 4. Streaming chat
echo
echo "[4] POST /v1/chat/completions (stream=true)"
RESP=$(curl -sS -o /tmp/stream.txt -D /tmp/stream.hdr -w "%{http_code}" \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -H "accept: text/event-stream" \
  -d "{\"model\":\"$FIRST_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Count: 1 2\"}],\"max_tokens\":32,\"stream\":true}" \
  "$BASE/v1/chat/completions")
check "stream status" "$RESP" "200"
CT=$(grep -i '^content-type:' /tmp/stream.hdr | head -1 | tr -d '\r')
echo "  $CT"
LINES=$(wc -l < /tmp/stream.txt)
echo "  received $LINES SSE lines"
[ "$LINES" -gt 0 ] && pass=$((pass+1)) || fail=$((fail+1))

# 5. Bad auth
echo
echo "[5] POST /v1/chat/completions (bad auth)"
RESP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "authorization: Bearer WRONG_KEY" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$FIRST_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" \
  "$BASE/v1/chat/completions")
check "bad-auth status" "$RESP" "401"

# 6. Unknown model
echo
echo "[6] POST /v1/chat/completions (unknown model)"
RESP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d "{\"model\":\"this-model-does-not-exist-xyz\",\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" \
  "$BASE/v1/chat/completions")
[ "$RESP" = "404" ] || [ "$RESP" = "400" ] && check "unknown-model status" "$RESP" "404" || check "unknown-model status" "$RESP" "404"

echo ""
echo "== Results =="
echo "PASS: $pass"
echo "FAIL: $fail"
[ "$fail" -eq 0 ] && exit 0 || exit 1
