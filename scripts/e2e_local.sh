#!/usr/bin/env bash
# 本地端到端测试 (不依赖 Docker) - 直接用 venv 起 uvicorn
# 用法: bash scripts/e2e_local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-17861}"
DB="/tmp/llmproxy-e2e-$$.db"
LOGFILE="/tmp/llmproxy-e2e-$$.log"
ENCRYPT_KEY="rXGY3aVOs22PNwwj69PudHmGM3fCloipuHl7tMDmeZY="
PROXY_KEY="e2e-proxy-key-$$"
ADMIN_PWD="e2e-admin-$$"
BASE="http://localhost:$PORT"

red(){ echo -e "\033[31m$*\033[0m" >&2; }
grn(){ echo -e "\033[32m$*\033[0m"; }
ylw(){ echo -e "\033[33m$*\033[0m"; }

PID=""
cleanup(){
  [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true
  rm -f "$DB" "$DB-shm" "$DB-wal" "$LOGFILE" /tmp/llmproxy-e2e-cookie-$$
}
trap cleanup EXIT

step(){ ylw "=== $* ==="; }
fail(){ red "✗ FAIL: $*"; red "--- last log ---"; tail -40 "$LOGFILE" >&2 || true; exit 1; }
ok(){ grn "✓ $*"; }

# 检查 venv
[[ -f venv/bin/python ]] || fail "需要 ./venv (运行 python3 -m venv venv && pip install -r requirements.txt)"

step "0. 启动 uvicorn (PORT=$PORT, DB=$DB)"
ENCRYPT_KEY="$ENCRYPT_KEY" \
PROXY_API_KEY="$PROXY_KEY" \
ADMIN_PASSWORD="$ADMIN_PWD" \
DB_PATH="$DB" \
MOUNT_WAIT_SEC=1 \
venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT" > "$LOGFILE" 2>&1 &
PID=$!

step "1. /healthz (最多等 20s)"
for i in $(seq 1 20); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then ok "/healthz OK after ${i}s"; break; fi
  sleep 1
  [[ $i -eq 20 ]] && fail "/healthz 20s 内未就绪"
done

# --- 2. 未登录 /api/admin/* → 401 ---
step "2. 未登录 admin - 期望 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/admin/providers")
[[ "$code" == "401" ]] && ok "401 ✓" || fail "期望 401, 实得 $code"

# --- 3. 错误密码 ---
step "3. 错误密码登录 - 期望 401"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/login" \
  -H "Content-Type: application/json" -d '{"password":"wrong"}')
[[ "$code" == "401" ]] && ok "401 ✓" || fail "期望 401, 实得 $code"

# --- 4. 正确登录 ---
step "4. 正确密码登录"
COOKIE=/tmp/llmproxy-e2e-cookie-$$
rm -f "$COOKIE"
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST "$BASE/login" \
  -H "Content-Type: application/json" -d "{\"password\":\"$ADMIN_PWD\"}")
[[ "$code" == "200" ]] && ok "登录 200 ✓" || fail "期望 200, 实得 $code"
grep -q "llmproxy_admin" "$COOKIE" || fail "cookie 缺失"

API(){ curl -s -b "$COOKIE" "$@"; }

# --- 5. agent-info ---
step "5. /api/admin/agent-info"
body=$(API "$BASE/api/admin/agent-info")
echo "$body" | grep -q "$PROXY_KEY" && ok "返回了正确 PROXY_API_KEY ✓" || fail "agent-info 不含预期 key: $body"
echo "$body" | grep -q '"type":"ocr"' && ok "包含 ocr 类型 ✓" || fail "model_types 缺 ocr"

# --- 6. 创建 provider ---
step "6. 创建 provider"
body=$(API -X POST "$BASE/api/admin/providers" -H "Content-Type: application/json" \
  -d "{\"name\":\"test-mock\",\"base_url\":\"$BASE\"}")
PVID=$(echo "$body" | venv/bin/python -c "import json,sys;print(json.load(sys.stdin)['id'])")
ok "provider id=$PVID ✓"

# --- 7. keys/test ---
step "7. /api/admin/keys/test - 本服务无 /v1/models, 期望 ok=false 404"
body=$(API -X POST "$BASE/api/admin/keys/test" -H "Content-Type: application/json" \
  -d "{\"provider_id\":$PVID,\"api_key\":\"sk-anything\"}")
echo "$body" | grep -q '"ok":false' && ok "正确识别失败 ✓" || fail "test 接口应返回 ok=false: $body"
echo "$body" | grep -q '"http_status":404' && ok "http_status=404 ✓" || ylw "  (http_status 不是 404, 但 ok=false 已通过)"

