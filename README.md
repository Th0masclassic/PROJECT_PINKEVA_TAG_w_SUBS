# Pinqeva

**Always know what’s near.**

Pinqeva is a greenfield product prototype for a slim Bluetooth item-tracker card, its iPhone/Android companion, customer storefront, subscription and device API, PostgreSQL database, MQTT control plane, operator dashboard and ESP32-C3 reference firmware.

![Pinqeva Card concept](apps/web/public/pinqeva-card-hero.png)

## What this repository contains

| Area                                     | Location             | Current result                                                                                                                                      |
| ---------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketing + customer/operator web        | `apps/web`           | Responsive React/Vite site, selectable 1/3/6/12-month packs, product imagery, customer map/device views and clearly labeled synthetic operations UI |
| API                                      | `apps/api`           | Fastify API for auth, plans, ownership-scoped devices/locations, subscriptions, signed webhooks, audits and MQTT entitlements                       |
| Mobile companion                         | `apps/mobile`        | Expo iOS/Android prototype with device, nearby ring, onboarding, plan and account flows                                                             |
| Shared contracts                         | `packages/contracts` | Strict Zod request/domain contracts shared by the backend                                                                                           |
| Database                                 | `db`                 | PostgreSQL schema, indexes and exact pricing seed                                                                                                   |
| Local infrastructure                     | `infra`              | Loopback-only PostgreSQL and Mosquitto development Compose stack                                                                                    |
| Firmware reference                       | `firmware/esp32c3`   | BLE-first ESP32-C3 prototype and opportunistic MQTT/entitlement seam                                                                                |
| Product, brand and engineering decisions | `docs`               | Brand screen, pricing, product brief, architecture, threat model, battery assessment and launch gates                                               |

## Important product truth

This is not a finished or certified “AirTag.” AirTag is an Apple trademark. Pinqeva should be described as a **Bluetooth item tracker**.

- Apple Find My support requires MFi enrollment and approval.
- Google Find Hub support requires partner onboarding and certification; ESP32-C3 is not currently on Google’s published pre-certified locator-chipset list.
- A switchable certified card can use only one finder network at a time, not both simultaneously.
- ESP32-C3 has no GNSS, cellular radio or UWB. Nearby BLE can ring and indicate close/far; it does not produce directional precision or independent global location.
- A 100 mAh cell is a prototype assumption, not a battery-life claim. Persistent Wi-Fi/MQTT would drain it quickly.
- Subscription expiry pauses only optional Pinqeva cloud features after a 14-day grace period. Identification, reset, renewal, anti-stalking behavior, nearby safety/recovery and critical updates remain available.

Read [architecture.md](docs/architecture.md), [hardware-feasibility.md](docs/hardware-feasibility.md), [hardware-battery-evaluation.md](docs/hardware-battery-evaluation.md), [card-ownership-subscriptions.md](docs/card-ownership-subscriptions.md) and [launch-roadmap.md](docs/launch-roadmap.md) before making hardware, coverage or subscription-transfer promises.

## Working brand and price

Pinqeva is a screened **working name**, not a legally cleared trademark. Complete EUIPO, Portuguese INPI and WIPO similarity searches with trademark counsel before public spend.

| Item         | Price incl. VAT | Effective monthly |
| ------------ | --------------: | ----------------: |
| Pinqeva Card |     €14.99 once |                 — |
| 1 month      |           €2.00 |             €2.00 |
| 3 months     |           €5.00 |             €1.67 |
| 6 months     |          €10.00 |             €1.67 |
| 12 months    |          €15.00 |             €1.25 |

Recommended introductory card + 12-month bundle: **€29.99**, subject to landed-cost and margin validation. See [pricing.md](docs/pricing.md).

## Run locally

Prerequisites:

- Node.js 22 or newer and npm 10 or newer
- Docker Desktop for the live PostgreSQL/Mosquitto integration
- Expo Go or native iOS/Android toolchains for device testing
- PlatformIO for the ESP32-C3 reference build

Install the JavaScript workspaces:

```powershell
npm install
```

Start local infrastructure:

```powershell
Copy-Item infra/.env.example infra/.env
# Replace the two development secrets in infra/.env.
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d
```

Configure and start the API:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
# Replace every secret; use http://localhost:5173 in CORS_ORIGINS.
npm run db:migrate
npm run db:seed
npm run dev -w apps/api
```

Start the web app:

```powershell
npm run dev -w apps/web
```

Open `http://127.0.0.1:5173`. The `/app` route shows the customer and synthetic operator dashboard.

Start the Expo app:

```powershell
npm run start -w apps/mobile
```

The precise setup and secret-provisioning steps are in [apps/api/README.md](apps/api/README.md), [infra/README.md](infra/README.md), and the mobile/firmware READMEs.

## Verification

Run the JavaScript checks:

```powershell
npm run typecheck
npm test
npm run build
```

The API unit and injected-route tests run without a live database or broker. Live PostgreSQL/Mosquitto integration, real BLE behavior, iOS/Android background execution, RF, power, battery, security and certification testing still require their respective environments and hardware. A passing software build is not evidence of production hardware readiness.

The current locked dependency graph reports zero known vulnerabilities through `npm audit`; this is time-sensitive evidence, not a security guarantee. Release guidance is recorded in [dependency-security.md](docs/dependency-security.md).

## Security posture

The prototype implements strict Zod validation, parameterized PostgreSQL queries, ownership-scoped access, server-side paid access for cloud location history, bcrypt password hashes, short-lived JWT access tokens with database session checks, refresh-family replay revocation, exact CORS origins, explicit proxy trust, Helmet/hosting headers, request/body rate limits, signed/idempotent payment webhooks, durable leased MQTT desired state, audit events, fixed topic parsing and signed Ed25519 entitlements.

Payment-provider checkout and cancellation are deliberately disabled in production until a real server-side provider adapter is connected. The development redirect seam is useful for UI/API integration only and cannot charge or cancel a customer.

Production still requires managed TLS/mTLS, KMS/HSM keys, encrypted precise coordinates, operator RBAC/MFA, production WAF/rate-limit storage, signed OTA and secure boot, DULT anti-stalking validation, independent penetration testing, privacy review and regulatory certification. See [security-threat-model.md](docs/security-threat-model.md) and [SECURITY.md](SECURITY.md).
