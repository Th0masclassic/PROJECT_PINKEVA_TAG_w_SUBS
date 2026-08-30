# PINKEVA storefront

This is a local product/marketing storefront for the PINKEVA Card. It is a
static Vite site with no checkout or backend connection yet; the order drawer
is an intentionally local preview that can be connected to Stripe later.

## Run locally

```powershell
cd website
npm install
npm run dev
```

Then open the local URL Vite prints, normally `http://127.0.0.1:5173`.

Build a production bundle with:

```powershell
npm run build
```

The repository-root `Dockerfile` builds this production bundle and embeds it
in the API image. In that deployment, `/` and `/index.html` serve the
storefront, `/assets/*` serves its static files, and existing API routes remain
available on the same origin.

The product and app imagery is copied from the approved assets in
`mobile-app/assets/pinkeva` and `Images/MOCKUP_MOBILE_IMAGES`.
