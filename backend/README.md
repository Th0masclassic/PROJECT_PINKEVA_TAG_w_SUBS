# Pinqeva provisioning backend

This service implements the payment-gated key lifecycle and signed firmware
release portion of protocol v1.6:

1. The authenticated app connects to a selected tag and reads its serial, empty-key fingerprint, and fresh 32-byte challenge. The serial must already be registered in `public.device` with a matching `public.device_bootstrap_credential`; development firmware bypasses the tag-side HMAC check, but it does not create or bypass the backend device record.
2. `POST /v1/provisioning/requests` verifies the encrypted per-device factory credential and creates a database-only request. It returns no key material and expires after 45 minutes.
3. The app shows the server-provided plan prices, opens Stripe Checkout, and polls the request status. A signed, idempotent Stripe webhook is the only event that changes the request to `paid`.
4. Only after payment does `POST /v1/devices/claim` lock the device and either resume the exact allocation or generate one P-224 key pair with the operating-system CSPRNG. Paid requests have a bounded claim deadline.
5. The app writes the authorization proof before the one-time tag-control key and advertisement key. Firmware disconnects invalid clients and times out connections that never authorize.
6. The app reads the tag's 32-byte key fingerprint. `POST /v1/devices/claim/complete` checks it plus a user/session/device-bound capability before creating the one active ownership row.
7. For a new paid claim, the app immediately requests and installs the signed entitlement over the same BLE connection; existing owners use the same endpoint for renewals.
8. Release is also two-phase and requires a fresh connection proof before the authenticated reset command.

## Run locally

Apply the Supabase migrations, copy `.env.example` to `.env` in a local secret manager/shell, install the package, and start:

```bash
python -m pip install -e '.[test]'
python -m app.server
```

The launcher uses Uvicorn's normal event loop on Unix and a Selector event loop
on Windows so Psycopg's async pool works on Python 3.14.

On Windows, `./run_local.ps1` starts the pinned local Supabase CLI stack when
`.env` points to port 54322, starts or reuses the
`dadoum/anisette-v3-server` Docker container, verifies its v1 headers, and then
starts Uvicorn with `.env`:

```powershell
cd C:\Users\tomas\Documents\PINKEVA\backend
.\run_local.ps1
```

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

The backend verifies active ownership, loads the matching `provisioning_session`,
decrypts the P-224 private scalar with `PINQEVA_KEY_ENCRYPTION_KEY`, and sends
only that session's advertisement-key hash to Apple's report service. The
private scalar, hash, Apple payload, and search-party token never leave the
backend. The response contains only the latest safe coordinate projection; a
newer report is persisted to `device.last_latitude`, `last_longitude`,
`last_location_at`, and `last_place`.

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

`report_status` is `updated` for a newly accepted Apple report,
`unchanged` when the stored report is newer, and `no_report` when Apple has
no usable report; the latter returns the last stored coordinates, or `null`
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
non-interactive testing, but they cannot be refreshed automatically. The local
Anisette service must be running at `PINQEVA_FINDMY_ANISETTE_URL` (default
`http://127.0.0.1:6969`) before login or report retrieval. If no Find My
credentials are configured, provisioning still starts and location requests
fail safely without fabricated coordinates.

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
  "tag_advertisement_key_sha256_base64url": null
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
  "tag_advertisement_key_sha256_base64url": null
}
```

`null` means the encrypted fingerprint characteristic reports 32 zero bytes. If the tag already contains a key, the app sends its fingerprint instead. The response includes `tag_authorization_proof_base64url` plus either `write_key` or `verify_existing_key`. The proof is valid only for that device's current challenge. A retry always returns the original allocation; it does not generate another key.

After the tag reports `0x04 0x00` and its fingerprint matches, complete the claim:

```http
POST /v1/devices/claim/complete
Authorization: Bearer <Supabase access token>
Content-Type: application/json

