# Google Find Hub bridge contract

Pinkeva's public backend does not impersonate an official Google accessory API.
Google does not publish a general-purpose Find Hub report API, so Google-tag
location retrieval is isolated behind a separately deployed service configured
with `PINQEVA_GOOGLE_FINDHUB_BRIDGE_URL` and
`PINQEVA_GOOGLE_FINDHUB_BRIDGE_TOKEN`.

The development protocol was checked against
[`leonboe1/GoogleFindMyTools`](https://github.com/leonboe1/GoogleFindMyTools) at
commit `d46e9528578015b51d3b84dd91bf8f16e9ab850f`. The executable reference
implementation is in [`google-findhub-bridge`](../google-findhub-bridge). That
project is GPL-3.0 and experimental; keep any derived
bridge as an independently licensed/deployed service rather than copying its
code into the Pinkeva backend. Commercial use still requires Google's partner
onboarding, Fast Pair/Find Hub Network conformance, unwanted-tracking behavior,
ring support, certification, and current legal review.

## Required endpoints

Both endpoints require `Authorization: Bearer <service token>`, HTTPS outside
loopback development, strict JSON parsing, bounded request bodies, and no key or
coordinate logging.

### `POST /v1/registrations`

The request contains version `1`, Pinkeva device UUID and serial, the 32-byte
Google EIK in unpadded base64url, the SHA-256 fingerprint of the static 20-byte
counter-zero EID, and an RFC 3339 request time. The bridge must:

1. derive the counter-zero EID from the supplied EIK and reject a fingerprint
   mismatch;
2. idempotently locate or register that exact EIK in the dedicated Google
   account; and
3. upload future 10-byte truncated-EID slots in one account-wide background
   operation every three days, before the development tool's four-day horizon.

The reference service refuses a different upstream revision or a checkout with
modified tracked files and must run as one process per dedicated Google account.

It returns exactly one of:

```json
{"status":"current"}
{"status":"registered"}
{"status":"refreshed"}
```

This refresh is entirely server-side. The ESP32 continues advertising the same
stored EID and does not need a recurring BLE write or any subscription state.
The private upstream upload does not expose a useful acknowledgement payload,
so live monitoring and periodic report probes are still required.

### `POST /v1/reports`

The identity fields are the same and the request additionally includes
`lookback_hours` from 1 through 720. The bridge locates the exact registered
EIK, requests/decrypts its reports, and returns only:

```json
{
  "reports": [
    {
      "latitude": 38.7223,
      "longitude": -9.1393,
      "confidence": 4,
      "status": 1,
      "timestamp": "2026-08-29T12:00:00Z",
      "source_fingerprint_base64url": "<optional 32-byte digest>"
    }
  ]
}
```

The Pinkeva client rejects extra fields, invalid numeric types/ranges, naive
timestamps, oversized lists, and reports outside the requested time window. It
deduplicates overlapping polls and stores accepted points against the active
owner, provisioning session, and Google provider identity. The public location
projection compares those points with independently fetched Apple points and
uses the newest valid provider timestamp.

## Live-test prerequisites

A contract test can prove Pinkeva's request/validation logic, but a live Google
test additionally needs a dedicated Google account whose offline Find Hub
network and encryption state have already been initialized on Android, bridge
authentication secrets obtained by its supported browser flow, and a real
advertisement observed by contributor devices. Without those external
credentials and hardware observations, the Google branch fails closed. The
overall dual-provider request may still return independently valid Apple reports;
it returns `LOCATION_UNAVAILABLE` only when neither configured provider yields a
usable report.
