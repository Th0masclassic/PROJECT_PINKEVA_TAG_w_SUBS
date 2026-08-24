# Pinqeva provisioning backend

This service implements the key-lifecycle portion of protocol v1.2:

1. The authenticated app connects to a selected tag and reads its serial plus a fresh 32-byte challenge.
2. `POST /v1/devices/claim` uses the encrypted per-device factory credential to return a challenge-bound authorization proof. The reusable bootstrap key remains only on the tag and backend.
3. The endpoint locks the device row and either resumes its existing allocation or, only when both backend and tag report empty, generates one P-224 key pair with the operating-system CSPRNG.
4. The app writes the authorization proof before the one-time tag-control key and advertisement key. Firmware disconnects invalid clients and times out connections that never authorize.
5. The app reads the tag's 32-byte key fingerprint. `POST /v1/devices/claim/complete` checks it plus a user/session/device-bound capability before creating the one active ownership row.
6. Release is also two-phase and requires a fresh connection proof before the authenticated reset command.

## Run locally

Apply the Supabase migrations, copy `.env.example` to `.env` in a local secret manager/shell, install the package, and start:

```bash
python -m pip install -e '.[test]'
uvicorn app.main:app --host 127.0.0.1 --port 8080
```

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

## Provisioning API

Start or resume a claim:

```http
POST /v1/devices/claim
Authorization: Bearer <Supabase access token>
Idempotency-Key: provision:<client-generated-uuid>
Content-Type: application/json

{
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

## Per-tag Stripe subscriptions

Billing is attached to a physical tag, not to an account-wide entitlement. A
single account has one Stripe Customer and may own several subscriptions, but
the database and Checkout reservation table allow only one current
subscription or payable Checkout flow per tag.

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
