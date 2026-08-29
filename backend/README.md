# Pinqeva provisioning backend

This service implements the payment-gated dual-network identity lifecycle and
signed firmware release portion of protocol v1.7:

1. The authenticated app connects to a selected tag and reads its serial, empty-key fingerprint, and fresh 32-byte challenge. The serial must already be registered in `public.device` with a matching `public.device_bootstrap_credential`; development firmware bypasses the tag-side HMAC check, but it does not create or bypass the backend device record.
2. `POST /v1/provisioning/requests` verifies the encrypted per-device factory credential and creates a database-only request. It returns no key material and expires after 45 minutes.
3. The app shows the server-provided plan prices, opens Stripe Checkout, and polls the request status. A signed, idempotent Stripe webhook is the only event that changes the request to `paid`.
4. Only after payment does `POST /v1/devices/claim` lock the device and either resume the exact allocation or generate Apple P-224 and Google EIK/EID material with the operating-system CSPRNG. Paid requests have a bounded claim deadline.
5. The app writes the authorization proof before the one-time control key, both public advertising identities, and the write-once network selector. Firmware disconnects invalid clients and times out connections that never authorize.
6. The app reads both 32-byte fingerprints and the selector. `POST /v1/devices/claim/complete` checks the complete binding plus a user/session/device-bound capability before creating the one active ownership row.
7. Claim completion returns `status: claimed` and `next_action: ready`. The selected finder identity is sufficient for tracker operation; renewals never install billing state over BLE.
8. Release is also two-phase and requires a fresh connection proof before the authenticated reset command.

## Run locally

Apply the Supabase migrations, copy `.env.example` to `.env` in a local secret manager/shell, install the package, and start:

```bash
python -m pip install -e '.[test]'
python -m app.server
```

The launcher uses Uvicorn's normal event loop on Unix and a Selector event loop
on Windows so Psycopg's async pool works on Python 3.14.

On the Windows RDC server, keep the already-working Anisette executable as a
separately managed loopback service. The backend does not spawn or replace it:

```powershell
# backend/.env
# PINQEVA_FINDMY_ANISETTE_PROVIDER=http
# PINQEVA_FINDMY_ANISETTE_URL=http://127.0.0.1:6969
python -m app.server
```

Embedded `native` mode remains available on Windows when no external executable
is used. Configure a durable absolute state path; the first start downloads
Apple's Android Apple Music package, provisions one virtual device, and saves it:

```powershell
cd C:\Users\tomas\Documents\PINKEVA\backend
# Add these deployment-specific values to the ignored backend/.env:
# PINQEVA_FINDMY_ANISETTE_PROVIDER=native
# PINQEVA_FINDMY_ANISETTE_STATE_PATH=C:\ProgramData\PINKEVA\anisette-state.bin
# PINQEVA_FINDMY_ANISETTE_URL=http://127.0.0.1:6970
.\run_local.ps1
```

Keep the generated state file private and backed up; replacing it creates a new
Anisette device that must be provisioned again. For Linux/Docker, the checked-in
`backend/Dockerfile` defaults to embedded `native` mode and stores that state at
`/var/lib/pinqeva/anisette-state.bin`. Mount `/var/lib/pinqeva` as a durable
volume. `http` mode is still supported for a separately managed HTTPS service or
a loopback sidecar. In both modes the same backend Apple-login code consumes the
HTTP header contract; only ownership of the Anisette process changes.

On the configured development Mac, `./run_local_secure.sh` loads application
settings from the ignored `backend/.env`, keeps the hosted database password in
macOS Keychain, and starts the same server against Supabase cloud. It is a
development convenience only; production must use the deployment platform's
secret manager. The checked-in development firmware bypasses bootstrap proof
verification; to test that firmware, set
`PINQEVA_DEV_BYPASS_BOOTSTRAP_AUTH=true` in the ignored local `.env`. This
keeps the setting opt-in and must remain false for shared or production servers.

For a hosted project, follow
[`docs/supabase-cloud-deployment.md`](../docs/supabase-cloud-deployment.md).
The hosted database URL must use TLS and must never be placed in Expo/Xcode.
`SUPABASE_URL` is enough for the backend to derive the public JWT issuer and
JWKS endpoints.

