# PINKEVA storefront

A static Vite storefront for PINKEVA Card, redesigned around the approved product
artwork, a scroll-driven system explanation, and a clear card selection flow.
The website remains in English, matching the existing storefront.

## Local development

```sh
cd website
npm ci
npm run dev -- --port 4178 --strictPort
```

Open http://127.0.0.1:4178/. Build with `npm run build`; run the event/state and
static-content tests with `npm test`. `npm run preview` serves the build locally.

## Experience

- High-contrast navy, ice blue and lime, with prominent product and purchase links.
- The hero moves the approved card image in CSS perspective as the page scrolls.
- On desktop, a sticky scene progressively separates the card, connection and app
  layers. These are conceptual system layers, **not physical components**.
- On mobile, numbered controls change the scene and matching explanation without
  forcing long pinned scrolling. Without JavaScript, all explanations remain visible.
- Reduced-motion preferences show a static expanded scene. An additional pause
  control disables scene movement. No canvas, WebGL or animation library is loaded.
- Images below the hero load lazily; the approved product and app artwork is reused.
- Native dialog behavior provides the selection modal, keyboard dismissal and
  background inertness. Explicit labels, a skip link and visible focus styles are included.

## Purchase is intentionally static

The user confirmed that no card payment links exist and requested a static
purchase presentation. Quantity (1–10), an indicative subtotal and the selection
summary work locally. Checkout stays disabled. This page creates **no orders,
reservations, subscriptions or payments**, stores no customer data, and makes no
API calls. Reloading resets the selection.

The €14.99 card price is retained from the prior storefront and labeled as a
preview price; it is not verified against a live hardware catalog. Cloud+ prices
are reference values from
`supabase/migrations/20260824213000_admin_maps_and_flexible_plans.sql`.
Live pricing, shipping, taxes, inventory and any introductory offers require
confirmation before enabling sales. The unverified first-month offer from the
old storefront is no longer presented as an entitlement.

The existing backend checkout endpoints
`/v1/subscription/checkout` and
`/v1/provisioning/requests/{request_id}/checkout` serve authenticated subscription
flows. They are not hardware purchase endpoints and are not called by this site.
The API and app integration code are unchanged.

Network descriptions are qualified rather than asserting Apple/Google approval
or certification. The app screenshot is an existing project preview with
illustrative location data, not a claim about the current iPhone installation.
No physical specifications, battery life, delivery dates or testimonials were invented.

## Validation and limits

`npm test` covers quantity boundaries and cent arithmetic, summary state and focus
restoration callbacks, menu dismissal, mobile story selection, scroll progression,
pause/reduced-motion handling, and the optional agent tool's input contract.
It also checks local asset/anchor references and that checkout is disabled in HTML.
These tests use an event/state fixture, **not a rendering browser**. They do not
certify visual layout, contrast, native modal focus trapping or screen-reader behavior.

An optional, feature-detected WebMCP `review_card_selection` tool stages the same
static summary and returns `orderCreated: false`. Its contract is tested in a
fixture; no supported live WebMCP browser context was verified.

The production build preserves the existing Docker contract: the root Dockerfile
copies the same three source files and `public/`, and the backend continues serving
`/`, `/index.html` and `/assets/*`. No new runtime dependencies or API routes are needed.
Fonts still use the existing Google Fonts integration with system fallbacks.

## Isolated redesign work

- Branch: `codex/pinkeva-website-redesign`
- Worktree: `/Users/tomasrocha/Documents/Codex/worktrees/pinkeva-website-redesign`
- Starting point: `fce34484519fecced8165b35d152e38edebe42a7` (`main`, matched origin
  at worktree creation).
- Scope: `website/` only. Uncommitted mobile work in the original checkout was not
  copied, edited or incorporated. No production deployment was requested or made.
