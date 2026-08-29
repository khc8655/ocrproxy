# OCRProxy EdgeOne Agent Relay

> Agent-mode LLM API relay deployed to **Tencent Cloud EdgeOne Makers**.
> Stateless IP-rotator that leverages EdgeOne's 3200+ edge nodes to
> amplify the effective rate-limit budget of free LLM keys.

```
ocrproxy/
├── vm-app/           # KB mode + admin panel + scheduler (UNCHANGED, VM)
└── edgeone/          # Agent mode (this folder, NEW, EdgeOne)
    ├── FEASIBILITY-REPORT.md    ← start here
    ├── README.md                ← deployment guide (this file)
    ├── edgeone.json             ← EdgeOne project config
    ├── package.json             ← for the EdgeOne CLI
    ├── .env.example             ← env var template
    ├── edge-functions/          ← V8 functions (PRIMARY PATH, edge IPs)
    ├── cloud-functions/         ← Python functions (LONG-CONTEXT FALLBACK)
    └── scripts/                 ← ip-check, smoke-test
```

## TL;DR

- **Goal**: free the Agent-mode API relay from the VM, give it the IP diversity of EdgeOne.
- **Reality**: VM scheduler (cooldown,熔断,延迟排序) doesn't fit EdgeOne's stateless function model. So the EdgeOne version is intentionally **simpler**: random-key rotation, no state, no circuit breaker. The "IP diversity" replaces "smart failover" because the same load on the VM that triggered 429s will, from EdgeOne, be spread across hundreds of IPs and stop triggering them.
- **Range**:
  - Edge Function (V8): body ≤ 1 MB, edge IP egress — main path.
  - Cloud Function (Python): body ≤ 6 MB, 120s timeout — long-context fallback.
  - KB mode (chat/embedding/rerank/ocr with virtual aliases) stays on the VM.

Read [FEASIBILITY-REPORT.md](./FEASIBILITY-REPORT.md) first for the full technical analysis.

---

## 1. Prerequisites

