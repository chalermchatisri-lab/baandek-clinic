import { describe, it, expect, vi } from "vitest";

// Separate file from intent.test.ts on purpose: intent.test.ts's module-level
// vi.mock("../lib/supabase") always returns an empty vaccine_aliases table, which
// is exactly why the round-4 ภาพ 5 ซ้าย bug (resolveVaccineGroup matching the wrong
// vaccine name from a past-tense, date-stamped clause instead of the real question)
// never showed up in that file's tests — group was always undefined there regardless
// of the fix. This file mocks a realistic alias row so detectIntent() actually
// exercises resolveVaccineGroup()'s real matching logic end-to-end.
vi.mock("../lib/supabase", () => ({
  admin: {
    from: () => ({
      select: () => Promise.resolve({
        data: [{ alias: "ไข้หวัดใหญ่", group_code: "INFLUENZA" }],
      }),
    }),
  },
}));
vi.mock("../lib/env", () => ({
  env: { geminiKey: "", geminiModel: "" },
}));

const { detectIntent } = await import("./intent");

describe("detectIntent — vaccine-alias context (round 4, ภาพ 5 ซ้าย, live-test fail)", () => {
  it("does not resolve vaccineGroup to the vaccine named only in a past-tense, date-stamped clause", async () => {
    const r = await detectIntent(
      "น้องพราฉีดวัคซีนไข้หวัดใหญ่19/4/69 วันนี้จะเข้าไปฉีดวัคซีน 1 ขวบครึ่งได้ไหมค่ะ",
    );
    expect(r.vaccineGroup).not.toBe("INFLUENZA");
    expect(r.ageMonths).toBe(18);
  });

  // Regression: the same alias must still resolve normally when it isn't preceded
  // by a past-tense "ฉีด...<date>" record — this is the ordinary, currently-working case.
  it("still resolves vaccineGroup normally for a plain (non-past-tense) mention", async () => {
    const r = await detectIntent("วัคซีนไข้หวัดใหญ่ราคาเท่าไรคะ");
    expect(r.vaccineGroup).toBe("INFLUENZA");
  });

  // Regression: a date present but NOT preceded by "ฉีด" must not strip anything —
  // the alias should still resolve. (Avoids the word "นัด" here on purpose — that
  // would be intercepted by apptChange earlier in detectIntent and never reach
  // resolveVaccineGroup at all, which is a different code path than this test targets.)
  it("still resolves vaccineGroup when a date is present but not part of a 'ฉีด...date' record", async () => {
    const r = await detectIntent("เมื่อวันที่ 19/4/69 มีเหตุการณ์อื่น วัคซีนไข้หวัดใหญ่ราคาเท่าไหร่คะ");
    expect(r.vaccineGroup).toBe("INFLUENZA");
  });
});
