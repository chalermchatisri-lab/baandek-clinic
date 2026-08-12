# CLAUDE.md — BAANDEK Vaccine Bot

> Migration of บ้านเด็กคลินิก LINE+Messenger vaccine bot from Google Apps Script + Sheets
> to **Supabase + Hono (Bun) + React**. This file is the single source of truth for Claude Code.

## 🔩 Iron Rules
1. **MVP first.** Ship the smallest working slice. No speculative features.
2. **Data over code.** Vaccine logic lives in `vaccine_rules` / `vaccines` rows — never hardcode per-vaccine builders (the #1 bloat in the old system).
3. **Secrets in env only.** Never commit tokens. `SUPABASE_SERVICE_ROLE_KEY` is backend-only.
4. **RLS is not optional.** PII tables (`patients`, `appointments`, `leads`) have no anon policy. Backend uses service role; dashboard uses authenticated; landing uses anon read.
5. **Reply fast.** Webhook handlers must ack within LINE's window. Do heavy work after ack; never block the reply.
6. **One helper, one place.** No `mb`/`vr` prefixed duplicates. Shared utils go in `server/src/lib`.
7. **Tests separate.** No `testXxx()` functions in production modules. Use Vitest under `*.test.ts`.
8. **ETL never drops silently.** `on conflict do nothing` can hide data loss when merging sheets (config keys, vaccine dose rows). Conflicting values MUST be preserved under a suffixed key and logged in `dq_report.txt`. Known collapses: config PHONE/ADDRESS/WEBSITE (→ `*_LINKS`), vaccines TETRA/PCV14 (per-dose Recommendation/Warning — dose 1 kept). Re-check dq_report after every re-seed.
9. **Checkpoint every green step** (see below).

## 🧱 Stack
- **DB:** Supabase (Postgres 15 + RLS + Storage)
- **Backend:** Bun + Hono → Render (Docker)
- **Dashboard:** React + Vite + TypeScript → Vercel
- **Bot channels:** LINE Messaging API, Facebook Messenger
- **AI:** Gemini (`GEMINI_MODEL`) — intent fallback only

## 📁 Structure
```
db/        schema.sql, seed.sql  (source of truth for DB)
server/    Hono API + webhooks + services
web/       React dashboard (CRUD)
etl/       one-off Sheets->Supabase importer
```

## 🤖 Sub-agents (call in order)
- `pm` — break requirement into tasks, update TASKS.md
- `backend` — Hono routes, Supabase queries, webhook logic
- `frontend` — React dashboard components
- `reviewer` — RLS check, no leaked secrets, DoD pass
> Preferred prompt: "[requirement] เอาแค่ MVP / ให้ pm วางแผนและเรียก sub agent ตามลำดับงาน"

## ✅ Definition of Done
- [ ] Types check (`bun run typecheck`), no `any` in new code
- [ ] RLS verified for any new table (anon cannot read PII)
- [ ] No secret in diff
- [ ] Webhook path replies < 1s locally
- [ ] Vitest green for changed logic
- [ ] TASKS.md updated + function inventory updated

## 🔁 Checkpoint commands
```bash
git add -A && git commit -m "checkpoint: <what changed>"   # after each green step
git push
```

## 🗂️ Function Inventory (living — update as you go)
### server/src/services/intent.ts
- `detectIntent(text)` — alias-table lookup + keyword fast-path, Gemini fallback
### server/src/services/vaccine.ts
- `buildVaccineAdvice(group, ageMonths)` — data-driven from vaccine_rules (replaces 14 Demo builders)
### server/src/lib/supabase.ts
- `admin` — service-role client (backend)
### server/src/routes/
- `line.ts` — POST /webhook/line
- `messenger.ts` — GET+POST /webhook/messenger
- `health.ts` — GET /health
