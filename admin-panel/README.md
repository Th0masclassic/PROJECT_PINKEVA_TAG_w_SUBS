# Pinkeva Admin Console

This is a separate browser console for privileged operations. It uses only the
Supabase publishable key in the browser. Every data request goes through the
Pinkeva FastAPI backend, which re-verifies the bearer token, active admin role,
and AAL2/TOTP MFA before reading or changing administrative data.

## Configure and run

1. Copy `.env.example` to `.env` and fill the four public values.
2. Add the exact admin origin to backend `PINQEVA_ADMIN_ALLOWED_ORIGINS`.
3. Add the first Supabase user UUID to backend
   `PINQEVA_ADMIN_OWNER_USER_IDS`. Environment owners alone can grant or revoke
   database admin roles.
4. Run `npm install`, then `npm run dev` or `npm run build`.

Production hosting must add these response headers at the CDN/reverse proxy:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' https://maps.googleapis.com https://maps.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://maps.gstatic.com https://maps.googleapis.com; connect-src 'self' https://YOUR_PROJECT_REF.supabase.co https://YOUR_API_HOST https://maps.googleapis.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Replace the two hosts before deploying. Restrict the Google browser key by the
exact production origins, and restrict it to Maps JavaScript API. Never add a
Supabase secret/service-role key, Stripe secret, database URL, or device key to
this project.

At the edge, allow only the expected methods on `/v1/admin/*`, add conservative
per-IP rate limits, and alert on repeated 401/403/429 responses. Keep the Stripe
webhook path outside browser-origin rules and verify it only with Stripe's
signature in the backend. Administration should use a dedicated HTTPS hostname;
do not expose a development server or a temporary tunnel as the production
console.