{
  "session_id": "<session uuid>",
  "serial_number": "PKV-AABBCCDDEEFF",
  "tag_advertisement_key_sha256_base64url": "<value read back from the tag>",
  "claim_completion_token_base64url": "<capability from claim-start response>"
}
```

Retries with the same session return the same ownership result. A deadline never causes automatic regeneration: an ambiguous/expired allocation fails closed to recovery.

## Release and transfer

One device can have only one active owner. Transfer rotates the finder key; the old key is never reassigned to the next account.

Subscriptions are also device-scoped: one account may pay for multiple tags, but each tag can have at most one current/nonterminal subscription. `subscription.user_id` identifies the payer/owner account; it is not an account-wide entitlement. Cancelled and ended records are retained as history.

1. The current owner connects to the exact tag and reads its fingerprint.
2. `POST /v1/devices/{device_id}/release` verifies active ownership and the fingerprint, then returns a nonce plus HMAC reset command.
3. The tag verifies that HMAC using the control key installed during its original claim, erases both NVS keys, reports an empty fingerprint, and clears BLE bonds on disconnect.
4. `POST /v1/devices/{device_id}/release/complete` atomically ends ownership, revokes the old allocation, clears the device binding, cancels local subscriptions, and creates idempotent payment-provider cancellation outbox rows.
5. Only then may another authenticated account claim the empty tag, creating an entirely new P-224 key pair and tag-control key.

The outbox is not the payment-provider API. A production worker must process it and the signed provider webhook must confirm that external billing stopped.

## Signed tag activation

After a tag is claimed, the owner can request a signed entitlement only while
that device has an active or trialing subscription:

```http
POST /v1/devices/{device_id}/entitlements
Authorization: Bearer <Supabase access token>
Content-Type: application/json

{"serial_number":"PKV-AABBCCDDEEFF","tag_challenge_base64url":"<fresh tag challenge>"}
```

The response contains a 135-byte device-bound P-256 entitlement, the
challenge-bound authorization proof, its expiry, and an anti-rollback counter.
The mobile client writes the proof and entitlement to the suspended tag. The
firmware rejects missing, invalid, mismatched, expired, or replayed leases and
only then enables finder-network advertising. The backend signer is configured
with `PINQEVA_ENTITLEMENT_PRIVATE_KEY`; the matching public key is embedded in
the firmware.

Issuance creates or updates a `device_entitlement_sync` row for the exact
subscription period and packet digest. After writing, the mobile client reads
the complete packet back from the ESP32 and acknowledges it with:

```http
POST /v1/devices/{device_id}/entitlements/acknowledge
Authorization: Bearer <Supabase access token>
Content-Type: application/json

{"counter":12,"expires_at":"2026-09-26T12:00:00Z","packet_sha256_base64url":"<SHA-256>"}
```

Only an exact current counter, period, digest, owner, and device transition the
row from `issued` to `installed`. This lets operators distinguish “Stripe paid”
from “the physical tag has the new date.”

## Signed firmware releases

The firmware screen is backed by authenticated, owner-scoped endpoints rather
than a client-side version constant:

```http
GET  /v1/devices/{device_id}/firmware
POST /v1/devices/{device_id}/firmware/session
GET  /v1/devices/{device_id}/firmware/image?version=0.3.0
POST /v1/devices/{device_id}/firmware/acknowledge
```

Configure one release by setting both `PINQEVA_FIRMWARE_IMAGE_PATH` and
`PINQEVA_FIRMWARE_VERSION`. The path must point to the classic-ESP32
application binary and the version must be `major.minor.patch`, with every
component in `0..255`. Leaving both values empty disables update publication.
The configured image is loaded at startup, checked for the ESP image marker and
896 KiB slot limit, hashed, and bound into a fixed manifest signed with
`PINQEVA_ENTITLEMENT_PRIVATE_KEY`. That key's P-256 public half is embedded in
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
or private key before the request is paid. Existing owned tags continue to use
the per-tag subscription endpoints below; after a successful webhook, a new
claim installs the signed entitlement during the same BLE session, while an
existing owner reconnects to renew it.

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
ownership ended while Stripe created a subscription, local entitlement is
stopped immediately in the webhook transaction and a durable outbox requests
immediate cancellation without proration or a final invoice; only a later
provider-terminal signed webhook confirms that cancellation.

Recurring renewal does not depend on the mobile app. On `invoice.paid`, the
handler retrieves both the authoritative invoice and subscription and applies
the advanced period atomically before storing the invoice, even if
`customer.subscription.updated` arrives later. The subscription trigger then
queues a new pending physical-tag delivery period. No backend can update an
offline BLE tag directly, so the owner still needs one fresh, button-opened BLE
session to install that renewed date.

The background notification worker creates idempotent inbox/outbox rows seven
days before the period end, one day before it, at expiry, and when a new tag
entitlement remains uninstalled for ten minutes. Native clients register Expo
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
