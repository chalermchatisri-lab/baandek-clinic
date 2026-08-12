# TASKS.md — BAANDEK Migration

## 🎯 Phase 0 — Analysis (DONE ✅)
- [x] Reverse-engineer Apps Script (8,500 LOC) + 22 sheets
- [x] Design normalized schema (18 tables)
- [x] ETL: dedupe patients, repair phones, explode aliases
- [x] Architecture diagram (old vs new)
- [x] Log to Notion (standalone page)

## 🚧 Phase 1 — Database
- [ ] Create Supabase project (account: mng.cs10)
- [ ] Run db/schema.sql
- [ ] Run etl.py → seed.sql, review, run seed.sql
- [ ] Verify RLS: anon cannot read patients/appointments/leads
- [ ] Review 10 flagged phone numbers (dq_report.txt)

## 🚧 Phase 2 — Backend (Hono)
- [ ] Scaffold Hono + Bun, /health green on Render
- [ ] LINE webhook: signature verify + reply < 1s
- [ ] intent.ts: alias-table lookup + keyword fast-path
- [ ] vaccine.ts: data-driven advice from vaccine_rules (kill 14 Demo builders)
- [ ] clinic status (hours + closures)
- [ ] appointment check by phone
- [ ] Gemini fallback for UNKNOWN intent
- [ ] Messenger webhook parity
- [ ] Retire Cloudflare Worker

## 🚧 Phase 3 — Dashboard (React)
- [ ] Auth (Supabase)
- [ ] CRUD: vaccines, vaccine_rules, promotions, clinic_hours, closures
- [ ] Appointments view (read + status update)
- [ ] Config editor (clinic_config)

## 🚧 Phase 4 — Cutover
- [ ] Point LINE/Messenger webhooks to Render
- [ ] Parallel-run 1 week, compare incident_log
- [ ] Retire Apps Script + PowerShell sync
- [ ] Decide: merge into MORFLOW (A) vs standalone (B)

## 🔗 To wire in
- [ ] Brother's Notion link
- [ ] Brother's GitHub repo (or confirm this repo canonical)
