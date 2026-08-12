# BAANDEK Vaccine Bot — Supabase Migration

LINE + Messenger vaccine advisory + appointment bot for บ้านเด็กคลินิก.
Migrated from Google Apps Script + Sheets → **Supabase + Hono (Bun) + React**.

## Quick start
```bash
cp .env.example .env      # fill in Supabase + LINE + FB + Gemini keys
# 1) DB
#    run db/schema.sql in Supabase SQL editor
#    python3 etl/etl.py --db-dir ./vaccine_db --out db/seed.sql --report db/dq_report.txt
#    run db/seed.sql
# 2) Backend
cd server && bun install && bun run dev     # http://localhost:8080/health
# 3) Dashboard
cd web && bun install && bun run dev
```

## Why the rebuild
| | Old (Apps Script) | New (Hono + Supabase) |
|---|---|---|
| Response | 8–16s, 96% timeout | <1s, ~0% |
| Vaccine logic | 14 hardcoded builders | 1 data-driven fn + DB rows |
| Code | 8,500 LOC | ~3,000 LOC |
| Intent | brittle regex cascade | alias table + Gemini fallback |

See `CLAUDE.md` for rules, `TASKS.md` for the phase plan.

## Structure
- `db/`      schema.sql, seed.sql, dq_report.txt
- `etl/`     Sheets HTML → Supabase importer
- `server/`  Hono API + LINE/Messenger webhooks (→ Render)
- `web/`     React dashboard (→ Vercel)