The API deliberately disables interactive documentation in its production app object. Generate a separate internal OpenAPI artifact during deployment if operators need it.

All public error responses contain a stable code, a short safe message, and a
correlation ID. Validation input, access tokens, keys, database errors, and
stack traces are never returned to the client. Server logs record only the
correlation ID and exception type for unexpected failures.

## Administrator bootstrap and integrity

The administrator API is backend-only under `/v1/admin`. Authentication uses a
normal Supabase email/password account and public JWT verification; authorization
uses the environment-owned recovery UUID or an active database role assignment.
Privileged data requires TOTP/AAL2 by default, and mutations are written to the
append-only `admin_audit_log`.

Create the first account once from an operator shell with a temporary Supabase
server secret. Never place that secret in the backend `.env` or application
runtime:

```powershell
$env:SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
$env:SUPABASE_SECRET_KEY = "sb_secret_REPLACE"
$env:DATABASE_URL = "postgresql://ADMIN_CONNECTION_WITH_TLS"
python backend/tools/bootstrap_admin.py `
  --email admin-pinkeva@pinkeva.com `
  --username admin-pinkeva
Remove-Item Env:SUPABASE_SECRET_KEY
```

The tool generates and displays the temporary password exactly once, confirms
the email through the supported Supabase Auth Admin API, verifies the profile
trigger, and prints the UUID for `PINQEVA_ADMIN_OWNER_USER_IDS`. Put that UUID in
the backend secret manager, enroll TOTP on first sign-in, then rotate the
temporary password. The server rejects the all-zero example owner UUID.

`GET /v1/admin/system/integrity` provides a non-sensitive, AAL2-protected view of
cross-table invariants: owner profiles, factory credentials, ownership/device
state, active subscriptions, cancellation failures, and overdue provisioning.
It returns `healthy` only when every checked count is zero.

## Location reports

