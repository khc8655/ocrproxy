#!/usr/bin/env bash
# 本地端到端测试 - 起容器, 覆盖所有关键接口
# 用法: bash scripts/e2e_test.sh
set -euo pipefail

cd "$(dirname "$0")/.."

IMG="llmproxy:e2e-$(date +%s)"
NAME="llmproxy-e2e-$$"
PORT="${E2E_PORT:-17860}"
ENCRYPT_KEY="rXGY3aVOs22PNwwj69PudHmGM3fCloipuHl7tMDmeZY="
PROXY_KEY="e2e-proxy-key-$(date +%s)"
ADMIN_PWD="e2e-admin-$(date +%s)"
BASE="http://localhost:$PORT"

red(){ echo -e "\033[31m$*\033[0m" >&2; }
grn(){ echo -e "\033[32m$*\033[0m"; }
ylw(){ echo -e "\033[33m$*\033[0m"; }

cleanup(){
  docker stop "$NAME" >/dev/null 2>&1 || true
  docker rm   "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step(){ ylw "=== $* ==="; }
fail(){ red "✗ FAIL: $*"; exit 1; }
ok(){ grn "✓ $*"; }

# --- 0. Build ---
step "0. docker build"
docker build -q -t "$IMG" . > /dev/null
ok "镜像 build 完成: $IMG"

# --- 1. Run ---
step "1. docker run (注入 env, 不挂 /mnt/workspace, 验证本地路径回退)"
docker run -d --name "$NAME" \
  -e ENCRYPT_KEY="$ENCRYPT_KEY" \
  -e PROXY_API_KEY="$PROXY_KEY" \
  -e ADMIN_PASSWORD="$ADMIN_PWD" \
  -e DB_PATH="/tmp/proxy.db" \
  -e MOUNT_WAIT_SEC=3 \
  -p "$PORT:7860" "$IMG" > /dev/null
ok "容器启动: $NAME"

# --- 2. Healthz ---
step "2. /healthz (最多等 30s)"
for i in $(seq 1 30); do
  if curl -sf "$BASE/healthz" >/dev/null 2>&1; then ok "/healthz OK after ${i}s"; break; fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    red "=== 容器日志 ==="; docker logs "$NAME" | tail -50
    fail "/healthz 30s 内未就绪"
  fi
done

# --- 3. 未登录, /api/admin/* 应 401 ---
step "3. 未登录访问 /api/admin/providers - 期望 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/admin/providers")
[[ "$code" == "401" ]] && ok "401 ✓" || fail "期望 401, 实得 $code"

# --- 4. 错误密码登录 - 401 ---
step "4. 错误密码登录 - 期望 401"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/login" \
  -H "Content-Type: application/json" -d '{"password":"wrong"}')
[[ "$code" == "401" ]] && ok "401 ✓" || fail "期望 401, 实得 $code"

# --- 5. 正确密码登录 - 200 + cookie ---
step "5. 正确密码登录 + 拿 cookie"
COOKIE=/tmp/llmproxy-e2e-cookie-$$
rm -f "$COOKIE"
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE" -X POST "$BASE/login" \
  -H "Content-Type: application/json" -d "{\"password\":\"$ADMIN_PWD\"}")
[[ "$code" == "200" ]] && ok "登录 200 ✓" || fail "期望 200, 实得 $code"
grep -q "llmproxy_admin" "$COOKIE" && ok "cookie 拿到 ✓" || fail "cookie 缺失"

API(){ curl -s -b "$COOKIE" "$@"; }

# --- 6. 已登录 /api/admin/providers - 应空数组 ---
step "6. /api/admin/providers - 期望 []"
body=$(API "$BASE/api/admin/providers")
[[ "$body" == "[]" ]] && ok "空数组 ✓" || fail "期望 [], 实得 $body"

# --- 7. agent-info ---
step "7. /api/admin/agent-info - 包含 PROXY_API_KEY"
body=$(API "$BASE/api/admin/agent-info")
echo "$body" | grep -q "$PROXY_KEY" && ok "返回了正确的 PROXY_API_KEY ✓" || {
  echo "body: $body"; fail "agent-info 不含预期 key"
}
echo "$body" | grep -q '"type":"ocr"' && ok "包含 ocr 模型类型 ✓" || fail "model_types 缺 ocr"

# --- 8. 创建 provider ---
step "8. 创建 provider (test-mock, base_url 指向自己的 /v1/models)"
body=$(API -X POST "$BASE/api/admin/providers" -H "Content-Type: application/json" \
  -d "{\"name\":\"test-mock\",\"base_url\":\"$BASE\"}")
