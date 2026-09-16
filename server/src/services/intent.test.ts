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

describe("detectIntent — round 3 bug fixes", () => {
  // ภาพ 2: a "how many days can this dose be delayed" question that also names a
  // specific day-of-month must not be hijacked by CLINIC_STATUS_SPECIFIC_DATE.
  it("routes a vaccine-delay question to VACCINE_DELAY, not a specific-date clinic-hours lookup", async () => {
    const r = await detectIntent("ลูกครบ 2 เดือนวันที่ 16 ต้องฉีดวันนั้นเลยหรือล่าช้าได้กี่วัน");
    expect(r.intent).toBe("VACCINE_DELAY");
  });

  it("routes a plain 'delay a dose' phrasing to VACCINE_DELAY", async () => {
    const r = await detectIntent("เลื่อนฉีดวัคซีนได้กี่วันคะ");
    expect(r.intent).toBe("VACCINE_DELAY");
  });

  // Negative case: an actual appointment-reschedule request must still win over
  // the new delay pattern (no "กี่วัน"/"ล่าช้า" here, so isVaccineDelayQuestion
  // should not fire, and apptChange's "เลื่อนนัด" keeps matching as before).
  it("still routes a plain reschedule request to APPOINTMENT_CHANGE", async () => {
    const r = await detectIntent("ขอเลื่อนนัดค่ะ");
    expect(r.intent).toBe("APPOINTMENT_CHANGE");
  });

  // ภาพ 4 verbatim (verified against the real reported message, not a paraphrase):
  // contains both "นัดวันที่15" (day-of-month) AND "วัคซีน..." — must still resolve
  // to APPOINTMENT_CHANGE via apptChange's bare "นัด" keyword, which is checked
  // before the ภาพ 2/6 guards (isVaccineDelayQuestion / SPECIFIC_DATE_DISTRACTOR_PATTERN)
  // ever run, so those guards must not be able to steal this one.
  it("routes the ภาพ 4 verbatim reschedule message to APPOINTMENT_CHANGE despite a day-of-month + vaccine mention", async () => {
    const r = await detectIntent(
      "คลินิกปิดหลังคะ ว่าจะไป18 พอดีป่าหมอนัดวันที่15 ติดธุระพอดีค่ะ ถ้าไปช่วงสัปดือน ได้ไหมคะป่าหมอ ของน้องเป็นวัคซีนไข้เลือดออกค่ะ",
    );
    expect(r.intent).toBe("APPOINTMENT_CHANGE");
  });

  // ภาพ 6: a day-of-month mention inside a vaccine/appointment-book question must
  // not be swallowed by the bare "วันที่ N" specific-date fast path either.
  it("does not treat a vaccine-record question naming a past date as CLINIC_STATUS_SPECIFIC_DATE", async () => {
    const r = await detectIntent(
      "แจ้งว่าฉีดรอบก่อนวันที่ 14 ก.ค. 2569 นัดใหม่ไม่มีเขียนในสมุด ครบ 2 เดือนแล้วเข้ามาได้เลยไหม",
    );
    expect(r.intent).not.toBe("CLINIC_STATUS_SPECIFIC_DATE");
  });

  // Regression: a genuine bare-date status question must still work.
  it("still routes a bare 'วันที่ N' status question to CLINIC_STATUS_SPECIFIC_DATE", async () => {
    const r = await detectIntent("วันที่ 12");
    expect(r.intent).toBe("CLINIC_STATUS_SPECIFIC_DATE");
    expect(r.specificDay).toBe(12);
  });

  // ภาพ 5: an age-specific vaccine price question must not be swallowed by the
  // generic "บริการ" (services) keyword when both appear in the same sentence.
  it("routes an age-specific vaccine price question to VACCINE_PRICE even when it says 'บริการ'", async () => {
    const r = await detectIntent("สอบถามบริการฉีดวัคซีนราคาเท่าไหร่คะ สำหรับเด็กอายุ 4 เดือน");
    expect(r.intent).toBe("VACCINE_PRICE");
    expect(r.ageMonths).toBe(4);
  });

  // Regression: a plain services question (no vaccine/ฉีด mention) still resolves.
  it("still routes a plain services question to SERVICES", async () => {
    const r = await detectIntent("มีบริการอะไรบ้างคะ");
    expect(r.intent).toBe("SERVICES");
  });
});
