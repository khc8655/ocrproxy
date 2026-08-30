// Minimal hello-world to test EdgeOne routing.
export default function onRequest(context) {
  return new Response(JSON.stringify({
    message: 'hello from edge function',
    method: context.request.method,
    path: new URL(context.request.url).pathname,
    uuid: context.request.eo?.uuid,
    clientIp: context.request.eo?.clientIp,
  }), { headers: { 'content-type': 'application/json' } });
}
