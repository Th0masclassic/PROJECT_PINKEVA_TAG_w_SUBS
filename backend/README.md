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

The API deliberately disables interactive documentation in its production app object. Generate a separate internal OpenAPI artifact during deployment if operators need it.

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

1. The current owner connects to the exact tag and reads its fingerprint.
2. `POST /v1/devices/{device_id}/release` verifies active ownership and the fingerprint, then returns a nonce plus HMAC reset command.
3. The tag verifies that HMAC using the control key installed during its original claim, erases both NVS keys, reports an empty fingerprint, and clears BLE bonds on disconnect.
4. `POST /v1/devices/{device_id}/release/complete` atomically ends ownership, revokes the old allocation, clears the device binding, cancels local subscriptions, and creates idempotent payment-provider cancellation outbox rows.
5. Only then may another authenticated account claim the empty tag, creating an entirely new P-224 key pair and tag-control key.

The outbox is not the payment-provider API. A production worker must process it and the signed provider webhook must confirm that external billing stopped.

## Secret handling

- `PINQEVA_KEY_ENCRYPTION_KEY` is a development envelope key. Production should replace it with a KMS/HSM-backed data-key flow and retain a key version for rotation.
- `PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY` protects backend copies of per-device factory bootstrap keys and must be independent from every other root.
- `PINQEVA_CLAIM_TOKEN_KEY` is an independent HMAC root for completion capabilities and per-allocation tag-control keys.
- The database stores an encrypted per-device bootstrap key, a full public P-224 point, the 28-byte advertisement X coordinate, its hash, and an encrypted private scalar. Direct Data API access to both credential tables is revoked.
- Logs and error payloads must never contain bootstrap keys, authorization proofs, bearer tokens, BLE key bytes, private scalars, database URLs, or ciphertext.
- `tools/register_device.py` creates the database record and emits the private `boot_key` payload for controlled NVS injection. That output is manufacturing material, not a customer QR code.

## Important boundary

The backend cannot communicate with BLE hardware. The authenticated mobile app is the controlled bridge from HTTPS to the ESP32. The companion `app-client` module implements that bridge and verifies the tag before completing the backend claim.
