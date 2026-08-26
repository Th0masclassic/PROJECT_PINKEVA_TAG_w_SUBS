# Pinkeva mobile app

Cross-platform Expo/React Native app for iPhone, Android, and web. The app mirrors the supplied Pinkeva mockups, uses Supabase Auth, and hydrates each signed-in account from its active hosted Supabase device ownerships.

## Included flows

- Seven-language welcome gate before login: English, Portuguese, French, German, Mandarin Chinese, Italian, and Spanish.
- Supabase email/password login, registration, email confirmation, and password recovery.
- RLS-scoped active ownership loading with canonical hosted device UUIDs; account changes and foreground returns refresh the catalog without allowing stale responses to cross accounts.
- Google OAuth on iOS, Android, and web, plus native Sign in with Apple on iOS.
- Home dashboard with one locally persisted main tracker and up to two most recently opened trackers.
- Tracker list, real nearby-tag setup for authenticated users, main-device selection, rename/remove actions, and locally persisted icon overrides.
- Card, keys, bag, and car presentations. Card is the default and therefore requires no stored override.
- Native Google Maps UI for the latest stored tracker reports, plus lost-mode
  demo, settings, and localized support pages.
- Per-tag advertising interval and software-update flows.
- A visible subscription state on every tracker plus a dedicated per-tag plan,
  renewal, cancellation-at-period-end, checkout, and management screen.
- Native renewal notifications and a durable per-tag update state that remains
  pending until the app reads the exact signed entitlement back from the tag.

## Connection model

Pinkeva tags are not shown as permanently connected. During normal use a tag is shown as `Nearby`, `Away`, or with its last-reported time. A temporary `Connecting` / `Connected` state appears only while adding a tag, changing its advertising interval, installing tag software, or installing a renewed entitlement.

BLE connections cannot be resumed after they have disconnected. For a renewal,
hold the configured tag button continuously for five seconds. Firmware then
opens a connectable maintenance advertisement for two minutes, and the app
scans and creates a fresh connection. Normal finder advertising is
non-connectable and resumes after the exact signed packet is persisted and
verified.

## Configure tag setup

Set `EXPO_PUBLIC_API_URL` to the HTTPS provisioning backend. An authenticated
user can then choose **Add Tracker** to scan for the provisioning service. The
app displays only canonical `PKV-XXXXXXXXXXXX` tags, connects to the selected
tag, verifies the protocol identity and stored-key fingerprint, requests a
challenge-bound authorization from the backend, installs the one-time control
and advertisement keys, verifies the committed fingerprint, and completes the
device ownership association.

The app checks this setting before opening Bluetooth. If it is missing, **Add
Tracker** stops with a configuration message instead of scanning for a tag that
it cannot finish claiming. After changing `.env`, restart Expo so the value is
included in the native build.

Bluetooth setup needs a native development or release build on a physical
iPhone or Android phone. It is unavailable in Expo Go, the web build, and the
iOS Simulator. The current firmware installs the first signed per-tag
entitlement in the claim session. Finder advertising starts only after the
entitlement is persisted and verified by the tag.

The mobile client uses a temporary, non-bonding BLE session for setup. It does
not call a platform bond/pair API, does not enable automatic reconnect, and
does not persist a peripheral identifier. It requires protocol capability
`0x20`, which is exposed by the current development no-bond firmware. That
development profile bypasses bootstrap proof verification and does not request
OS-level GATT encryption. It is suitable for the present hardware workflow
only; production must add a reviewed authenticated application-layer secure
channel to preserve key confidentiality without introducing an OS bond.

Before a physical tag can be claimed, manufacturing must inject its unique
`boot_key` and register the matching encrypted bootstrap credential in the
backend database. Never place that credential or a backend secret in the mobile
environment.

## Configure authentication

Copy `.env.example` to `.env` and set the cloud project's public URL and publishable key. Do not use a Supabase secret or service-role key in a mobile build.

In Supabase Auth, enable the providers you intend to offer and allow these redirect URLs:

- Native: `com.pinkeva.mobile://auth/callback`
- Native password reset: `com.pinkeva.mobile://auth/reset`
- Email confirmation bridge: `https://<project-ref>.supabase.co/functions/v1/auth-callback/signup`
- Password recovery bridge: `https://<project-ref>.supabase.co/functions/v1/auth-callback/reset`
- Web development: the callback URLs produced by the local Expo web origin

The bridge is an unauthenticated HTTPS Supabase Edge Function. It displays a
safe SVG confirmation page in Mail/Safari and only opens the native app after
the user taps **Open Pinkeva**. This avoids the “invalid address” page shown by
Safari when a custom app scheme is opened on a device without the app
installed. On desktop the page confirms the account without attempting to open
a mobile scheme; close it and sign in from the phone app.

