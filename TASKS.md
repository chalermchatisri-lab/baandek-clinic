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
- [ ] **DB fix needed (round 4, ภาพ 7 ขวา — root-caused, NOT a code bug)**:
      verbatim "ขอสอบถามราคาวัคซีน Penta เข็มที่ 2 สำหรับเด็ก4 เดือน ค่ะ
      ราคาเข็มละเท่าไหร่คะ" → DOCTOR_REFERRAL instead of a price. Traced
      against the live production DB directly: alias "penta" already resolves
      to group_code=DTP_POLIO_COMBO correctly, "ราคา" keyword matches fine,
      ageMonths=4 parses fine (confirmed via intent.test.ts + a direct SQL
      trace) — the real cause is that **`vaccine_rules` has zero ACTIVE rows
      for vaccine_group='DTP_POLIO_COMBO'**, even though `vaccines` already
      has TETRA (฿1,400) / PENTA (฿1,600) / HEXA (฿1,900) all ACTIVE with real
      prices. `buildVaccineAdvice()` returns status "no_rules" before it ever
      reads those prices (see `vaccine.test.ts`, which locks in this exact
      mechanism). Not something `Penta`-alias-specific or "เข็มที่ 2"-specific
      at all — any price question for this group hits the same gap.
      **Fix is a DB insert, not a code change** — attempted it directly via
      the Supabase MCP but it was blocked by the auto-mode permission
      classifier as a shared-resource write (correct call for a live
      production DB). Yai needs to run this herself (Supabase SQL editor),
      mirroring the exact pattern already live for the PCV group (multiple
      same-age products → one no-age-restriction rule with a placeholder
      product_code that deliberately doesn't match any real product_code, so
      buildVaccineAdvice lists every product's own price instead of guessing
      one age/dose eligibility window we don't have clinic confirmation for):
      ```sql
      insert into vaccine_rules
        (rule_id, vaccine_group, product_code, min_age_months, max_age_months,
         primary_doses, interval_days, status, display_message, sort_order)
      values (
        'DTP_POLIO_COMBO_ALL_AGES', 'DTP_POLIO_COMBO', 'DTP_POLIO_COMBO',
        null, null, null, null, 'ACTIVE',
        'ราคาต่อเข็ม แนะนำให้ปรึกษาแพทย์เรื่องช่วงอายุและจำนวนเข็มที่เหมาะสมสำหรับน้อง',
        40
      );
      ```
      Once run, this should make any TETRA/PENTA/HEXA price question show all
      three prices as options rather than DOCTOR_REFERRAL — verified against
      `vaccine.test.ts`'s mocked version of this exact row shape, but needs a
      live-test after the real insert to confirm end-to-end.
- [ ] Follow-up (round 4, ภาพ 8 ขวา + 9, partial): added LAB_TEST_INQUIRY for
      "เจาะเลือด"/"ตรวจเลือด"/"ตรวจภูมิ"/"ตรวจ RSV" from the paraphrase — the
      "ยืนยันเวลาเปิด" (confirm opening hours) part of the same report wasn't
      addressed since it's already covered by CLINIC_STATUS/CLINIC_TIME and
      the exact failing phrasing is unknown; needs verbatim text to root-cause.

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
