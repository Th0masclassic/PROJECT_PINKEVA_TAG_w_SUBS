# Pinkeva distributed backend

All implementation and deployment changes in this upgrade are under `backend/`.
Existing Supabase migrations remain the baseline and are read without editing.

## Audit of the previous architecture

Pinkeva already used FastAPI, Psycopg async pools, PostgreSQL/Supabase, asymmetric
Supabase JWT verification, Stripe, durable notification/cancellation outboxes,
and owner/session-bound encrypted finder keys. Reusing these pieces avoids a
second queue service and a second durable-state system.

| Area | Previous behavior and scaling gap |
| --- | --- |
| API location report | `POST /v1/devices/{device_id}/location/report` called upstream immediately for subscribers. Free users were denied cloud reports. Each simultaneous request could repeat the upstream work. |
| Location history | The history endpoint also fetched upstream. Reports were deduplicated in PostgreSQL and retained for 30 days. Latest location fields lived on `device`. |
| Background locations | Each API process ran a collector using `device_location_sync_state` leases, subscription-only eligibility, periodic full reconciliation, and concurrent batches. The queue was already durable, but manual fetches bypassed its leases. |
| Notifications | API instances could start renewal scheduling/delivery through configuration. Inserts were idempotent and jobs leased, but a batch of 25 sequential network calls could outlive its two-minute lease. |
| Cancellation | A separate worker already used PostgreSQL leases, stable Stripe idempotency keys, retry backoff, failed rows, and webhook-confirmed completion. Sequential lease batches and implicit SDK network timing needed bounding. |
| Retention | Every API ran an hourly timer with unbounded deletes. |
| Apple authentication | Apple login and sessions were process/local-file based; API startup could initialize Anisette and authenticate. Multiple machines could diverge or require interactive login. |
| Anisette | The backend Docker image embedded a native service with local device state. It supplies authentication material; it does not supply tracker locations. |
| Database | Pool size was fixed at 1–10 per process. Ownership, provisioning, subscriptions, and idempotency were already backed by transactions and constraints. |
| Redis/cron | No Redis or separate broker. Scheduling was implemented as Python background loops. |
| Other local state | JWT public-key caching is reconstructible. Firmware binaries and optional static assets are immutable deployment artifacts, which must be identical across API replicas. |

The previous location behavior was a hybrid of direct request-time upstream
fetching and an API-hosted subscriber collector, without distributed single
flight between those paths.

## Current topology

```text
Load balancer --> API replicas ----> PostgreSQL/Supabase
                         |                 |
                         +-- durable priority refresh requests
                                           |
                   scheduler ------> location sync state / queue
                                           |
                         realtime workers + scheduled workers
                                           |
                      bounded provider subprocesses
                        /                         \
              Apple Find My                Google bridge
                    |
       shared encrypted Apple session + pinned Anisette endpoint

maintenance workers --> notification/cancellation outboxes + retention
```

API instances own no provider sessions, local queue, or recurring background job.
All authorization is rechecked against current ownership/session/account state.
No sticky sessions are required. Immutable firmware may be baked into an image
or mounted read-only; do not mutate it independently on running replicas.

PostgreSQL is both durable source of truth and the queue/coordination store.
`FOR UPDATE SKIP LOCKED` distributes consumers; a unique device sync row
coalesces requests; random claim tokens and expiring leases fence writes after a
worker loses ownership. This fits the existing small PostgreSQL-backed service.
Redis is intentionally unnecessary: a Redis outage cannot lose this queue, and
no cache must be rebuilt before locations are readable. A future Redis cache
can be disposable without changing the durable contract.

