/**
 * check-ip.js — Deprecated endpoint.
 * Permanently disabled for production security hardening.
 */
export default async function onRequestGet() {
  return new Response(
    JSON.stringify({
      error: {
        type: 'not_found_error',
        message: 'Endpoint /check-ip is deprecated and permanently disabled for security.',
        code: 'endpoint_disabled',
      },
    }),
    {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }
  );
}