Google must also be configured in Supabase and Google Cloud. For Apple, enable the capability for `com.pinkeva.mobile` and include that bundle identifier in the Apple provider's accepted client IDs in Supabase. Native OAuth callbacks and Apple authentication require a development build; they are not fully testable in Expo Go.

## Configure per-tag billing

Set `EXPO_PUBLIC_API_URL` to the HTTPS backend. The app authenticates each
billing request with the current Supabase access token and uses these routes:

- `GET /v1/devices/{device_id}/subscription`
- `POST /v1/devices/{device_id}/subscription/checkout` with a `plan_code`
- `POST /v1/devices/{device_id}/subscription/portal` with
  `{ "action": "update" }` or `{ "action": "cancel" }`

Each subscription is displayed and managed for one tag. No Stripe secret,
publishable key, or card form belongs in the mobile app; checkout and portal
URLs are validated and opened in the system's secure browser.

Stripe renews a recurring subscription and informs the backend without the app
being open. The backend advances the paid period and records the physical tag
as `pending`. The subscription screen then offers the tag-update action until
the app writes the new signed expiry, reads all 135 bytes back over BLE,
verifies the SHA-256 digest, and acknowledges that exact counter and period to
the backend. A Stripe renewal is therefore app-independent, but updating an
offline ESP32 necessarily requires the owner to bring the phone near the tag.

Checkout buttons are enabled whenever the authenticated app has a valid HTTPS
`EXPO_PUBLIC_API_URL`. Missing API/auth configuration still fails closed. The
backend alone selects Stripe Price IDs and returns a validated Stripe-hosted
Checkout URL. Confirm the final hardware/service classification and current
Apple App Store and Google Play billing rules before store submission.

Static tracker and billing preview states require the explicit development-only **Preview
demo** entry on the login page, even when hosted Auth is configured. They never report a fake successful charge,
create an auth session, or appear in a release build. An authenticated release
with a missing billing API fails closed and displays billing as unavailable.

Live billing accepts only canonical Supabase device UUIDs hydrated through an
active ownership and safe device projection. Static pairing remains available
only inside the explicit development demo; it is excluded from subscription
requests. Local and demo IDs are deliberately rejected by the billing API
client instead of being sent to Stripe.

## Configure renewal notifications

Set `EXPO_PUBLIC_EAS_PROJECT_ID` to the UUID of the EAS project used for the
native build and configure APNs/FCM credentials for that project. On the first
authenticated native session, the app asks for notification permission and
registers an installation-scoped Expo push token with the backend. Web and
Expo Go are not renewal-notification targets.

The backend schedules one durable notification per subscription period at one
week before renewal, one day before renewal, and expiry. A separate notice is
created when a renewed entitlement remains absent from the tag for ten minutes.
Notification permission can be denied without affecting billing or BLE tag
updates; the backend inbox retains the event even when no push destination is
available.

## Configure Google Maps

Set `EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY` and
`EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY`, then regenerate/rebuild the native
projects. Use separate Google Cloud keys restricted respectively to the iOS
bundle identifier and Android package plus signing certificate fingerprints.
Enable Maps SDK for iOS and Maps SDK for Android only. An optional
`EXPO_PUBLIC_GOOGLE_MAP_ID` may identify cloud map styling.

The UI places markers only when `device.last_latitude` and
`device.last_longitude` contain an accepted report. It never fabricates a live
GPS position from Bluetooth RSSI. The iOS Simulator can render the UI, but BLE
setup and real tag reporting still require a physical phone.

When an authenticated Home, Map, Trackers, or tracker-detail screen becomes
visible, the app asks the backend for a fresh report for the relevant hosted
tag(s). The app sends only its Supabase access token and device UUID; finder
private keys and advertisement-key hashes remain in the backend. A temporary
report failure leaves the last accepted location on screen and does not create
placeholder coordinates.

## Run locally

```sh
npm install
npm run start
```

From Expo, press `i` for the iOS Simulator, `a` for an Android emulator, or `w` for web. Native Apple authentication requires a development build generated after the Supabase and Apple configuration is complete. You can also use:

```sh
npm run ios
npm run android
npm run web
```

For local iPhone testing with a free Personal Team, Apple Sign In is disabled
by default because Apple does not allow that entitlement for Personal Teams.
Email and Google authentication remain available. Set
`EXPO_PUBLIC_ENABLE_APPLE_SIGN_IN=true` and use a paid Apple Developer team
before enabling the production Apple provider; then regenerate the native
project and configure the App ID in Apple Developer and Supabase.

## Verification

```sh
npm run typecheck
npm test
npm run export:web
npm run export:ios
npm run export:android
```

Supabase sessions are persisted with iOS/Android secure storage (and browser storage on web). Language is device-local. Main tracker, recent tracker IDs, and non-default tracker icons are locally namespaced by the authenticated Supabase user so one account cannot inherit another account's choices. Local pairing previews are not synced or billable and reset when the demo process reloads.
