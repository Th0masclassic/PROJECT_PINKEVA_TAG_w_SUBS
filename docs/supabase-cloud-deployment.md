# Supabase cloud deployment

The hosted Supabase project owns Auth, PostgreSQL, and the Data API. The Python
provisioning API remains a separate service: it connects to PostgreSQL over TLS
and validates mobile access tokens with the project's public JWKS endpoint.

## Deploy the schema

Use the migration history in `supabase/migrations`; do not recreate tables in
the Dashboard SQL editor. From the repository root:

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase migration list
npx supabase db push --dry-run
npx supabase db push
```

Do not use `db reset --linked` and do not add `--include-seed` against a
production project. `supabase/seed.sql` contains local development plans only.
The production migrations also enforce per-tag billing: an account may have
multiple subscriptions for different devices, while a device can have only one
current/nonterminal subscription. Cancelled and ended rows remain as history.

After deployment, verify that every public table has RLS enabled, the new user
trigger exists, and `anon`/`authenticated` have no privileges on:

- `payment_event`
- `provisioning_session`
- `device_release`
- `subscription_cancellation_outbox`
- `device_bootstrap_credential`
- `plan_price_history`
- `admin_role_assignment`
- `admin_audit_log`

The migration intentionally exposes only safe column projections for profiles,
ownerships, devices, plans, subscriptions, and invoices.

## Configure Auth

Email confirmation and password recovery use the hosted HTTPS callback bridge
so a link opened in Mail/Safari is always a valid web address. The bridge then
shows a deliberate **Open Pinkeva** button that launches the native callback.
The exact bridge URLs and native callbacks are versioned in
`supabase/config.toml`; do not replace them with a wildcard in production.

The callback is an unauthenticated Supabase Edge Function. It returns a small
SVG confirmation page (the shared Supabase domain rewrites HTML responses to
plain text) with a deliberate **Open Pinkeva** button. Deploy it after linking
the project:

```sh
npx supabase functions deploy auth-callback --no-verify-jwt
npx supabase config push
```

The app passes the HTTPS function page to Supabase for signup and password
recovery, while Google/Apple continue to use
`com.pinkeva.mobile://auth/callback`. On a phone/tablet the page exposes the
native-app button; on a desktop it only confirms the account and tells the user
to sign in from the mobile app, so no invalid custom-scheme navigation is
attempted on a PC.
Older emails generated before the bridge deployment should be resent because
their one-time redirect was created with the previous callback.

`supabase db push` does not copy Auth settings. With the current CLI, supported
hosted settings in `supabase/config.toml` can be applied deliberately with
`supabase config push` after reviewing the linked-project diff. This project
uses the hosted bridge as its site URL, exact bridge/native callback allow-list
entries, confirmed email sign-up, an eight-character letters-and-digits policy,
secure password changes, refresh-token rotation, and TOTP support. Re-run and
verify the config push whenever those versioned settings change.

The current Supabase CLI does not round-trip the hosted password policy fields
when pushing `config.toml` and may send its six-character defaults. The cloud
project was corrected through the Auth Management API after the callback push;
verify `password_min_length = 8` and the letters/digits requirement after any
future Auth config push.

Production SMTP and Google/Apple provider credentials still require their
external service credentials and secret-manager values. They must be configured
and verified separately; never commit provider secrets just to make a config
push succeed.

Email/password authentication should require email confirmation, a minimum
eight-character password with letters and digits, and production SMTP before a
public release.

Google requires a Web OAuth client. Store its client ID and secret in the
Supabase Google provider configuration; use this hosted callback in Google:

```text
https://<project-ref>.supabase.co/auth/v1/callback
```

Apple requires the final bundle ID (`com.pinkeva.mobile` unless changed), an
Apple Developer App ID with Sign in with Apple, and provider configuration in
Supabase. Apple/Google provider secrets never belong in Expo, Xcode, Git, or the
Python API.

## Backend runtime values

Copy `backend/.env.example` into the deployment secret manager. Set:

- a TLS PostgreSQL URL for a dedicated least-privilege backend login;
- the public Supabase project URL;
- three different persistent 32-byte Base64 roots for key encryption,
  bootstrap-key encryption, and claim capabilities.

Never generate new encryption roots during a normal restart. Losing them makes
existing encrypted device material unreadable. The service-role key is neither
required nor accepted by the backend design.

Create the dedicated runtime login with
`backend/sql/create_runtime_role.sql`, supplying
`PINQEVA_BACKEND_ROLE_PASSWORD` from the deployment secret manager. The role is
not a superuser and can access only the tables used by provisioning. It has
`BYPASSRLS` because backend-only key-custody tables intentionally have no client
policies, so its credential must be treated as a high-value production secret.

After applying the administration migration to an existing deployment, run
`backend/sql/upgrade_runtime_role_admin.sql` as the database owner. It adds only
the new table and sequence privileges needed by that same runtime role.

## Stripe and administrator runtime values

Create one recurring Stripe Product/Price pair for each 1, 3, 6, and 12-month
plan, then put the four pairs in `STRIPE_PRICE_MAP_JSON`. Configure the Checkout
and Portal return URLs, create a webhook endpoint for
`/v1/billing/stripe/webhook`, and
store its signing secret in `STRIPE_WEBHOOK_SECRET`. The app never receives a
Stripe secret or chooses a Price ID or amount; it sends a validated plan code
and the backend resolves the current database binding.

Set `PINQEVA_ADMIN_OWNER_USER_IDS` to the first trusted Supabase user UUID. This
environment-owned role is the recovery root and is the only role allowed to
grant or revoke database administrators. Set `PINQEVA_ADMIN_ALLOWED_ORIGINS` to
the exact HTTPS admin-console origins and keep
`PINQEVA_ADMIN_REQUIRE_AAL2=true`. Every privileged operation then requires a
fresh Supabase bearer token, an active role, verified TOTP/AAL2, and produces an
append-only audit record. Never use a service-role key in the browser console.

## Mobile and map runtime values

Copy `mobile-app/.env.example` to the local ignored `.env` and set only the
project URL and publishable key. Row Level Security is the security boundary;
never put a database password, service-role key, provider secret, or backend
encryption root in an `EXPO_PUBLIC_` variable.

Also create separate restricted Google Maps SDK keys for iOS and Android. Bind
the iOS key to the final bundle ID and the Android key to the package name and
release signing-certificate fingerprints. A native rebuild is required after
adding these values. The browser administration panel uses a third public key,
restricted to its exact HTTPS origins and Maps JavaScript API only.

Copy `admin-panel/.env.example` to an ignored `.env`, set its public Supabase,
API, and browser Maps values, and deploy the production build behind the CSP and
security headers documented in `admin-panel/README.md`.

## Public-repository incident

Four legacy experimental artifacts were previously committed to the public Git
history and are removed on the cloud-auth branch without opening their content:

- `Test/Apple_FindMy_test/auth.json`
- `Test/Apple_FindMy_test/xscYRv+.keys`
- `Test/Apple_FindMy_test/ESP32/tmp.key`
- `Test/Apple_FindMy_test/reports.db`

Treat any credential, session, key, or location data they contained as exposed.
Rotate/revoke it before production. Removing the files in a new commit does not
remove them from existing history, forks, or caches; a coordinated history
rewrite and collaborator re-clone is still required.
