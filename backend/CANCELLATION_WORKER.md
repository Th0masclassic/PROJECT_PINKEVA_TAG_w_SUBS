# Subscription cancellation worker

The account-level billing model does not cancel a subscription when one tag is
released. This queue instead delivers immediate Stripe cancellations after an
administrator revokes account billing, a post-Checkout account becomes
unavailable, or the migration consolidates old duplicate per-tag plans. It also
retains validation for legacy device-release and ownership-lost rows created
before the account migration. Provider calls never hold a database transaction
open.

Five reason-specific database bindings are accepted:

- `cancellation_reason = 'device_release'` requires a non-null
  `device_release_id` and the exact completed release/ended-ownership proof.
- `cancellation_reason = 'ownership_lost_checkout'` requires a null
  `device_release_id`, terminal local status with
  `ended_reason = 'ownership_lost_checkout'`, and no active ownership for the
  subscription's user/device pair. This does not fabricate a release record.
- `cancellation_reason = 'account_unavailable_checkout'` requires terminal
  local account state with the matching ended reason.
- `cancellation_reason = 'account_consolidation'` requires a duplicate legacy
  row ended by the account migration.
- `cancellation_reason = 'admin_revoked'` requires a terminal row with an
  audited administrator revocation.

## State and safety model

- `pending`: eligible for a leased attempt after `next_attempt_at`.
- `processing`: held by one short worker lease. Crashed workers are recovered
  after `lease_expires_at`; concurrent workers use `FOR UPDATE SKIP LOCKED`.
- `awaiting_webhook`: Stripe accepted the request, but completion is not yet
  trusted. The request uses a stable outbox-derived Stripe idempotency key.
- `completed`: a signature-verified Stripe subscription webhook explicitly
  reported the matching provider subscription as terminal and set
  `subscription.provider_terminal_event_at`.
- `failed`: retry budget, permanent provider rejection, invalid database
  binding, or webhook confirmation timeout requires operator attention.

During migration, a prototype `processing` row with no lease is safely returned
to `pending`. A prototype `completed` row had no proof-of-webhook field, so it
is quarantined as `LEGACY_COMPLETION_REQUIRES_RECONCILIATION` instead of being
silently trusted; replaying the matching signed terminal webhook completes it.

Before contacting Stripe, the worker revalidates the exact subscription and
provider ID plus the reason-specific proof above. A later owner of the same
physical tag does not block cancellation of the former owner's provider
subscription.

Provider errors are stored only as stable internal codes. Logs contain the
outbox UUID, attempt number, exception type, and safe code; they never contain
Stripe keys, database URLs, request/response payloads, or raw provider errors.

## Run

Apply all Supabase migrations first, then give the process only these secrets:

```sh
export DATABASE_URL='postgresql://...?...sslmode=require'
export STRIPE_SECRET_KEY='sk_live_...'
python -m app.cancellation_worker
```

Run from the `backend` directory inside its virtual environment. The database
login needs `SELECT`/`UPDATE` access to subscriptions, releases, ownerships,
devices, and `subscription_cancellation_outbox`; the repository runtime role
already has those grants. The worker does not need the Stripe webhook secret,
Supabase keys, or provisioning encryption roots.

Optional bounded settings:

| Variable | Default | Purpose |
|---|---:|---|
| `PINQEVA_CANCELLATION_BATCH_SIZE` | `10` | Legacy setting accepted for compatibility; each sequential consumer now leases one immediately runnable job. |
| `PINQEVA_CANCELLATION_POLL_SECONDS` | `5` | Idle poll interval. |
| `PINQEVA_CANCELLATION_LEASE_SECONDS` | `120` | Crash-recovery lease. |
| `PINQEVA_CANCELLATION_MAX_ATTEMPTS` | `8` | Finite provider-call retry budget. |
| `PINQEVA_CANCELLATION_RETRY_BASE_SECONDS` | `5` | Initial retry delay. |
| `PINQEVA_CANCELLATION_RETRY_MAX_SECONDS` | `900` | Exponential-backoff cap. |
| `PINQEVA_CANCELLATION_WEBHOOK_TIMEOUT_SECONDS` | `86400` | Signed-confirmation deadline. |

Deploy it as a continuously restarted worker with one or more replicas. SIGINT
and SIGTERM request a cooperative stop: an in-flight provider call completes
and persists its result before the database pool closes. A hard process kill is
safe because the lease expires and the next attempt reuses the same Stripe
idempotency key.

The backend Docker deployment runs cancellation through
`python -m app.worker maintenance` or `python -m app.worker cancellation`, with
private `/health` and `/ready` endpoints. These shared-runtime commands read the
full backend configuration. The standalone command above retains its smaller
secret set. Each provider call uses a dedicated Stripe HTTP client with a
15-second socket timeout and SDK retries disabled; durable queue retries own
backoff. No consumer leases a waiting sequential batch.

## Operations

Alert on every `failed` row and on old `awaiting_webhook` rows. Do not manually
set a row to `completed`; replay the signed Stripe event or reconcile the exact
provider subscription and record an audited operator action. A successful API
cancellation without a matching webhook deliberately remains unconfirmed.
