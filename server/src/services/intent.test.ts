import { describe, it, expect, vi } from "vitest";

// intent.ts pulls in ../lib/supabase (Supabase client, needs real env vars) and
// ../lib/env (throws if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are unset) — mock
// both so this test runs without any real credentials or network access.
// resolveVaccineGroup() always resolves to "no group found" via the empty array.
vi.mock("../lib/supabase", () => ({
  admin: { from: () => ({ select: () => Promise.resolve({ data: [] }) }) },
}));
vi.mock("../lib/env", () => ({
  env: { geminiKey: "", geminiModel: "" },
}));

const { detectIntent } = await import("./intent");

describe("detectIntent — round 2 bug fixes", () => {
  // Issue 5: "ขี้ตา" used to fall through to the general-menu fallback instead of
  // getting the doctor-referral MEDICAL_QUESTION answer.
  it("routes eye discharge ('ขี้ตา') to MEDICAL_QUESTION", async () => {
    const r = await detectIntent("น้องเป็นขี้ตารักษาไหมคะ");
    expect(r.intent).toBe("MEDICAL_QUESTION");
  });

  it("routes bare 'ตุ่ม' to MEDICAL_QUESTION", async () => {
    const r = await detectIntent("มีตุ่มขึ้นที่แขนน้องค่ะ");
    expect(r.intent).toBe("MEDICAL_QUESTION");
  });

  // Issue 2: package-price questions should not fall into the no-group vaccine
  // gate (which used to show the age picker instead of answering the question).
  it("routes package-price questions to VACCINE_PACKAGE", async () => {
    const r = await detectIntent("แพ็กเกจวัคซีนราคาเท่าไหร่คะ");
    expect(r.intent).toBe("VACCINE_PACKAGE");
  });

  // Issue 4: a broad "how do I get started" question (no age/vaccine named)
  // should get the simple clinic-visit answer, not the age-picker card.
  it("routes a vague 'how do I get vaccinated' question to VACCINE_GENERAL_INFO", async () => {
    const r = await detectIntent("สนใจไปฉีดวัคซีนต้องทำไงคะ");
    expect(r.intent).toBe("VACCINE_GENERAL_INFO");
  });

  // Same issue, negative case: an age-specific question must keep going through
  // the existing age-picker/VACCINE_INFO path, not get swallowed by the new
  // general-info pattern above.
  it("still routes an age-specific vaccine question to VACCINE_INFO", async () => {
    const r = await detectIntent("ลูกอายุ 6 เดือน ต้องฉีดวัคซีนอะไรบ้าง");
    expect(r.intent).toBe("VACCINE_INFO");
    expect(r.ageMonths).toBe(6);
  });

  // Regression: plain price questions must still resolve normally.
  it("still routes a plain vaccine price question to VACCINE_PRICE", async () => {
    const r = await detectIntent("วัคซีนไข้หวัดใหญ่ราคาเท่าไรคะ");
    expect(r.intent).toBe("VACCINE_PRICE");
  });
});
