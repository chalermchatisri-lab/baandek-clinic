# บ้านเด็กคลินิก — Admin Dashboard

React + Vite + Tailwind + Supabase. Internal CRUD for the vaccine bot data and the
clinic landing-page content.

## Run
```bash
cp .env.example .env      # already points at the Vaccine-CBC project
npm install
npm run dev
```

## Deploy (Vercel)
- Framework preset: **Vite**
- Build: `npm run build`  ·  Output: `dist`
- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

## Access
Accounts are created in Supabase → Authentication → Users. Any authenticated user
gets full CRUD via the `*_auth_all` RLS policies; the anon key alone is read-only.

## Add a table/column to the UI
Edit `src/lib/tables.ts` only — the list, form, validation and delete are generated
from that config. No component changes needed.