- Node.js 18+ (for the `edgeone` CLI)
- A Tencent Cloud account with EdgeOne Makers enabled ([open here](https://console.cloud.tencent.com/edgeone))
- The `AGENT_CONFIG_JSON` extracted from your VM (see step 3.2)
- `tx_khc.pem` (already in repo root) if you SSH to the VM to extract config

## 2. Project layout

| File / dir | Purpose |
|------------|---------|
| `edgeone.json` | EdgeOne project metadata, function memory/timeout, KV namespace, env var manifest |
| `package.json` | npm scripts wrapping the EdgeOne CLI |
| `.env.example` | env var template |
| `edge-functions/lib/config.js` | Config loader + key-pool helpers (V8, ES modules) |
| `edge-functions/lib/normalize.js` | Provider-specific body normalizations (StepFun, Agnes, TokenRhythm, etc.) |
| `edge-functions/v1/chat/completions.js` | **MAIN**: `POST /v1/chat/completions` via Edge Function |
| `edge-functions/v1/models.js` | `GET /v1/models` |
| `edge-functions/health.js` | `GET /health` |
| `cloud-functions/v1.py` | **FALLBACK**: same routes via Cloud Function (Python 3.10 / FastAPI), 6 MB body |
| `cloud-functions/health.py` | `GET /health` (Cloud Function variant) |
| `cloud-functions/requirements.txt` | Python deps (fastapi, httpx) |
| `scripts/check-ip-diversity.sh` | Verify the core "edge IP" hypothesis before going live |
| `scripts/smoke-test.sh` | 6-step end-to-end smoke test |

## 3. One-time setup

### 3.1 Install the EdgeOne CLI

```bash
cd edgeone
npm install
# Confirm
npx edgeone --version
```

### 3.2 Extract config from the VM

The EdgeOne functions expect the same `providers` + `agent_models` shape as the VM. Pull it from the encrypted config:

```bash
ssh -i ../tx_khc.pem root@<vm-host> '
  sudo -u ocrproxy /opt/ocrproxy/venv/bin/python -c "
import asyncio, json
from app.config_store import get_config
c = asyncio.run(get_config())
print(json.dumps({k: c[k] for k in (\"providers\", \"agent_models\") if k in c}, ensure_ascii=False))"
' > /tmp/agent_config.json
```

Inspect `/tmp/agent_config.json`, then either:
- paste it into the Makers console as `AGENT_CONFIG_JSON`, or
- push it via CLI: `npx edgeone makers env set AGENT_CONFIG_JSON "$(cat /tmp/agent_config.json)"`

### 3.3 Set required env vars

```bash
cp .env.example .env
# Edit .env, then:
npx edgeone makers env set PROXY_API_KEY "$(grep PROXY_API_KEY .env | cut -d= -f2-)"
npx edgeone makers env set AGENT_CONFIG_JSON "$(cat /tmp/agent_config.json)"
npx edgeone makers env set UPSTREAM_TIMEOUT_MS 90000
npx edgeone makers env set EDGEONE_FALLBACK_URL https://agent-long.<your-domain>/v1/chat/completions
```

`PROXY_API_KEY` should be the same token the VM uses (or a new one if you prefer — agents on the VM that point at the new EdgeOne URL will use whichever token you give them).

### 3.4 (Optional) Bind the KV namespace

If you want runtime config updates without redeploying, bind a KV namespace called `agent_kv` and write your config to key `config`. The function reads KV first, falls back to env. See the EdgeOne console: Project → Storage → KV → Create Namespace → Bind Project.

## 4. First deploy

```bash
# Local dev (optional)
npx edgeone makers dev
# → http://localhost:8088  (Edge + Cloud Functions together)

# Deploy to preview environment
npx edgeone makers deploy -e preview
# → returns a preview URL

# Smoke-test the preview
EDGEONE_BASE_URL=https://<preview>.edgeone.app \
PROXY_API_KEY=<your token> \
  bash scripts/smoke-test.sh
```

When smoke tests pass, deploy to production:

```bash
npx edgeone makers deploy
```

## 5. **CRITICAL**: verify IP diversity before going to production

The whole strategy depends on EdgeOne actually egressing from many different source IPs. Verify with the dedicated script.

### 5.1 Deploy a tiny test function

Save this as `edge-functions/check-ip.js` (or use the live deployment with a body that triggers `fetch('https://api.ipify.org')`).

```js
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
```

### 5.2 Run the check

```bash
EDGEONE_TEST_URL=https://<your-edge-app>.edgeone.app/check-ip \
  bash scripts/check-ip-diversity.sh
```

Expected: 50 requests → at least 10 unique egress IPs (ideally 30+).

**If the script reports < 10 unique IPs**, the strategy is invalid for your account/region. Fall back to the VM relay or contact Tencent Cloud support to confirm egress behaviour.

## 6. Wire up the fallback (long-context)

The Cloud Function path is for bodies 1–6 MB. It runs in a Tencent Cloud data center, so its egress IP is a much smaller pool. Use it as a fallback, not as the main path.

In the EdgeOne console:
1. Go to your project → Cloud Functions
2. Make sure `cloud-functions/v1.py` and `cloud-functions/health.py` are deployed (they are if you ran `npx edgeone makers deploy`)
3. The routes are:
   - `POST /v1/chat/completions` → Cloud Function (Python)
   - `GET /v1/models` → Cloud Function (Python)
   - `GET /health` → Cloud Function (Python)

Set `EDGEONE_FALLBACK_URL` to the Cloud Function URL (or to the VM's URL if you prefer VM as the long-context fallback).

## 7. Wire up the agent clients

In each agent that was hitting the VM's `https://<vm-domain>/v1/chat/completions`, point it at the new EdgeOne URL:

```python
# Before
client = OpenAI(api_key=PROXY_KEY, base_url="https://vm.<your-domain>/v1")

# After
client = OpenAI(api_key=PROXY_KEY, base_url="https://agent.<your-domain>/v1")
```

### 7.1 Recommended: client-side body size pre-check

Edge Function returns 413 with `X-Fallback-Endpoint` when body > 1 MB. The recommended pattern for clients:

```python
def chat_with_fallback(messages, model):
    body = json.dumps({"model": model, "messages": messages, "stream": True}).encode()
    url = "https://agent.<your-domain>/v1/chat/completions"
    if len(body) > 900_000:  # leave 100KB headroom
        url = FALLBACK_URL  # the long-context endpoint
    return httpx.post(url, content=body, headers={"authorization": f"Bearer {PROXY_KEY}"})
```

## 8. Verify in production

- `scripts/check-ip-diversity.sh` once a day for the first week, then weekly
- `scripts/smoke-test.sh` after every deploy
- Makers console → Functions → Logs to see real-time per-request logs
- Watch the upstream LLM provider's dashboard for 429 rate — should drop dramatically vs VM

## 9. Roll back

If something goes wrong, just point the agents back at the VM:

```python
client = OpenAI(api_key=PROXY_KEY, base_url="https://vm.<your-domain>/v1")
```

The EdgeOne deployment stays alive but unused; tear it down with `npx edgeone makers delete <project>` when you're confident.

## 10. Operational notes

- **No scheduler state**: this is by design (see FEASIBILITY-REPORT.md §3.3). Edge node + Key pool = natural IP diversity. If a particular key gets 429, the client retries — that retry may land on a different edge node with a different IP.
- **No admin panel**: the VM retains the admin panel. Future enhancement: a "sync config to EdgeOne KV" button in the VM admin panel.
- **No metrics pipeline**: the Edge Function does set `X-Edgeone-*` debug headers (`Routed-Via`, `Trace-Id`, `Relay-Latency-Ms`, `Client-Ip`). Set up a Cloud Function log shipper to Tencent CLS if you want dashboards.
- **Cold starts**: V8 is millisecond-level; Cloud Function Python is hundred-millisecond-level. First request after idle may feel slow. EdgeOne does pre-warming to mitigate.

## 11. Limitations & known issues

- **1 MB body cap** on V8 (per Edge Function limit). Long-context (>1 MB) goes through the Python fallback.
- **No per-key state**: a single bad key in a model gets no cooldown. If a provider fails for an extended period, rotate keys manually by editing `AGENT_CONFIG_JSON`.
- **State visible only in logs**: there's no admin UI on the EdgeOne side. All ops go through the VM admin or the Makers console.
- **KV is Edge Function only**: if you want config from KV, deploy to Edge Function. The Python Cloud Function reads env only.
- **Egress IP not guaranteed diverse**: see §5 — this must be verified per deployment.

## 12. Reference

- [FEASIBILITY-REPORT.md](./FEASIBILITY-REPORT.md) — the deep analysis this code is based on
- [EdgeOne Makers 文档](https://cloud.tencent.com/document/product/1552/127366)
- [EdgeOne CLI 文档](https://cloud.tencent.com/document/product/1552/127423)
- [Edge Functions 详细文档](https://cloud.tencent.com/document/product/1552/127416)
- [Cloud Functions (Python) 详细文档](https://edgeone.ai/document/205713904659333120)
- [KV 存储](https://edgeone.ai/document/162227803822321664)
- VM-side scheduler (for the Agent→KB behaviour reference): `../vm-app/app/scheduler.py`
