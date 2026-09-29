import { describe, it, expect, vi } from "vitest";

// Mock table contents are swapped per test via `tables` below — buildVaccineAdvice()
// only ever calls .from("vaccine_rules")/.from("vaccines").select(...).eq(...).eq(...).order(...)
// or .select(...).eq(...).eq(...), both of which resolve directly (no further chaining
// needed beyond what's used in vaccine.ts), so a minimal chainable+thenable stub works.
let tables: Record<string, unknown[]> = {};
vi.mock("../lib/supabase", () => {
  function makeQuery(rows: unknown[]) {
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      then: (resolve: (v: unknown) => void) => resolve({ data: rows }),
    };
    return q;
  }
  return { admin: { from: (table: string) => makeQuery(tables[table] ?? []) } };
});

const { buildVaccineAdvice } = await import("./vaccine");

describe("buildVaccineAdvice", () => {
  // Round 4, ภาพ 7 ขวา verbatim ("ขอสอบถามราคาวัคซีน Penta เข็มที่ 2 สำหรับเด็ก4 เดือน ค่ะ
  // ราคาเข็มละเท่าไหร่คะ"): traced detectIntent() against the real production alias/price
  // data and confirmed the alias ("penta") and price keyword ("ราคา") both already resolve
  // correctly — vaccineGroup="DTP_POLIO_COMBO", ageMonths=4. The actual failure is here:
  // zero ACTIVE vaccine_rules rows exist for that group in production, so this function
  // short-circuits to "no_rules" BEFORE it ever reads the real vaccines.price data — reply.ts
  // then renders DOCTOR_REFERRAL instead of a price. This test locks in that exact mechanism
  // as a named, understood failure mode (not a mystery) rather than re-discovering it blind
  // next time a vaccine group is missing its rules row.
  it("returns status 'no_rules' (not an error) when a resolvable group has zero ACTIVE vaccine_rules rows — the real round-4 ภาพ 7 ขวา root cause", async () => {
    tables = {
      vaccine_rules: [],
      vaccines: [
        { product_code: null, price: 1600, name_th: "วัคซีนโปลิโอ คอตีบไอกรน บาดทะยัก ฮิป" }, // PENTA — real price exists but is never reached
      ],
    };
    const res = await buildVaccineAdvice("DTP_POLIO_COMBO", 4);
    expect(res.status).toBe("no_rules");
    expect(res.cards).toHaveLength(0);
  });

  // The proposed DB fix (see TASKS.md): one no-age-restriction vaccine_rules row whose
  // product_code deliberately does NOT match any real vaccines.product_code (same proven
  // pattern already live for the PCV group, which also offers several same-age products) —
  // this must surface every product's own distinct price as priceOptions, not collapse them
  // into one wrong price (a real risk here since all three vaccines.product_code are null
  // in production and would otherwise collide into a single Map key).
  it("with the proposed fix shape (no-age-restriction rule + a non-matching placeholder product_code), lists every product's own price instead of collapsing to one", async () => {
    tables = {
      vaccine_rules: [{
        rule_id: "DTP_POLIO_COMBO_ALL_AGES", vaccine_group: "DTP_POLIO_COMBO",
        product_code: "DTP_POLIO_COMBO", min_age_months: null, max_age_months: null,
        primary_doses: null, interval_days: null, display_message: "ราคาต่อเข็ม", doctor_review: null,
      }],
      vaccines: [
        { product_code: null, price: 1400, name_th: "วัคซีนโปลิโอ คอตีบไอกรน บาดทะยัก" }, // TETRA
        { product_code: null, price: 1600, name_th: "วัคซีนโปลิโอ คอตีบไอกรน บาดทะยัก ฮิป" }, // PENTA
        { product_code: null, price: 1900, name_th: "วัคซีนโปลิโอ คอตีบไอกรน บาดทะยัก ฮิป ตับอักเสบบี" }, // HEXA
      ],
    };
    const res = await buildVaccineAdvice("DTP_POLIO_COMBO", 4);
    expect(res.status).toBe("ok");
    expect(res.cards).toHaveLength(1);
    const opts = res.cards[0]!.priceOptions;
    expect(opts).toHaveLength(3);
    expect(opts).toContainEqual({ name: "วัคซีนโปลิโอ คอตีบไอกรน บาดทะยัก ฮิป", price: 1600 }); // PENTA specifically
    // The bug this guards against: without the placeholder, all-null product_code
    // vaccines collapse into one Map key and only one arbitrary price would show.
    const uniquePrices = new Set(opts!.map((o) => o.price));
    expect(uniquePrices.size).toBe(3);
  });

  // Regression: an age given with no matching rule still correctly refers to a doctor
  // rather than guessing (this is the policy the code is explicitly built to enforce).
  it("still returns 'no_rule_for_age' (not 'ok') when an age is given but no rule covers it", async () => {
    tables = {
      vaccine_rules: [{
        rule_id: "X", vaccine_group: "SOME_GROUP", product_code: "SOME_GROUP",
        min_age_months: 24, max_age_months: 60, primary_doses: 1, interval_days: null,
        display_message: null, doctor_review: null,
      }],
      vaccines: [{ product_code: "SOME_GROUP", price: 500, name_th: "Some Vaccine" }],
    };
    const res = await buildVaccineAdvice("SOME_GROUP", 4); // outside the 24-60 range
    expect(res.status).toBe("no_rule_for_age");
    expect(res.cards).toHaveLength(0);
  });
});
