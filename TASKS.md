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
- [x] **Round 4 — CLOSED (29 ก.ย. 2569, live-tested end to end)**:
      Priority 1 (animal-bite safety intent), Priority 2 (embedded date/weekday
      parsing), Priority 3 ภาพ 5 ซ้าย/ขวา (`stripPastVaccinationMention()` +
      next-dose question), Priority 3 ภาพ 8-9 (LAB_TEST_INQUIRY, pattern
      widened + rewritten as a factual swab-test answer), Priority 4 (4/4:
      medicine-vs-vaccine, "อยู่ตรงไหน", sick-zone policy question, Penta DB
      fix) — all live-tested and passing. Priority 3 ภาพ 1 (follow-up dose-
      count question) intentionally left as a generic deflection, not a full
      fix — Yai accepted this; true fix needs cross-message memory (see
      backlog below).
      Human-handoff mute (`lib/humanHandoff.ts`): `message_echoes` enabled in
      the Meta App Dashboard (29 ก.ย., 20:47) — feature is active, but
      **could not be verified by a staged test** (Yai and Aey are both Page
      admins; Facebook doesn't deliver echo webhooks for an admin's own
      messages — same lesson as the round-2 "จองคิว" test). Needs verification
      from the next real event where a non-admin staff member replies
      manually — check Render logs for the mute firing, don't stage it.
- [ ] Backlog: **cross-message context memory** — a follow-up question with no
      vaccine name of its own (e.g. round 4 ภาพ 1: "แบบ2เข็มกับเข็มเดียวต่าง
      กันไม่คะ" right after asking about flu vaccine pricing) can't be answered
      specifically without remembering the prior message. Same shape of state
      as `symptomContext.ts`/`humanHandoff.ts` (in-memory TTL map) but scoped
      to "last vaccine group discussed" per user. Deliberately out of scope for
      rounds 4-5; a real feature for its own round, not a quick fix.
- [ ] Fix pushed, **not yet live-tested** (round 5, 30 ก.ย. 2569): 2 cases.
      **เคส 1**: verbatim "ขอโลเคชั่น คลินิคหน่อยค่า" fell to fallback — the
      transliterated loanword "โลเคชั่น" was missing from the location keyword
      list (round 4 added "อยู่ตรงไหน" but not this). Added.
      **เคส 2 (medical safety)**: two real back-to-back messages. (1) "น้องเพิ่ง
      หายจาก rsv" (purely a statement — no question, no price word at all) was
      answered with RSV vaccine pricing — same bug class as round 4's ภาพ 5
      ซ้าย (plain substring alias matching with no narrative-context
      awareness), but for an illness-recovery clause instead of an
      already-vaccinated one. Added `stripIllnessRecoveryMention()`, a sibling
      to `stripPastVaccinationMention()` — deliberately scoped to Latin-letter
      disease codes only (not Thai script), because Thai text often has no
      spaces between clauses and a broader match risked eating a real vaccine
      name mentioned later in the same message; locked in by a test that
      checks exactly that. With nothing else in the message actionable, it now
      correctly falls through to the safe generic fallback instead of a
      confidently wrong price.
      (2) "ต้องเว้นวัคซีนหรือไปฉีดได้ตามปกติคะ" (asking how long to wait after
      illness before vaccinating) fell to the generic age-picker menu — it has
      "วัคซีน"/"ฉีด" but no vaccine name or age, so it hit the vaccine gate's
      empty-info fallback. **Per Yai's explicit medical-safety requirement,
      the bot must never assert a specific number of days** — this needed the
      same "defer to a doctor" answer already used for vaccine-delay
      questions, not a new number to invent. Reused `isVaccineDelayQuestion()`
      → `VACCINE_DELAY` → the existing `DOCTOR_REFERRAL` text (added "เว้น
      วัคซีน"/"พักวัคซีน"/etc. as additional delay markers) rather than adding
      a parallel intent with a duplicate answer.
      73 tests pass, typecheck clean. Needs a live-test before this can be closed.

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
