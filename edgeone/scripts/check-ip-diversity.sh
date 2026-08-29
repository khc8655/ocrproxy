#!/usr/bin/env bash
# scripts/check-ip-diversity.sh
#
# VERIFY THE CORE ASSUMPTION of the EdgeOne strategy: that requests
# routed through Edge Functions actually egress from DIVERSE source IPs
# to the upstream LLM provider.  If this is false (e.g. all egress NAT'd
# through a small pool of Tencent backbone IPs), the whole "amplify
# free-key usage via edge IP" premise falls apart.
#
# How it works:
#   1. Deploy a tiny Edge Function that calls fetch('https://api.ipify.org')
#      and returns the JSON it gets (which is the *egress* IP, not the
#      client IP).  Example code below.
#   2. Hit the function 50-100 times from this script.
#   3. Count unique egress IPs.  Need at least 10+ unique IPs for the
#      "amplify free-key" strategy to work; ideally 50+.
#
# Required env:
#   EDGEONE_TEST_URL   - full URL of the test edge function
#                        e.g. https://agent-test.edgeone.app/check-ip
#                        The function should return:
#                          { "clientIp": "...", "egressIp": "...", "nodeUuid": "..." }
#   EDGEONE_TOKEN      - optional bearer token if your test fn requires it
#
# Usage:
#   EDGEONE_TEST_URL=https://agent-test.edgeone.app/check-ip \
#     ./scripts/check-ip-diversity.sh
#
# Exit codes:
#   0  - IP diversity confirmed (>= 10 unique egress IPs in 50 samples)
#   1  - Test setup error (no URL, fn not reachable)
#   2  - IP diversity INSUFFICIENT — strategy may not work as planned

set -u

URL="${EDGEONE_TEST_URL:-}"
TOKEN="${EDGEONE_TOKEN:-}"
SAMPLES="${SAMPLES:-50}"
MIN_UNIQUE="${MIN_UNIQUE:-10}"

if [ -z "$URL" ]; then
  echo "ERROR: EDGEONE_TEST_URL is not set."
  echo ""
  echo "Deploy a test function first.  Save this as edge-functions/check-ip.js:"
  echo ""
  cat <<'EOF'
  export default async function onRequestGet(context) {
    const r = await fetch('https://api.ipify.org?format=json');
    const egress = await r.json();
    return new Response(JSON.stringify({
      clientIp: context.request.eo.clientIp,
      egressIp: egress.ip,
      nodeUuid: context.request.eo.uuid,
      country:  context.request.eo.geo?.countryCodeAlpha2,
    }), { headers: { 'content-type': 'application/json' } });
  }
EOF
  exit 1
fi

echo "== IP diversity check =="
echo "URL:     $URL"
echo "Samples: $SAMPLES"
echo "Min unique egress IPs required: $MIN_UNIQUE"
echo ""

CLIENT_IPS=()
EGRESS_IPS=()
COUNTRIES=()
ERRORS=0

for i in $(seq 1 "$SAMPLES"); do
  HDRS=(-H "user-agent: EdgeOne-IPCheck/1.0")
  if [ -n "$TOKEN" ]; then
    HDRS+=(-H "authorization: Bearer $TOKEN")
  fi
  RESP=$(curl -sS --max-time 15 "${HDRS[@]}" "$URL" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$RESP" ]; then
    ERRORS=$((ERRORS + 1))
    continue
  fi
  C_IP=$(echo "$RESP"  | sed -n 's/.*"clientIp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  E_IP=$(echo "$RESP"  | sed -n 's/.*"egressIp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  CTY=$(echo "$RESP"   | sed -n 's/.*"country"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  CLIENT_IPS+=("$C_IP")
  EGRESS_IPS+=("$E_IP")
  COUNTRIES+=("$CTY")
  printf "  [%2d] client=%-15s egress=%-15s country=%s\n" "$i" "$C_IP" "$E_IP" "$CTY"
done

UNIQUE_EGRESS=$(printf '%s\n' "${EGRESS_IPS[@]}" | sort -u | grep -c . || true)
UNIQUE_CLIENT=$(printf '%s\n' "${CLIENT_IPS[@]}" | sort -u | grep -c . || true)
UNIQUE_COUNTRIES=$(printf '%s\n' "${COUNTRIES[@]}" | sort -u | grep -c . || true)

echo ""
echo "== Summary =="
echo "Total requests:    $SAMPLES"
echo "Errors:            $ERRORS"
echo "Unique egress IPs: $UNIQUE_EGRESS"
echo "Unique client IPs: $UNIQUE_CLIENT"
echo "Unique countries:  $UNIQUE_COUNTRIES"
echo ""

# Top 5 egress IPs
echo "Top egress IPs (request count):"
printf '%s\n' "${EGRESS_IPS[@]}" | sort | uniq -c | sort -rn | head -5
echo ""

if [ "$ERRORS" -ge "$((SAMPLES / 4))" ]; then
  echo "FAIL: too many errors ($ERRORS / $SAMPLES).  Check EDGEONE_TEST_URL."
  exit 1
fi

if [ "$UNIQUE_EGRESS" -lt "$MIN_UNIQUE" ]; then
  echo "FAIL: only $UNIQUE_EGRESS unique egress IPs (< $MIN_UNIQUE)."
  echo "      The 'amplify free-key via edge IP' strategy may not work."
  echo "      EdgeOne may be NATing egress through a small pool of IPs."
  echo "      Consider falling back to the VM proxy or mixing strategies."
  exit 2
fi

echo "PASS: $UNIQUE_EGRESS unique egress IPs in $SAMPLES samples."
echo "      EdgeOne IP diversity confirmed — strategy is viable."
exit 0