The checked-in `Test/Apple_FindMy_test/request_reports.py` is the vendored
[`biemster/FindMy`](https://github.com/biemster/FindMy) utility and reads local
`.keys` files. The mobile API adapts that protocol in `backend/app/findmy.py`:
the same hashed advertisement-key ID, millisecond search window, Anisette
headers, HTTP Basic session credentials, P-224 ECDH derivation, SHA-256 split,
and AES-GCM payload decoding are used without local key files or SQLite. When
the authenticated app opens Home, Map, Trackers, or a tracker detail page it
calls:

```http
POST /v1/devices/{device_id}/location/report
Authorization: Bearer <Supabase access token>
```

The backend verifies active ownership and routes the request using
`device.finding_network`. Apple-selected tags use the encrypted P-224 scalar and
Apple report provider. Google-selected tags use the encrypted 32-byte Find Hub
identity key and a separately deployed provider bridge configured by
`PINQEVA_GOOGLE_FINDHUB_BRIDGE_URL` and
`PINQEVA_GOOGLE_FINDHUB_BRIDGE_TOKEN`. There is deliberately no Apple fallback
for a Google tag. Google does not publish a general report API, so that bridge
must be supplied through an approved production integration; loopback is also
supported for development testing. In both cases the public API returns only
the safe coordinate projection and persists newer accepted reports.

The server logs `location_report_request_received`,
`findmy_request_reports_received`, and `location_report_request_completed`
with correlation/user/device IDs and report counts/status. Coordinates,
private keys, Apple payloads, passwords, 2FA codes, and session tokens are not
logged.

For example, an authenticated request for one owned tag is:

```bash
curl -X POST \
  -H "Authorization: Bearer <Supabase access token>" \
  "https://YOUR_API_HOST/v1/devices/<device UUID>/location/report"
```

When Apple returns a valid report, the JSON projection is shaped like this:

```json
{
  "device_id": "<device UUID>",
  "serial_number": "PKV-AABBCCDDEEFF",
  "report_status": "updated",
  "latitude": 3.87223,
  "longitude": -0.91393,
  "last_location_at": "2026-08-25T12:00:00Z",
  "last_place": "3.87223, -0.91393",
  "confidence": 3,
  "status_code": 1
}
```

`report_status` is `updated` for a newly accepted finder report,
`unchanged` when the stored report is newer, and `no_report` when the selected
provider has no usable report; the latter returns the last stored coordinates, or `null`
coordinates if the tag has never reported. A caller that does not actively own
the UUID receives a safe 404 response and no coordinates.

At startup, configure `PINQEVA_FINDMY_APPLE_ID` and either provide
`PINQEVA_FINDMY_APPLE_PASSWORD` through the secret manager or leave it blank
for a hidden terminal prompt. The backend performs the Apple GSA/SRP login,
prompts for the configured SMS or trusted-device 2FA code, and keeps the
resulting `dsid` and `searchPartyToken` only in memory. If the report endpoint
returns an authentication failure, the backend performs one fresh login and
retries that report request. A future automated SMS provider can replace the
2FA code callback without changing the location API.

`PINQEVA_FINDMY_AUTH_FILE` remains a fallback for a previously obtained
`{"dsid":"...","searchPartyToken":"..."}` session when Apple ID login is
not enabled. Direct `PINQEVA_FINDMY_DSID` and
`PINQEVA_FINDMY_SEARCH_PARTY_TOKEN` values are also supported for controlled
non-interactive testing, but they cannot be refreshed automatically. Set
`PINQEVA_FINDMY_ANISETTE_PROVIDER=native` with a durable
`PINQEVA_FINDMY_ANISETTE_STATE_PATH` to provision an embedded provider before
Apple login begins. Set the provider to `http` to use a separately managed
service at `PINQEVA_FINDMY_ANISETTE_URL` (default
`http://127.0.0.1:6969`). If no Find My credentials are configured, the API
still starts and location requests fail safely without fabricated coordinates.

The upstream utility disables certificate verification for Apple's legacy GSA
endpoint. The backend keeps verification enabled and trusts Apple's published
legacy `Apple Root CA` for that endpoint; normal platform roots are still used
for `setup.icloud.com` and `gateway.icloud.com`.

## Provisioning API

Before testing a physical tag, register its exact `PKV-XXXXXXXXXXXX` serial once
through the admin console or the controlled manufacturing helper:

```bash
python backend/tools/register_device.py PKV-AABBCCDDEEFF --name "Development tag"
```

Do not run that command for a serial that is already registered. If an older
prototype row exists without a bootstrap credential, repair/register it through
the administrator workflow instead of inserting a second device row. A missing
row, missing credential, or envelope encrypted with a different persistent
`PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY` all intentionally return the same safe
client error: `DEVICE_AUTHORIZATION_REJECTED`.

Create the payment gate before allocating a key:

```http
POST /v1/provisioning/requests
Authorization: Bearer <Supabase access token>
Idempotency-Key: request:<client-generated-uuid>
Content-Type: application/json

{
  "serial_number": "PKV-AABBCCDDEEFF",
  "tag_challenge_base64url": "<32-byte challenge read from the tag>",
  "tag_advertisement_key_sha256_base64url": null,
  "tag_google_advertisement_key_sha256_base64url": null,
  "tag_finding_network": null
}
```

The response contains the short-lived `request_id`, `expires_at`, and the
server-validated `available_plans` including amount, currency, and billing
interval. Open the selected plan with:

```http
POST /v1/provisioning/requests/<request_id>/checkout
Authorization: Bearer <Supabase access token>
Content-Type: application/json

{"plan_code":"monthly_basic"}
```

After Stripe Checkout returns, poll
`GET /v1/provisioning/requests/<request_id>` until `paid` or `claiming`.
The status endpoint is intentionally cheap and does not contact Stripe on
every poll. The signed Stripe webhook remains authoritative; a late payment
for an expired request is ended locally and queued for provider cancellation.

Only then start or resume the claim:

```http
POST /v1/devices/claim
Authorization: Bearer <Supabase access token>
Idempotency-Key: provision:<client-generated-uuid>
Content-Type: application/json

{
  "provisioning_request_id": "<paid request uuid>",
  "serial_number": "PKV-AABBCCDDEEFF",
  "tag_challenge_base64url": "<32-byte challenge read from the tag>",
  "tag_advertisement_key_sha256_base64url": null,
  "tag_google_advertisement_key_sha256_base64url": null,
  "finding_network": "google",
  "tag_finding_network": null
}
```

`null` means the corresponding fingerprint or network characteristic is empty.
The backend allocates both the 28-byte Apple advertisement key and 20-byte
Google EID once, then binds the selected network. Android selects Google and
iOS selects Apple. The tag stores both identities but advertises only the one
selected network. A retry always returns the original allocation; it never
generates replacement material.

After the tag reports `0x04 0x00` and its fingerprint matches, complete the claim:

```http
POST /v1/devices/claim/complete
Authorization: Bearer <Supabase access token>
Content-Type: application/json

{
  "session_id": "<session uuid>",
  "serial_number": "PKV-AABBCCDDEEFF",
  "tag_advertisement_key_sha256_base64url": "<value read back from the tag>",
  "tag_google_advertisement_key_sha256_base64url": "<Google value read back from the tag>",
  "finding_network": "google",
  "claim_completion_token_base64url": "<capability from claim-start response>"
}
```

Retries with the same session return the same ownership result. A deadline never causes automatic regeneration: an ambiguous/expired allocation fails closed to recovery.

## Release and transfer

One device can have only one active owner. Transfer rotates the finder key; the old key is never reassigned to the next account.

Subscriptions are also device-scoped: one account may pay for multiple tags, but each tag can have at most one current/nonterminal subscription. `subscription.user_id` identifies the payer/owner account; it is not an account-wide entitlement. Cancelled and ended records are retained as history.

1. The current owner connects to the exact tag and reads both fingerprints and the selected network.
2. `POST /v1/devices/{device_id}/release` verifies active ownership and the complete dual-network binding, then returns a nonce plus HMAC reset command.
3. The tag verifies that HMAC using the control key installed during its original claim, erases both finder identities, network selection, and control key, reports all three public values empty, and clears BLE bonds on disconnect.
4. `POST /v1/devices/{device_id}/release/complete` atomically ends ownership, revokes the old allocation, clears the device binding, cancels local subscriptions, and creates idempotent payment-provider cancellation outbox rows.
5. Only then may another authenticated account claim the empty tag, creating entirely new Apple and Google identities plus a tag-control key.

The outbox is not the payment-provider API. A production worker must process it and the signed provider webhook must confirm that external billing stopped.

## Premium tracker services

Active/trialing per-device subscriptions unlock backend-controlled features;
the tag never needs to receive the subscription state:

```text
GET    /v1/devices/{device_id}/premium/features
GET    /v1/devices/{device_id}/premium/overview
POST   /v1/devices/{device_id}/location/history?days=30
DELETE /v1/devices/{device_id}/location/history

GET|POST   /v1/devices/{device_id}/safe-zones
PATCH|DELETE /v1/devices/{device_id}/safe-zones/{safe_zone_id}

GET|PATCH  /v1/devices/{device_id}/protection
GET|DELETE /v1/devices/{device_id}/companion
POST       /v1/devices/{device_id}/companion/observations
GET        /v1/devices/{device_id}/recovery-report
GET|POST   /v1/devices/{device_id}/recovery-shares
DELETE     /v1/devices/{device_id}/recovery-shares/{share_id}
POST       /v1/recovery-shares/resolve
GET        /v1/devices/{device_id}/replacement-eligibility
GET|POST   /v1/devices/{device_id}/replacement-claims
```

Accepted Finder reports are retained for at most 30 days and are bound to the
active owner and provisioning session. Main-phone observations are retained for
at most 24 hours. A database trigger combines the nearest-in-time phone GPS,
finder-network location, and an authenticated BLE-nearby observation. A tag may
remain in any safe zone without an alert; an alert is emitted only when the tag
leaves while the main phone remains there, or their geographic separation
crosses the configured threshold elsewhere. BLE RSSI is never converted into a
distance: a recent nearby observation only suppresses false alerts. Movement and
vehicle alerts use the same owner-close suppression and are idempotent.

Display-dependent lost mode and recovery messages are intentionally absent.
The recovery report instead summarizes location evidence, recent alerts, safe
zones, sharing, companion readiness, and replacement eligibility. Paid active
6- and 12-month plans may submit one zero-price replacement claim per billing
term for a lost or stolen tag; every claim requires an administrator to approve
and mark fulfilment. A trial or a 1/3-month plan is not replacement-eligible.

Recovery share tokens contain 256 bits of randomness, are stored only as SHA-256 hashes,
expire in at most 30 days, and stop resolving if revoked, ownership changes,
the account is banned, or the subscription is no longer current. The web share
keeps the plaintext capability in a URL fragment and resolves it in the POST
body, preventing it from appearing in HTTP paths, access logs, or Referrer
headers. Resolution responses are explicitly non-cacheable.

## Signed firmware releases

The firmware screen is backed by authenticated, owner-scoped endpoints rather
than a client-side version constant:

```http
GET  /v1/devices/{device_id}/firmware
POST /v1/devices/{device_id}/firmware/session
GET  /v1/devices/{device_id}/firmware/image?version=0.4.0
POST /v1/devices/{device_id}/firmware/acknowledge
```

Configure one release by setting both `PINQEVA_FIRMWARE_IMAGE_PATH` and
`PINQEVA_FIRMWARE_VERSION`. The path must point to the classic-ESP32
application binary and the version must be `major.minor.patch`, with every
component in `0..255`. Leaving both values empty disables update publication.
The configured image is loaded at startup, checked for the ESP image marker and
896 KiB slot limit, hashed, and bound into a fixed manifest signed with
`PINQEVA_FIRMWARE_SIGNING_PRIVATE_KEY`. That key's P-256 public half is embedded in
the tracker; neither the signing key nor an unsigned digest reaches the app as
a trust root.

To start an update, the app reads the selected tag's exact serial, current
three-component version, and fresh BLE challenge. The backend verifies active
ownership, device state, serial binding, and the factory authorization
credential before returning a challenge-bound tag proof, signed manifest, and
authenticated image URL. The app verifies the downloaded SHA-256 value and
manifest binding before streaming it over BLE. It acknowledges only after the
tracker reboots and reports the requested version; only then is
`device.firmware_version` advanced. If installation succeeded but that final
request was interrupted, a later session returns `install_required: false` so
the app can verify the already-running version and safely finish the
acknowledgement without reflashing.

No schema migration is needed because `public.device.firmware_version` is the
existing release-delivery record. The initial move from the old single-app
partition layout still requires the wired flash bundle described in the ESP32
README; all subsequent releases can use signed BLE OTA.

## Per-tag Stripe subscriptions

Billing is attached to a physical tag, not to an account-wide entitlement. A
single account has one Stripe Customer and may own several subscriptions, but
the database and Checkout reservation table allow only one current
subscription or payable Checkout flow per tag.

New-tag setup uses the separate `provisioning_request` gate described above.
The mobile client never receives a public key, control key, completion token,
or private key before the request is paid. After a successful webhook, cloud
access is active immediately. New claims finish after key fingerprint
confirmation and existing owners never reconnect merely to renew.

The authenticated mobile contract is:

```http
GET /v1/devices/{device_id}/subscription
POST /v1/devices/{device_id}/subscription/checkout  {"plan_code":"monthly_basic"}
POST /v1/devices/{device_id}/subscription/portal  {"action":"update"}
```

Every endpoint verifies that the caller is the tag's current owner. The client
never sends an amount, Stripe Price ID, customer ID, provider metadata, or
redirect URL. Plan codes are looked up in the active `public.plan` table and
resolved through a server-only catalog binding. Initial bindings come from
`STRIPE_PRICE_MAP_JSON`; later prices created by the admin console are versioned
in the database. Each configured entry
contains both the exact Stripe Price and Product IDs. Before showing a plan or
opening Checkout, the backend retrieves Stripe's catalog and verifies that the
Price and Product are active and that amount, currency, recurring interval, and
licensed usage exactly match `public.plan`. The API supports 1, 3, 6, and
12-month plans. Three and six months use Stripe monthly recurrence with an
interval count; twelve months uses yearly recurrence. Checkout and Customer creation use stable
idempotency keys. The optional portal action is strictly
`update` (the default when the body is omitted) or `cancel`; it starts the
corresponding Stripe `subscription_update` or `subscription_cancel` deep-link
flow for that exact provider subscription. It never falls back to an
account-wide portal homepage, so another tag's subscription is not exposed by
this endpoint. The selected Billing Portal configuration must enable both flows.

Configure a Stripe webhook endpoint at:

```text
POST https://YOUR_API_HOST/v1/billing/stripe/webhook
```

Subscribe it to `checkout.session.completed`, `checkout.session.expired`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, and the invoice lifecycle events used by the
service. Set the webhook endpoint to the same pinned API version as
`STRIPE_API_VERSION`. The handler verifies the signature over the untouched raw
request body before parsing it. `payment_event` stores only the payload digest
and a small allow-listed summary (event type, provider object ID, timestamp,
mode and result), never Stripe's full event payload, address, card or customer
details. Recognized events are reconciled against the current Stripe object, and
provider timestamps plus event IDs make same-second updates deterministic. A
webhook that races the local Checkout binding returns a retryable response. If
ownership ended while Stripe created a subscription, local cloud access is
stopped immediately in the webhook transaction and a durable outbox requests
immediate cancellation without proration or a final invoice; only a later
provider-terminal signed webhook confirms that cancellation.

Recurring renewal does not depend on the mobile app. On `invoice.paid`, the
handler retrieves both the authoritative invoice and subscription and applies
the advanced period atomically before storing the invoice, even if
`customer.subscription.updated` arrives later. The new cloud period is usable
immediately; there is no physical-tag delivery step.

The background notification worker creates idempotent inbox/outbox rows seven
days before the period end, one day before it, at expiry, and for premium
separation/movement events. Native clients register Expo
destinations at `POST /v1/notifications/push-token`; the worker leases due jobs,
uses exponential retry for temporary failures, and disables destinations that
Expo reports as unregistered. `GET /v1/notifications` exposes the durable inbox
independently of push delivery. Set `PINQEVA_NOTIFICATION_WORKER_ENABLED=true`,
configure the poll interval, and set `EXPO_PUSH_ACCESS_TOKEN` when enhanced Expo
push security is enabled.

Dashboard setup still requires an operator to:

1. Create one recurring Stripe Price for each active plan. Store its `prod_...`
   Product ID in `public.plan.provider_product_id` and place the exact
   `{price_id, product_id}` pair under that plan code in the server secret map.
   The database amount, uppercase currency, and 1/3/6/12-month duration
   must exactly match Stripe or billing fails closed.
2. Create a Billing Portal configuration whose update products contain the
   same allowed prices, then set `STRIPE_PORTAL_CONFIGURATION_ID`.
3. Create the webhook endpoint, copy its `whsec_...` signing secret to the
   backend secret manager, and test the full event set in Stripe's sandbox.
4. Configure the fixed HTTPS success/cancel/return universal links.

Do not put `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the database URL, or a
Supabase service-role key in the mobile application. No Stripe credentials are
required to build the app; live billing tests require sandbox Dashboard setup.

### App Store and Play billing policy

Stripe Checkout is appropriate only when the subscription pays for service
whose primary value is tied to the physical tag or another policy-permitted
real-world service. If it unlocks digital features consumed in the iOS or
Android app, Apple and Google may require their in-app purchase systems instead.
This product classification must be confirmed before store submission; the
technical integration does not override either store's current review policy.

## Secret handling

- `PINQEVA_KEY_ENCRYPTION_KEY` is a development envelope key. Production should replace it with a KMS/HSM-backed data-key flow and retain a key version for rotation.
- `PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY` protects backend copies of per-device factory bootstrap keys and must be independent from every other root.
- `PINQEVA_CLAIM_TOKEN_KEY` is an independent HMAC root for completion capabilities and per-allocation tag-control keys.
- The database stores an encrypted per-device bootstrap key, a full public P-224 point, the 28-byte advertisement X coordinate, its hash, and an encrypted private scalar. Direct Data API access to both credential tables is revoked.
- Logs and error payloads must never contain bootstrap keys, authorization proofs, bearer tokens, BLE key bytes, private scalars, database URLs, or ciphertext.
- `tools/register_device.py` creates the database record and emits the private `boot_key` payload for controlled NVS injection. That output is manufacturing material, not a customer QR code.

## Important boundary

The backend cannot communicate with BLE hardware. The authenticated mobile app is the controlled bridge from HTTPS to the ESP32. The companion `app-client` module implements that bridge and verifies the tag before completing the backend claim.