PostgreSQL explicitly supports `SKIP LOCKED` for multiple consumers accessing
queue-like tables ([PostgreSQL SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html)).
Pool limits and bounded waiting use the existing Psycopg pool
([Psycopg pool documentation](https://www.psycopg.org/psycopg3/docs/api/pool.html)).

Workers limit in-flight jobs to the configured batch size. Provider calls run in
separate processes with an overall deadline; timed-out children are terminated
and reaped. A worker killed during a job leaves a lease that another worker can
reclaim. Writes verify the exact owner, provisioning session, and claim token,
so a late result cannot update a transferred tracker. Failures retry with bounded
backoff; exhausted cycles persist in `location_refresh_failure` for operations.

Schedulers share the `backend_schedule` cadence gate. Reconciliation is safe
across replicas, and workers can also perform it; scheduler loss therefore does
not permanently stop scheduling. Initial due times and recurring intervals have
jitter. Inactive trackers use a reduced cadence, and user reads refresh a
throttled activity marker. This is a simple activity policy, not a new fleet
partitioning system.

## Location response contract

The existing POST location URL and response fields remain usable. Free owners
receive the durable last known location. Premium owners return immediately when
the last successful check is inside the freshness window; otherwise the API
requests or joins one high-priority refresh and polls shared state for up to the
configured wait. The request does not hold a database connection while waiting.
When the wait expires or upstream fails, the response retains cached location.
The history endpoint reads retained data; fetching is owned by workers.

History access remains premium and is bounded to the existing 30-day retention.
Free scheduled refreshes update the durable latest projection without creating
premium history rows. A history request uses the same freshness/coalescing path;
it no longer performs a separate synchronous upstream history backfill.

New fields expose freshness without infrastructure details:

```json
{
  "last_location_at": "2026-09-04T12:00:00Z",
  "server_fetched_at": "2026-09-04T12:19:55Z",
  "age_seconds": 1200,
  "fetch_age_seconds": 5,
  "source": "cache",
  "stale": true,
  "refreshing": false,
  "upstream_refresh_failed": false
}
```

The device report can be twenty minutes old even when Apple was checked five
seconds ago. Device timestamp determines location age; the successful fetch
timestamp prevents repeatedly querying Apple for the same old report. No report
is fabricated when a tracker has never been located. Empty successful upstream
responses still establish a successful check time. Previously stored rows start
with an unknown fetch time until a new worker check succeeds.

Premium enqueues consume an atomic per-user budget. Workers consume an atomic
upstream-account budget shared across hosts. Existing tracker freshness and
failure backoff cannot be bypassed by repeated requests. Separate realtime and
scheduled worker pools reserve processing capacity for premium demand; a single
`all` worker is also available for smaller deployments. The account budget is
shared by both queues, so premium service cannot exceed provider capacity.

## Apple/Anisette setup

Run an independently managed Anisette service, preserving its virtual device
state. Expose a stable HTTPS endpoint on a private network or authenticated
reverse proxy. Loopback HTTP remains suitable for local operator use. Workers
refuse embedded `native` mode and local `auth.json` files.

Generate an independent 32-byte Base64 key for
`PINQEVA_FINDMY_SESSION_ENCRYPTION_KEY`. Use the same key and
`PINQEVA_LOCATION_ACCOUNT_KEY` on the operator and every location worker. With a
privileged database connection exported in a trusted operator shell:

```bash
python -m app.shared_apple_auth login --interactive
# Or import an already obtained session:
python -m app.shared_apple_auth import --file /secure/path/auth.json
# Preserve identity identifiers from the previous encrypted local state:
python -m app.shared_apple_auth import-state --file /secure/path/apple-auth-state.json
```

The operator path owns login/2FA and encrypted session updates. For a configured
Twilio-backed operator login use `login` with `PINQEVA_FINDMY_2FA_PROVIDER=twilio`;
`--interactive` explicitly selects a terminal. Legacy encrypted import requires
the existing provisioning envelope key and Apple ID and preserves UUIDs. The
retained local `findmy_admin` CLI can inspect/recover legacy state during migration.
Runtime workers have only SELECT access to the shared session table. Apple ID
passwords and 2FA codes are never needed by API replicas or location workers.
If Apple invalidates the token, cached locations remain available while an
operator reauthenticates; workers mark that exact session revision unavailable
and do not independently compete to log in. Transient Anisette/network failures
use shared retry state without invalidating the session.

A shared session includes stable authentication/device identifiers and is pinned
to the exact Anisette endpoint used during login. Randomly balancing independent
Anisette virtual devices is unsafe and is intentionally unsupported. More
Anisette capacity requires preserving that identity or an explicit future
account-to-tracker assignment. This release uses one logical upstream account
key per deployment; set that key consistently across API and worker replicas.

## Migration and rollout

1. Back up the database and preserve existing Anisette state/session material.
2. Apply all baseline `supabase/migrations/*.sql` through the existing deployment
   process. Apply each `backend/sql/migrations/*.sql` once, in lexical order,
   using an administrator connection with `psql -v ON_ERROR_STOP=1 -f FILE`.
   Record applied filenames in the deployment migration ledger. Each new file
   is transactional. Do not rerun the queue ALTER migration.
3. Existing installations run `backend/sql/upgrade_runtime_role_distributed.sql`.
   For a new runtime role run `create_runtime_role.sql`, the existing admin
   grants upgrade, then the distributed grants upgrade. No app process creates
   schema or requires migration privileges.
4. Import/login the shared Apple session using the intended stable endpoint.
   Give worker machines the shared database URL, account key, session envelope
   key, and provider settings. Use a TLS database URL and a secret manager.
5. Stop the old API-hosted location/notification collectors before enabling new
   workers. Drain old API instances before sending new traffic; they can still
   call upstream directly and do not follow the new distributed request rules.
6. Start a scheduler, scheduled worker, realtime worker, and maintenance worker.
   Deploy the stateless API image, verify readiness and a cache read, then
   increase replica counts. Keep old and new location collectors from running
   together during cutover.

The migration adds nullable fetch fields and queue coordination fields; it does
not reinterpret old device timestamps as fetch timestamps. Ownership-transfer
cleanup also clears fetch metadata. Existing location history is preserved.
SQL changes use ordinary index creation and take locks: apply during a controlled
window if sync-state tables are already large. Roll back application traffic
only after stopping new workers; preserve the additive schema and durable data
until a reviewed rollback migration is available.

## Docker across machines

Build and publish `backend/Dockerfile` with your existing image pipeline. All
machines use the same image version, database, settings, and relevant secrets.
Set `PINQEVA_IMAGE` to that immutable published image. From `backend`:

```bash
# On each API machine. Configure the binding for your private load balancer.
docker compose --profile api up -d api

# On any worker machine; increase either pool independently.
docker compose --profile workers up -d --scale location-worker=3 --scale realtime-worker=2

# Scheduling and auxiliary durable jobs may run on separate machines.
docker compose --profile scheduler --profile maintenance up -d
```

`PINQEVA_HTTP_BIND` defaults to loopback; configure an appropriate private
interface for the load balancer. Worker health ports are not published to host
interfaces. The Compose file contains no `container_name` or cross-machine
filesystem dependency. Anisette and PostgreSQL are independently managed shared
services, not started once per API replica. `PINQEVA_ENV_FILE` selects each
machine's secret environment file. Avoid copying operator credentials into it.

For local development, use `compose.dev.yaml` in addition to `compose.yaml`.
It mounts backend code read-only and assigns dynamic loopback API ports, allowing
multiple local API replicas. Discover ports with `docker compose ... port api
8080 --index N`. Point database/provider settings at the existing development
Supabase/services; `host.docker.internal` reaches the host from Docker Desktop.
This override requires a Compose release supporting `!override` (2.24.4+).

## Limits, operations, and failure recovery

See `.env.example` for every configurable default. The starting cadence is 900
seconds for active trackers, 21,600 seconds after 30 days of inactivity, a
30-second premium freshness window, eight-second API wait, 60-second job
deadline, 120-second lease, and five attempts. Notification/cancellation workers
claim one immediately runnable job per consumer; add consumers to scale them.
Retention uses bounded `SKIP LOCKED` batches instead of unbounded deletes.

Total database demand is roughly the sum of every process's pool maximum plus
one short-lived session-read connection per active Apple provider subprocess.
Bound replica counts, `PINQEVA_LOCATION_SYNC_BATCH_SIZE`, and pool maxima to the
database connection budget. Supabase transaction/session pooler compatibility
and TLS mode must match the selected deployment. At 100,000 active trackers a
15-minute cadence requires about 111 tracker refreshes per second before
premium traffic and retries; the default 60/minute account budget cannot deliver
that. Capacity and upstream allowances must be measured before promising that
scale. Sharding is not introduced.

API `/health` checks liveness and `/ready` checks PostgreSQL and required queue
schema columns using a zero-row query. Every new worker
role serves the same probe paths on its private health port; readiness checks
database connectivity and whether its supervised tasks remain alive. Configure
restart policies and alerts; Docker health alone does not restart unhealthy
containers. Application JSON logs include request/job identifiers, reason,
worker identity, attempt, queue delay, duration, and device age where applicable.
No location coordinates, Apple payloads, secrets, or provider error text are
needed for these events.

Production worker isolation targets Linux containers: Linux parent-death signals
also terminate provider children if the worker process is forcibly killed.
Windows/macOS development uses the deadline watchdog, but cannot guarantee that
an orphan exits immediately after forcible parent termination. The per-call
process cost is deliberate; measure throughput before increasing concurrency.

Useful private operational queries:

```sql
SELECT priority, count(*) AS due,
       max(now() - next_attempt_at) AS oldest_due_age
  FROM public.device_location_sync_state
 WHERE next_attempt_at <= now()
 GROUP BY priority;

SELECT error_code, count(*) FROM public.location_refresh_failure
 WHERE failed_at > now() - interval '1 day' GROUP BY error_code;

SELECT push_status, count(*) FROM public.user_notification GROUP BY push_status;
SELECT status, count(*) FROM public.subscription_cancellation_outbox GROUP BY status;
```

Alert on sustained queue delay, expired leases, retry exhaustion, authentication
failures, slow fetches, database pool saturation, failed push/cancellation rows,
and old `awaiting_webhook` cancellation rows. Cancellation completes only after
a signed terminal Stripe webhook. Expo delivery is at least once: a crash after
Expo accepts a push but before database acknowledgement can resend it; the
durable inbox and scheduling keys remain deduplicated.

API death leaves shared jobs intact. Worker death is recovered by lease expiry.
Apple/Anisette failure returns cache and controlled retries. Database loss fails
closed and readiness returns 503; there is no process-local authoritative cache
that can bypass ownership checks. Do not manually mark failed cancellations
complete or bypass an Apple authentication error with another device identity.

## Validation

Run `python -m pytest` from `backend`. Tests cover existing ownership/billing
behavior, cache freshness and fallback, queue coalescing and fencing, retries,
priority, safe worker runtime, provider deadlines, and shared Apple sessions.
PostgreSQL integration tests require local `initdb` and `pg_ctl`; they create an
isolated temporary cluster and do not use the deployment `.env` database.
Docker Compose files can be validated with `docker compose ... config --quiet`.
Live Apple, Google, Stripe, load-balancer, and image deployment checks require the
configured services and must be performed as a deployment smoke test.
