# Pinqeva Google Find Hub development bridge

This is a separately deployable, **experimental GPL-3.0 service** around
[`leonboe1/GoogleFindMyTools`](https://github.com/leonboe1/GoogleFindMyTools),
pinned to commit `d46e9528578015b51d3b84dd91bf8f16e9ab850f`. It implements the two strict
HTTP endpoints consumed by the Pinqeva backend:

- `POST /v1/registrations` registers or finds the exact backend-generated EIK;
- `POST /v1/reports` asks the private Google service for reports and returns only
  normalized coordinates and timestamps.

The bridge refreshes the precomputed static truncated-EID announcements every
three days in one account-wide operation. The ESP32 keeps the same counter-zero
20-byte EID, so neither a BLE key rewrite nor a subscription sync is involved.

This does not make Pinqeva a certified Find Hub accessory. The upstream project
uses reverse-engineered private APIs, says custom ESP32 locations do not appear
in Google's Find Hub app, and can stop working without notice. Google partner
approval, rotating identifiers, anti-stalking behavior, owner sound, and
certification remain required for a commercial claim.

## One-time account preparation

Use a dedicated Google account. On an Android phone, initialize Find Hub and its
end-to-end encryption by pairing at least one supported tracker. Then clone and
authenticate the exact upstream revision on the bridge host:

```powershell
git clone https://github.com/leonboe1/GoogleFindMyTools.git C:\Services\GoogleFindMyTools
git -C C:\Services\GoogleFindMyTools checkout d46e9528578015b51d3b84dd91bf8f16e9ab850f
py -3.12 -m venv C:\Services\GoogleFindMyTools\.venv
C:\Services\GoogleFindMyTools\.venv\Scripts\python.exe -m pip install -r C:\Services\GoogleFindMyTools\requirements.txt
C:\Services\GoogleFindMyTools\.venv\Scripts\python.exe C:\Services\GoogleFindMyTools\main.py
```

Complete the browser sign-in and verify that `Auth/secrets.json` was created.
Never commit that file. The bridge deliberately refuses any upstream revision
other than the pinned full commit.

## Run on Windows

Install this package into the same virtual environment, create a random
service-to-service token, and run exactly one worker process:

```powershell
C:\Services\GoogleFindMyTools\.venv\Scripts\python.exe -m pip install -e C:\path\to\PINKEVA\google-findhub-bridge
$env:PINQEVA_GOOGLE_FINDMYTOOLS_DIR='C:\Services\GoogleFindMyTools'
$env:PINQEVA_GOOGLE_BRIDGE_TOKEN='<at-least-32-random-characters>'
C:\Services\GoogleFindMyTools\.venv\Scripts\python.exe -m pinqeva_google_bridge.server
```

Point the main backend at the loopback service with matching secrets:

```text
PINQEVA_GOOGLE_FINDHUB_BRIDGE_URL=http://127.0.0.1:8788
PINQEVA_GOOGLE_FINDHUB_BRIDGE_TOKEN=<same-token>
```

The same process works on Linux using a Python virtual environment and an HTTPS
reverse proxy if the services are not on the same host. Keep the bridge private;
it receives EIK material and must never be Internet-accessible without network
access controls. Its bearer token is an additional control, not a substitute for
TLS or host firewalling.

## Tests

```bash
python -m pip install -e '.[test]'
pytest
```

Tests use an injected fake adapter and do not contact or mutate a Google account.
A live test needs the dedicated account, completed browser authentication, a
real advertised tag, nearby contributor devices, and the upstream private APIs
to still function.
