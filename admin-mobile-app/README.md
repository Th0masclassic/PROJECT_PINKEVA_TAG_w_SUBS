# Pinkeva Admin mobile

Separate native iPhone and Android application for Pinkeva owners and
administrators. It uses the same public Supabase project and Pinkeva API as the
customer app, but has its own bundle identity (`com.pinkeva.admin`), secure
session namespace, app icon, interface, and release artifact.

The API remains the security boundary. Every Admin request requires a valid
Supabase session, an active owner/admin assignment, and AAL2 TOTP MFA. The app
contains no database, Stripe, Supabase service-role, or device secret.

## Configure and run

1. Copy `.env.example` to `.env` and set the public Supabase and API values.
2. Run `npm install`.
3. Run `npm run check`.
4. Run `npm run ios` or `npm run android`.

The app supports overview metrics, account/tracker lookup and maps,
subscription grants/revocations, price management, factory tag registration,
administrator management for owners, and the privileged audit log.
