// check-ip.js — IP diversity probe.
//
// Calls an external IP-echo service to find out the EGRESS IP that EdgeOne
// uses when reaching the public internet, plus returns the client IP that
// EdgeOne sees.  Repeated calls from one client will (hopefully) return
// DIFFERENT egress IPs if the user is being routed to different edge nodes.
//
// IMPORTANT: this is a verification tool, not a production endpoint.
// Remove it before going to production, or auth-gate it heavily.
//
// Implementation notes for V8 / EdgeOne Edge Functions:
//   - AbortSignal.timeout() is NOT available in the V8 runtime (Node 18+
//     feature).  We build a race against a setTimeout promise instead.
//   - We rely on EdgeOne's own per-fetch timeout (eo.timeoutSetting) to
//     bail out, but for additional safety we cap individual services at
//     2500 ms.
export default async function onRequestGet(context) {
  const SERVICES = [
    { url: 'https://ifconfig.me/ip', kind: 'text' },
    { url: 'https://api.ipify.org?format=json', kind: 'json', field: 'ip' },
    { url: 'https://checkip.amazonaws.com', kind: 'text' },
    { url: 'https://ifconfig.co/ip', kind: 'text' },
  ];

  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

  let egressIp = null;
  let egressErr = null;
  for (const svc of SERVICES) {
    try {
      const r = await withTimeout(
        fetch(svc.url, { headers: { 'cache-control': 'no-cache' } }),
        2500
      );
      if (!r.ok) continue;
      const txt = (await r.text()).trim();
      if (svc.kind === 'json') {
        const j = JSON.parse(txt);
        egressIp = j[svc.field] || j.ip || null;
      } else {
        egressIp = txt;
      }
      if (egressIp) break;
    } catch (e) {
      egressErr = `${svc.url}: ${e?.message || e}`;
    }
  }

  return new Response(
    JSON.stringify({
      clientIp: context.request.eo?.clientIp,
      nodeUuid: context.request.eo?.uuid,
      egressIp,
      egressErr,
      geo: {
        country: context.request.eo?.geo?.countryCodeAlpha2,
        region: context.request.eo?.geo?.regionCode,
        city: context.request.eo?.geo?.cityName,
      },
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store, max-age=0',
      },
    }
  );
}