PID=$(echo "$body" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
ok "provider id=$PID ✓"

# --- 9. /api/admin/keys/test - 应 404(本服务没 /v1/models 端点) ---
step "9. /api/admin/keys/test - 上游无 /v1/models, 期望 ok=false"
body=$(API -X POST "$BASE/api/admin/keys/test" -H "Content-Type: application/json" \
  -d "{\"provider_id\":$PID,\"api_key\":\"sk-anything\"}")
echo "$body" | grep -q '"ok":false' && ok "正确识别失败 ✓" || {
  echo "body: $body"; fail "test 接口应返回 ok=false"
}

# --- 10. 创建 endpoint(各类一个) ---
step "10. 创建 4 个端点"
for mt in ocr embedding reranker chat; do
  body=$(API -X POST "$BASE/api/admin/endpoints" -H "Content-Type: application/json" \
    -d "{\"provider_id\":$PID,\"model_type\":\"$mt\",\"model_id\":\"mock-$mt\"}")
  echo "$body" | grep -q "\"model_type\":\"$mt\"" || fail "创建 $mt 失败: $body"
done
ok "4 个端点全部创建 ✓"

# --- 11. 创建 2 个 key ---
step "11. 创建 2 个 key"
for label in k1 k2; do
  body=$(API -X POST "$BASE/api/admin/keys" -H "Content-Type: application/json" \
    -d "{\"provider_id\":$PID,\"label\":\"$label\",\"api_key\":\"sk-fake-$label\"}")
  echo "$body" | grep -q "\"label\":\"$label\"" || fail "创建 key $label 失败: $body"
done
ok "2 个 key 创建 ✓"

# --- 12. 候选数应为 8(2 key × 4 endpoint) ---
step "12. 候选数 = 8"
body=$(API "$BASE/api/admin/candidates")
count=$(echo "$body" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[[ "$count" == "8" ]] && ok "候选数=8 ✓" || fail "期望 8, 实得 $count"

# --- 13. 候选排序原子交换 ---
step "13. 候选排序: 取 ocr 类的两个候选, 交换 seq, 再换回"
ocr_list=$(echo "$body" | python3 -c "
import json,sys
rows=[r for r in json.load(sys.stdin) if r['model_type']=='ocr']
rows.sort(key=lambda r:(r['seq'],r['id']))
print(rows[0]['id'],rows[0]['seq'],rows[1]['id'],rows[1]['seq'])
")
read id1 seq1 id2 seq2 <<<"$ocr_list"
ok "初始: cand#$id1 seq=$seq1  cand#$id2 seq=$seq2"

# down id1 一次 - 应该跟 id2 交换
body=$(API -X POST "$BASE/api/admin/candidates/$id1/move?dir=down")
echo "$body" | grep -q '"moved":true' && ok "move down 成功 ✓" || fail "move down 失败: $body"

new=$(API "$BASE/api/admin/candidates" | python3 -c "
import json,sys
rows={r['id']:r['seq'] for r in json.load(sys.stdin)}
print(rows.get($id1),rows.get($id2))
")
read new1 new2 <<<"$new"
[[ "$new1" == "$seq2" && "$new2" == "$seq1" ]] && ok "seq 交换 ✓ ($id1: $seq1→$new1  $id2: $seq2→$new2)" || \
  fail "交换异常: $id1 现在 $new1, $id2 现在 $new2"

# up 回来
API -X POST "$BASE/api/admin/candidates/$id1/move?dir=up" >/dev/null
final=$(API "$BASE/api/admin/candidates" | python3 -c "
import json,sys
rows={r['id']:r['seq'] for r in json.load(sys.stdin)}
print(rows.get($id1),rows.get($id2))
")
read fin1 fin2 <<<"$final"
[[ "$fin1" == "$seq1" && "$fin2" == "$seq2" ]] && ok "move up 还原成功 ✓" || \
  fail "move up 失败: $id1=$fin1 $id2=$fin2"

# --- 14. /v1/models 鉴权 ---
step "14. /v1/models 无 token - 期望 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/models")
[[ "$code" == "401" ]] && ok "401 ✓" || fail "期望 401, 实得 $code"

step "15. /v1/models 错 token - 期望 401"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" "$BASE/v1/models")
[[ "$code" == "401" ]] && ok "401 ✓" || fail "期望 401, 实得 $code"

step "16. /v1/models 正确 token - 期望 200"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PROXY_KEY" "$BASE/v1/models")
[[ "$code" == "200" ]] && ok "200 ✓" || fail "期望 200, 实得 $code"

# --- 17. DB_PATH env 真的生效 ---
step "17. 验证 DB_PATH=/tmp/proxy.db 已生效"
docker exec "$NAME" test -f /tmp/proxy.db && ok "/tmp/proxy.db 存在 ✓" || fail "DB 未写到 env 指定路径"

# --- 18. logout ---
step "18. /logout"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" "$BASE/logout")
[[ "$code" == "303" || "$code" == "200" ]] && ok "logout 返回 $code ✓" || fail "logout 异常: $code"

rm -f "$COOKIE"
grn ""
grn "========================================"
grn "  ✅ 所有 e2e 测试通过 ($(date +%T))"
grn "========================================"
