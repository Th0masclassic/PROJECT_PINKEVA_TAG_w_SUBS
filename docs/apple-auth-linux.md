# Apple authentication on Ubuntu / Docker

The backend can re-login automatically when Apple rejects a session. It needs
the Apple account credentials, a durable state volume, and a way to obtain
Apple's own 2FA code if Apple requests one. An `auth.json` containing only a
DSID/search-party token cannot renew itself.

This remains an experimental, unofficial Apple integration. Apple can change
the protocol, require account action, or refuse authentication; no SMS provider
can guarantee acceptance or eliminate every manual recovery case.

## Upgrade the existing VPS

Run from `/opt/pinqeva`. Preserve your existing `backend/.env`, Anisette state,
Supabase configuration, and encryption roots. **Do not erase the tracker, delete
the native Anisette identity, or regenerate `PINQEVA_KEY_ENCRYPTION_KEY` to fix
an Apple 401.** No database migration or tracker reset is needed for this release.

Back up `.env` and `state/` privately before the first upgrade. For example:

```bash
cd /opt/pinqeva
sudo install -d -m 700 /var/backups/pinqeva
sudo sh -c 'umask 077; tar -czf "/var/backups/pinqeva/before-apple-auth-$(date -u +%Y%m%dT%H%M%SZ).tgz" backend/.env state'
git pull --ff-only origin main
sudo docker compose build api
```

If Git reports local tracked changes, resolve those before continuing; do not
use `reset --hard`. The supplied Compose service is `api`, container `pinqeva-api`.

The container runs as UID/GID 10001. Prepare the existing state directory and
create a private password file. `touch` preserves an existing file's contents.

```bash
sudo install -d -m 700 -o 10001 -g 10001 state state/secrets
sudo touch state/secrets/apple-password
sudo chmod 600 state/secrets/apple-password
sudo nano state/secrets/apple-password
sudo chown 10001:10001 state/secrets/apple-password
chmod 600 backend/.env
nano backend/.env
```

Put only the Apple account password in that file, on one line. Keep it out of
chat, source control, shell command arguments, logs and the mobile app. Edit
these entries in `.env`, replacing the account address with yours:

```dotenv
PINQEVA_FINDMY_APPLE_ID=your-apple-account@example.com
PINQEVA_FINDMY_APPLE_PASSWORD=
PINQEVA_FINDMY_APPLE_PASSWORD_FILE=/var/lib/pinqeva/secrets/apple-password
PINQEVA_FINDMY_STATE_PATH=/var/lib/pinqeva/apple-auth-state.json
PINQEVA_FINDMY_LOGIN_ON_STARTUP=true
PINQEVA_FINDMY_SECOND_FACTOR=sms
PINQEVA_FINDMY_SMS_PHONE_ID=0
PINQEVA_FINDMY_2FA_PROVIDER=none
PINQEVA_FINDMY_REPORT_API=v2
PINQEVA_FINDMY_RETRY_INITIAL_SECONDS=60
PINQEVA_FINDMY_RETRY_MAX_SECONDS=1800
```

Use either a password value or its `_FILE`, never both. File contents are read
at process startup; recreate the API after changing secrets, even when their
file paths stay unchanged. Keep all existing Supabase/Stripe/device settings.

Keep your working Anisette URL and state path unchanged. The current VPS uses
native mode with `http://127.0.0.1:6969`; that port remains supported. Fresh Docker
installs default to native mode on port 6970 and
`/var/lib/pinqeva/anisette-state.bin`. The root Compose file already mounts
`./state:/var/lib/pinqeva`. An `.env` entry overrides image defaults: if copying
`.env.example`, change its development state path to the absolute Docker path
above and configure native Anisette explicitly:

```dotenv
PINQEVA_FINDMY_ANISETTE_PROVIDER=native
PINQEVA_FINDMY_ANISETTE_STATE_PATH=/var/lib/pinqeva/anisette-state.bin
PINQEVA_FINDMY_ANISETTE_URL=http://127.0.0.1:6970
```

That last block is for a **fresh installation**, not an instruction to move or
replace the existing VPS identity. Native state and auth state must be different
files. Check that UID 10001 can read your existing native state file.

Start the update and perform an initial interactive login:

```bash
sudo docker compose up -d --force-recreate api
sudo docker exec pinqeva-api python -m app.findmy_admin status
sudo docker exec -it pinqeva-api python -m app.findmy_admin login --interactive --force
```

