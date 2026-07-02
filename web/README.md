# Pattern Support Portal — Web (V1)

Next.js (App Router) read-only customer support dashboard.

## Local development
```bash
cp .env.example .env
npm install
npm run dev      # http://localhost:3000  ->  redirects to /dashboard
npm run build    # production build
```

## Data source (live only)
The dashboard reads exclusively from the live API (`src/lib/api.ts` →
`/api/session`, `/api/tickets`), which serves the customer projection from
PostgreSQL. There is no mock/fixture mode.

Server-side configuration (DATABASE_URL, ClickUp/Graph credentials,
AUTO_PUBLISH_ENABLED, PORTAL_ACCOUNT_SLUG) lives in non-`NEXT_PUBLIC_` variables;
see `.env.example`. Data-pipeline scripts (migrate/seed/verify, ClickUp sync,
projection) are documented in `scripts/db/README.md` and `../docs/projection.md`.

## Deployment (Vercel)
- Import the repository into Vercel.
- **Root Directory: `web`**
- Framework preset: Next.js (auto-detected). No custom build/output settings.
- Configure the server-side variables from `.env.example`; the live API requires
  a reachable database and populated customer projection.