# --- 8. 创建 4 个端点 ---
step "8. 创建 4 个 model_type 端点"
for mt in ocr embedding reranker chat; do
  body=$(API -X POST "$BASE/api/admin/endpoints" -H "Content-Type: application/json" \
    -d "{\"provider_id\":$PVID,\"model_type\":\"$mt\",\"model_id\":\"mock-$mt\"}")
  echo "$body" | grep -q "\"model_type\":\"$mt\"" || fail "创建 $mt 失败: $body"
done
ok "4 类端点 ✓"

# --- 9. 创建 2 个 key (无 api_key 留空 -> 不行, 必填) ---
step "9. 创建 2 个 key"
for label in k1 k2; do
  body=$(API -X POST "$BASE/api/admin/keys" -H "Content-Type: application/json" \
    -d "{\"provider_id\":$PVID,\"label\":\"$label\",\"api_key\":\"sk-fake-$label-XYZ\"}")
  echo "$body" | grep -q "\"label\":\"$label\"" || fail "创建 $label 失败: $body"
done
ok "2 key ✓"

# --- 10. 候选数 = 8 ---
step "10. 候选数 = 2 key × 4 endpoint = 8"
body=$(API "$BASE/api/admin/candidates")
count=$(echo "$body" | venv/bin/python -c "import json,sys;print(len(json.load(sys.stdin)))")
[[ "$count" == "8" ]] && ok "候选数=8 ✓" || fail "期望 8, 实得 $count"

# --- 11. 排序原子交换 ---
step "11. 排序原子交换"
pairs=$(echo "$body" | venv/bin/python -c "
import json,sys
rows=[r for r in json.load(sys.stdin) if r['model_type']=='ocr']
rows.sort(key=lambda r:(r['seq'],r['id']))
print(rows[0]['id'],rows[0]['seq'],rows[1]['id'],rows[1]['seq'])
")
read id1 seq1 id2 seq2 <<<"$pairs"
ok "初始: cand#$id1 seq=$seq1  cand#$id2 seq=$seq2"

body=$(API -X POST "$BASE/api/admin/candidates/$id1/move?dir=down")
echo "$body" | grep -q '"moved":true' && ok "move down 成功 ✓" || fail "$body"

new=$(API "$BASE/api/admin/candidates" | venv/bin/python -c "
import json,sys
rows={r['id']:r['seq'] for r in json.load(sys.stdin)}
print(rows.get($id1),rows.get($id2))
")
read new1 new2 <<<"$new"
[[ "$new1" == "$seq2" && "$new2" == "$seq1" ]] && ok "seq 已原子交换 ✓ ($id1: $seq1→$new1  $id2: $seq2→$new2)" || \
  fail "交换异常: $id1=$new1 $id2=$new2"

API -X POST "$BASE/api/admin/candidates/$id1/move?dir=up" >/dev/null
final=$(API "$BASE/api/admin/candidates" | venv/bin/python -c "
import json,sys
rows={r['id']:r['seq'] for r in json.load(sys.stdin)}
print(rows.get($id1),rows.get($id2))
")
read fin1 fin2 <<<"$final"
[[ "$fin1" == "$seq1" && "$fin2" == "$seq2" ]] && ok "move up 还原 ✓" || fail "$id1=$fin1 $id2=$fin2"

# --- 12. /v1 鉴权 ---
step "12. /v1/models 无 token → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/models")
[[ "$code" == "401" ]] && ok "401 ✓" || fail "$code"

step "13. /v1/models 错 token → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" "$BASE/v1/models")
[[ "$code" == "401" ]] && ok "401 ✓" || fail "$code"

step "14. /v1/models 正确 token → 200"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PROXY_KEY" "$BASE/v1/models")
[[ "$code" == "200" ]] && ok "200 ✓" || fail "$code"

# --- 14b/14c. 新增: 备用鉴权方式 ---
step "14b. /v1/models 用 X-Api-Key 头 → 200"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Api-Key: $PROXY_KEY" "$BASE/v1/models")
[[ "$code" == "200" ]] && ok "200 ✓" || fail "$code"

step "14c. /v1/models 用 ?api_key= query → 200"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/models?api_key=$PROXY_KEY")
[[ "$code" == "200" ]] && ok "200 ✓" || fail "$code"

step "14d. /v1/debug-headers 需要鉴权 - 用 query 形式访问"
body=$(curl -s "$BASE/v1/debug-headers?api_key=$PROXY_KEY")
echo "$body" | grep -q "expected_key_len" && ok "debug-headers 返回了诊断信息 ✓" || fail "debug-headers 异常: $body"

# --- 15. DB 真的写到 env 路径 ---
step "15. 验证 DB_PATH=$DB 生效"
[[ -f "$DB" ]] && ok "$DB 存在 ✓" || fail "DB 未写到 env 指定路径"

grn ""
grn "========================================"
grn "  ✅ 所有 e2e 测试通过"
grn "========================================"