`status` may initially exit 1: an available Anisette endpoint does not verify an
Apple token. First provisioning may also take longer than one HTTP timeout;
allow it to finish and retry the status command. If login reports
`authentication_in_progress`, let the current worker attempt finish, then run
the interactive command again. With provider `none`, it stops with
`two_factor_provider_required` rather than waiting on container stdin.

Interactive SMS login lists masked trusted numbers when a choice is needed.
Select the number you control, then enter Apple's code in the hidden prompt.
For trusted-device codes instead, set `PINQEVA_FINDMY_SECOND_FACTOR=trusted_device`
and recreate the container before the interactive login. The running API picks
up the saved encrypted session within about five seconds. Credentials never
need to be passed on the command line.

## Optional automatic SMS with Twilio

Use a dedicated Apple account and a dedicated Twilio subaccount/receiving
number. The server will hold both the Apple password and access to incoming
codes, so compromising the server can compromise both factors. Keep a separate
trusted recovery number/device under your control and protect the volume/backups.

1. Obtain an SMS-capable Twilio number. Confirm that it actually receives Apple
   verification SMS before relying on it. Twilio documents short-code, country,
   and VoIP delivery restrictions; number availability alone is insufficient.
2. Add that number to **the same Apple account** as a trusted phone number and
   complete Apple's verification. Read the initial enrollment SMS privately in
   Twilio Console. The backend cannot enroll the number for you or bypass 2FA.
3. In the received Apple message, record the exact **From** value. Use it in the
   sender allowlist; do not copy an example shortcode or allow every sender.
4. Create `state/secrets/twilio-auth-token` with the subaccount auth token using
   the same private-file procedure as the Apple password. Make the file owned by
   10001:10001 and mode 600. Do not use Twilio Verify: this integration reads
   Apple's messages from Twilio's Messaging API, and generates no codes itself.
5. Update `.env` with your real values, then recreate the API:

```dotenv
PINQEVA_FINDMY_SECOND_FACTOR=sms
PINQEVA_FINDMY_2FA_PROVIDER=twilio
PINQEVA_FINDMY_SMS_PHONE_ID=0
PINQEVA_FINDMY_TWILIO_ACCOUNT_SID=AC_REPLACE_WITH_YOUR_SUBACCOUNT_SID
PINQEVA_FINDMY_TWILIO_AUTH_TOKEN=
PINQEVA_FINDMY_TWILIO_AUTH_TOKEN_FILE=/var/lib/pinqeva/secrets/twilio-auth-token
PINQEVA_FINDMY_TWILIO_PHONE_NUMBER=+REPLACE_WITH_YOUR_E164_NUMBER
PINQEVA_FINDMY_TWILIO_ALLOWED_SENDERS=REPLACE_WITH_EXACT_APPLE_FROM_VALUE
PINQEVA_FINDMY_TWILIO_TIMEOUT_SECONDS=180
PINQEVA_FINDMY_TWILIO_POLL_SECONDS=3
```

The placeholders intentionally need replacement. SID must be `AC` plus 32 hex
characters; the receiving number must use E.164. Multiple observed senders can
be separated by commas. Keep the number dedicated to this account; the receiver
reads the most recent 100 messages for that recipient and will not follow
arbitrary pagination URLs.

```bash
sudo docker compose up -d --force-recreate api
sudo docker exec pinqeva-api python -m app.findmy_admin login --force
```

Apple decides when to challenge for 2FA, so a login without a challenge does not
test SMS delivery. On a challenge, the backend discovers trusted number IDs,
matches the configured receiving number (or its unambiguous visible suffix),
snapshots existing messages, requests one SMS, and polls for a fresh code. It
checks the account, recipient, allowed sender, inbound/received status, timestamp,
Apple message text, single six-digit code and message replay. It never logs codes
or message bodies, and never deletes messages or sends replies through Twilio.

If several masked numbers match, use the interactive login to see their IDs and
set `PINQEVA_FINDMY_SMS_PHONE_ID` to the intended positive ID. A mismatched or
unrecognized number fails before sending SMS. If Apple changes senders, update
the allowlist from verified messages. Repeated delivery failures back off and
eventually require operator attention. `login --interactive --force` remains
available as a manual fallback even with Twilio configured.

