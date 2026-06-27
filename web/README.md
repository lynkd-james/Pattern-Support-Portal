# Pattern Support Portal — Web (V1)

Next.js (App Router) read-only customer support dashboard.

## Local development
```bash
npm install
npm run dev      # http://localhost:3000  ->  redirects to /dashboard
npm run build    # production build
```

## Deployment (Vercel)
- Import the repository into Vercel.
- **Root Directory: `web`**
- Framework preset: Next.js (auto-detected). No custom build/output settings.
- V1 runs on mock data (`src/lib/api.ts` `USE_MOCK = true`); no environment variables required.
