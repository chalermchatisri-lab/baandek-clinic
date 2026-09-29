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
- [x] Human-handoff mute for Messenger (round 4, ภาพ 10 — built after 2nd
      real incident): `lib/humanHandoff.ts` + wired into `routes/messenger.ts`.
      Detects a staff member typing manually in Page Inbox via `message_echoes`
      (is_echo with no matching app_id) and suppresses ALL bot auto-replies to
      that PSID for 30 min (TTL re-arms on every further staff message). The
      bot's own Send API echoes (which carry app_id) are ignored, not treated
      as staff activity.
      **⚠️ Still needs one manual step outside this repo**: enable the
      `message_echoes` webhook field for this app in the Meta App Dashboard
      (Messenger settings → Webhooks → subscribed fields). Without it, echo
      events never reach this code and the mute never engages — code alone
      cannot verify this is on; check it before relying on this fix live.
- [x] **DB fix (round 4, ภาพ 7 ขวา) — DONE, live-tested ✅**: root cause was
      `vaccine_rules` having zero ACTIVE rows for `DTP_POLIO_COMBO` (not an
      alias or "เข็มที่ 2" bug — see `vaccine.test.ts` for the locked-in
      mechanism). Yai ran the `DTP_POLIO_COMBO_ALL_AGES` insert (git history
      has the exact SQL); live-tested — TETRA/PENTA/HEXA now correctly answer
      ฿1,400 / ฿1,600 / ฿1,900 instead of DOCTOR_REFERRAL.
- [ ] Fix pushed, **not yet live-tested** (round 4, ภาพ 5 ซ้าย — 1st live-test
      failed): verbatim "น้องพราฉีดวัคซีนไข้หวัดใหญ่19/4/69 วันนี้จะเข้าไปฉีด
      วัคซีน 1 ขวบครึ่งได้ไหมค่ะ" answered with flu-vaccine info instead of the
      1.5-year age-group vaccine list actually asked about. Root cause:
      `resolveVaccineGroup()` does a plain substring scan across the *whole*
      message with zero positional awareness — the past-tense, date-stamped
      "already vaccinated" clause ("ฉีดวัคซีนไข้หวัดใหญ่19/4/69") was the only
      alias match in the text, so it won even though the real question at the
      end names no specific vaccine. Added `stripPastVaccinationMention()`:
      when a DD/MM/YY-style date is preceded by "ฉีด", the alias search runs
      only on the text *after* that date. Deliberately narrow pattern (only
      slash-formatted dates, only when "ฉีด" precedes) to avoid touching the
      Thai-month-token date handling already done elsewhere. Covered by a
      pure-function unit test (`intent.test.ts`) plus a new
      `intent.vaccineAliasContext.test.ts` that mocks a realistic alias row to
      exercise `resolveVaccineGroup()` end-to-end (the shared `intent.test.ts`
      mock always returns an empty alias table, so it can't catch this class
      of bug on its own). Needs a live-test before this can be closed.
- [ ] Fix pushed, **not yet live-tested** (round 4, ภาพ 8-9 — 1st live-test
      failed, fixed in 2 parts): LAB_TEST_INQUIRY wasn't firing for real
      wording. **Not an ordering bug** — LAB_TEST_INQUIRY is checked well
      before MEDICAL_QUESTION unconditionally, confirmed by re-reading the
      live file. The real cause: `LAB_TEST_PATTERN` required "ตรวจ" and "RSV"
      to sit *directly* adjacent (whitespace only) — real phrasing like
      "ตรวจหาเชื้อ RSV"/"ตรวจว่ามี RSV" has a word in between and never
      matched, so it fell through to a genuine symptom-word match instead
      (parents naturally describe symptoms in the same message). Widened to
      tolerate up to ~15 Thai chars/spaces between the two words.
      Separately, Yai confirmed the clinic tests RSV/COVID-19/influenza by
      nasal swab only — **no blood-draw service at all** — so the old reply
      ("please ask staff directly") was a needless deflection for something
      answerable outright. Rewrote it as a direct factual statement (what's
      tested, the method, and that blood draws aren't offered), still without
      inventing a price (none exists in `services`/`clinic_config` — asks the
      customer to call for that instead of guessing). Checked whether this
      belonged in the `services` table first (Iron Rule "data over code") —
      that table's 3 rows are broad category cards for a different display,
      not wired into this reply path, so treated this as a clinic-policy
      fact hardcoded the same way DOCTOR_REFERRAL/APPOINTMENT_CHANGE already
      are, not a data gap.
      Still open from the original report and unaddressed: the "ยืนยันเวลา
      เปิด" (confirm opening hours) part — already covered by CLINIC_STATUS/
      CLINIC_TIME in principle, exact failing phrasing unknown; needs
      verbatim text to root-cause if it's still failing live.

## 🚧 Phase 3 — Dashboard (React)
- [ ] Auth (Supabase)
- [ ] CRUD: vaccines, vaccine_rules, promotions, clinic_hours, closures
- [ ] Appointments view (read + status update)
- [ ] Config editor (clinic_config)
- [x] Confirm-password gate before save/update/delete on every CRUD page
      (`verify-admin-password` Edge Function checks `clinic_config.CRUD_ADMIN_PASSWORD`
      server-side; anon RLS on `clinic_config` now excludes that key)

## 🚧 Phase 4 — Cutover
- [ ] Point LINE/Messenger webhooks to Render
- [ ] Parallel-run 1 week, compare incident_log
- [ ] Retire Apps Script + PowerShell sync
- [ ] Decide: merge into MORFLOW (A) vs standalone (B)

## 🔗 To wire in
- [ ] Brother's Notion link
- [ ] Brother's GitHub repo (or confirm this repo canonical)