References: [Apple trusted phone numbers](https://support.apple.com/en-us/122621),
[Twilio short-code reception limitations](https://help.twilio.com/articles/223181668-Can-Twilio-numbers-receive-SMS-from-a-short-code),
[Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource).

## Verify the actual Apple report path

After the tracker has been claimed in the app, use its backend device UUID:

```bash
sudo docker exec pinqeva-api python -m app.findmy_admin probe --device-id YOUR_DEVICE_UUID
sudo docker exec pinqeva-api python -m app.findmy_admin status
sudo docker logs --since 15m --tail 500 pinqeva-api 2>&1 | grep -E 'native_anisette|findmy_|finder_|location_report'
```

The probe reads only that claimed tracker's advertisement-key hash from Supabase,
queries Apple using the same client as the API, and prints a report count. It
does not select private keys, decrypt locations, change ownership, or write any
tracker/location rows. It may invalidate a rejected auth session to request
recovery. Apple HTTP **200 plus a valid report envelope** proves this path accepted
the session; a zero report count is not an authentication failure. To confirm
decryption/storage too, request a location in the app and check
`findmy_request_reports_processed ... usable_report_count=...` and the location
request result. An accepted query does not guarantee that Apple's network has
observed this tracker during the requested window.

The default v2 request/response format follows the
[current upstream protocol implementation](https://github.com/malmeloo/FindMy.py/blob/main/findmy/reports/account.py).
`PINQEVA_FINDMY_REPORT_API=legacy` selects the older `acsnservice/fetch` format for
compatibility testing. The backend never sends account credentials to a custom
report URL or automatically switches protocols after an authentication failure.

## Status and recovery behavior

| Status/reason | Meaning and next action |
| --- | --- |
| `cached_unverified` / `session_unverified` | Token loaded/obtained; use the probe or a real location request to verify it. |
| `ready` | Last real report query succeeded. Check `last_verified_at`; status is not a new Apple query. |
| `authenticating` / `recovering` | Background login or backoff. Repeated app requests do not start extra logins. |
| `upstream_unavailable` | Transport, rate-limit, Anisette or response error. The token is retained; check the safe reason/logs. |
| `credentials_required` | Configure Apple ID and password; an old DSID/token file is insufficient. |
| `two_factor_provider_required` | Complete interactive login or configure a proven SMS receiver. |
| `two_factor_phone_selection_required` | Enroll the correct number or select its ID explicitly. |
| `two_factor_challenge_failed` | Apple did not accept the request that starts the selected 2FA challenge; retry once, then check Apple account access and safe logs. |
| `twilio_credentials_rejected` | Correct the subaccount credentials, recreate API, then explicitly retry login. |
| `two_factor_sms_timeout` | Check delivery, sender allowlist and server UTC clock; retry after backoff or use manual fallback. |
| `apple_auth_rejected` / `apple_session_rejected` | Check the account/password/provider. Even a fresh login can be rejected. After repeated failures, fix the cause and run `login --force`. |
| `state_unavailable` | Check UID 10001 permissions, disk space, unchanged encryption root and account, or restore the private backup. Never delete Anisette state to work around it. |

Transient login errors retry automatically with exponential backoff (60 seconds
to 30 minutes by default); cooldown survives restarts. Missing configuration,
invalid 2FA, ambiguous phone selection, and repeated authentication rejections
need operator action. Tokens rejected by Apple are invalidated on disk before
re-login; an unchanged legacy `auth.json` cannot resurrect them. New sessions
are saved atomically with mode 600 before requests can use them.

`/health` remains API liveness and `/ready` checks the database; neither claims
Apple is working. The private CLI status exits nonzero unless the last known
auth phase is `ready` and Anisette currently returns headers. Do not publish the
loopback Anisette port or state files to the Internet. Keep the VPS clock synced
(for example, check `timedatectl status`).

Auth state is bound to the configured Apple account and existing encryption root.
Enabling credentials after an older cache-only setup preserves client IDs but
discards the unbound token and logs in with the newly configured account.
If intentionally switching Apple accounts, stop the API, back up/move **only**
the encrypted Apple auth file to a private location, unset old legacy/direct
tokens, configure the new account, and login again. Preserve the Anisette file
and all provisioning encryption roots. Do not scale multiple native-provider
workers in one container: the supplied deployment uses one Uvicorn process.
The auth file lock coordinates API/CLI processes sharing the same local volume;
it is not a distributed lock for independent hosts.
