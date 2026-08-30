# Apple report retrieval scale assessment

## Decision

The current Anisette/private-report integration is suitable for controlled
development, not for a 10,000-tag production service on one Apple account. It
must not be presented as anonymous or unassociated access: every report request
uses the Apple account's DSID and session token and includes the requested
advertisement-key identifiers. Apple can therefore associate request volume and
identifiers with that login even though Pinqeva, not Apple, stores the per-tag
private scalar used to decrypt a response.

Commercial launch needs the official Apple Find My/MFi path and written service
terms. The private endpoint has no public availability commitment, capacity
contract, stable schema, or published rate limit. Rotating several consumer
accounts to evade unknown limits is not an acceptable scaling strategy.

## Current load at 10,000 tags

The durable worker leases one tag at a time and, at a 15-minute cadence, performs
one Anisette-header request and one Apple report request for each Apple identity.
At 10,000 active tags that is approximately:

- 96 polling cycles per tag per day;
- 960,000 Apple report requests per day and 960,000 Anisette requests per day;
- 667 of each request every minute, or about 11.1 requests per second of each;
- additional Google bridge requests, database writes, retries, and alert work.

Those numbers do not establish that Apple will accept the load. A single login
also creates one operational and abuse-control failure domain for the entire
fleet.

## Batching opportunity and unknowns

The checked experimental report script and backend request shape support an
array of advertisement-key IDs in one Apple request. A production scheduler
could therefore batch identities that share the same authenticated session. For
example, batches of 100 would reduce 10,000 tags to roughly 100 Apple calls per
15-minute cycle (about 0.11 calls per second before retries).

That example is capacity arithmetic, not an approved limit. The maximum IDs per
request, response size, report count, timeout behavior, account quotas, and
acceptable sustained cadence are undocumented. They must be established through
an official agreement and a staged load test. A safe implementation also needs:

- bounded batch sizes and response-byte limits;
- one shared token refresh operation instead of a refresh stampede;
- jittered leases, exponential backoff, circuit breaking, and per-provider
  concurrency budgets;
- idempotent provider-tagged ingestion and deterministic newest-report selection;
- metrics for latency, status codes, throttling, empty reports, decrypt failures,
  account health, and queue age;
- credential isolation, rotation, incident recovery, and no secrets in logs.

## Location history

Apple's response window is not a Pinqeva 30-day history guarantee. The backend
now stores every accepted, decrypted observation in its own provider-tagged
`device_location_history` rows, bound to the active owner and provisioning
session, deduplicated by source fingerprint, and retained for at most 30 days.
Apple and Google can return only a latest or short provider history and Pinqeva
still builds its own bounded history over time. Collection stops when the account
does not have an active/trialing subscription; billing never changes the tag's
radio identities.

## Production gate

Before claiming support for 10,000 tags, Pinqeva must obtain the official
accessory/service route, document agreed limits, implement batched collection,
and pass a staged test from hundreds through 10,000 identities with provider and
database failure injection. Until then, the honest result is: dual-provider
logic works at the application-contract level, but the current one-login Apple
transport is not production-qualified at that fleet size.

References: [Apple Find My accessory program](https://developer.apple.com/find-my/),
[`biemster/FindMy` experimental client](https://github.com/biemster/FindMy), and
the repository's [Google bridge contract](google-findhub-bridge-contract.md).
