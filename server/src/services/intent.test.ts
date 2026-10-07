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

const { detectIntent, stripPastVaccinationMention, stripIllnessRecoveryMention } = await import("./intent");

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

  // ภาพ 2 verbatim (live-test failure after the first push): never says
  // "วัคซีน"/"ฉีด" at all — only "ครบ 2 เดือน...กำหนดล่าช้า", relying on the
  // age-milestone phrasing as the vaccine-context signal instead of the literal
  // word. The first version of isVaccineDelayQuestion required the literal word
  // and missed this, falling through all the way to the generic fallback menu.
  it("routes the ภาพ 2 verbatim message to VACCINE_DELAY with no literal วัคซีน/ฉีด word", async () => {
    const r = await detectIntent("ลูกครบ 2 เดือน วันที่ 16 กำหนดล่าช้าได้กี่วัน");
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

describe("detectIntent — round 4 bug fixes", () => {
  // Priority 1 (medical safety), ภาพ 7 ซ้าย verbatim: a typo for "โดนแมวข่วน" (cat scratch)
  // used to be read as a generic "มีวัคซีน...ไหม" availability question and show the
  // age-picker — now must win over every other intent.
  it("routes the ภาพ 7 verbatim animal-scratch typo to ANIMAL_BITE, not a vaccine question", async () => {
    const r = await detectIntent("มีวัคซีนแมวช่วนไหม");
    expect(r.intent).toBe("ANIMAL_BITE");
  });

  it("routes a correctly-spelled dog bite to ANIMAL_BITE", async () => {
    const r = await detectIntent("ลูกโดนหมากัดที่ขา ต้องทำยังไง");
    expect(r.intent).toBe("ANIMAL_BITE");
  });

  // Priority 2, ภาพ 3 verbatim (both messages): an explicit day+month+year, and a
  // bare weekday name, embedded in a free-form sentence — must resolve directly
  // instead of asking the user to retype as "วันที่ 12".
  it("resolves an explicit day+month+year embedded in a sentence to CLINIC_STATUS_SPECIFIC_DATE", async () => {
    const r = await detectIntent("วันอาทิตย์ที่ 27 ก.ย.69 เปิดช่วงเย็นไหม");
    expect(r.intent).toBe("CLINIC_STATUS_SPECIFIC_DATE");
    expect(r.resolvedDate).toBe("2026-09-27");
  });

  it("resolves a bare weekday-only status question to CLINIC_STATUS_SPECIFIC_DATE instead of CLINIC_DATE_UNCLEAR", async () => {
    const r = await detectIntent("วันอาทิตย์เปิดมั้ย");
    expect(r.intent).toBe("CLINIC_STATUS_SPECIFIC_DATE");
    expect(r.resolvedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // Regression: a bare weekday with no open/close question word must not be
  // hijacked — e.g. "เวลาทำการวันจันทร์" still belongs to CLINIC_TIME.
  it("still routes 'เวลาทำการวันจันทร์' to CLINIC_TIME, not a resolved weekday date", async () => {
    const r = await detectIntent("เวลาทำการวันจันทร์กี่โมงคะ");
    expect(r.intent).toBe("CLINIC_TIME");
  });

  // Priority 3, ภาพ 5 ขวา verbatim: "next dose" timing question must not be
  // swallowed by apptChange's bare "นัด".
  it("routes the ภาพ 5 ขวา verbatim next-dose question to VACCINE_NEXT_DOSE, not APPOINTMENT_CHANGE", async () => {
    const r = await detectIntent("อยากให้นัดวัคซีนตัวต่อไป ต้องไปฉีดเมื่อไหร่");
    expect(r.intent).toBe("VACCINE_NEXT_DOSE");
  });

  // Regression: a genuine reschedule request must still win.
  it("still routes a plain reschedule request to APPOINTMENT_CHANGE (round 4 regression)", async () => {
    const r = await detectIntent("เลื่อนนัดได้ไหมคะ");
    expect(r.intent).toBe("APPOINTMENT_CHANGE");
  });

  // Priority 3, ภาพ 5 ซ้าย verbatim fragment: "ครึ่ง" (half-year) age parsing + the
  // widened vaccine gate (now also triggers on "ฉีด", not just "วัคซีน").
  it("routes the ภาพ 5 ซ้าย verbatim question to a vaccine-info intent with ageMonths=18 (1.5 years)", async () => {
    const r = await detectIntent("วันนี้เข้าไปฉีด 1 ขวบครึ่งได้ไหม");
    expect(r.intent).toBe("VACCINE_INFO");
    expect(r.ageMonths).toBe(18);
  });

  it("parseAgeMonths understands 'X ปีครึ่ง' / 'X ขวบครึ่ง'", async () => {
    const { parseAgeMonths } = await import("./intent");
    expect(parseAgeMonths("1 ปีครึ่ง")).toBe(18);
    expect(parseAgeMonths("2 ขวบครึ่ง")).toBe(30);
  });

  // Priority 3, ภาพ 1 verbatim: a dose-count follow-up question with zero vaccine
  // signal of its own — answered generically rather than falling to fallback.
  it("routes the ภาพ 1 verbatim dose-count question to VACCINE_DOSE_COUNT_QUESTION", async () => {
    const r = await detectIntent("แบบ2เข็มกับเข็มเดียวต่างกันไม่คะ");
    expect(r.intent).toBe("VACCINE_DOSE_COUNT_QUESTION");
  });

  // Priority 3, ภาพ 8-9 (illustrative — exact screenshot wording unavailable): a lab
  // test question must not fall through to the fallback menu, and must not steal a
  // legitimate RSV *vaccine* question (bare "RSV" with no "ตรวจ" nearby).
  it("routes a blood-draw/lab-test question to LAB_TEST_INQUIRY", async () => {
    const r = await detectIntent("อยากสอบถามเรื่องเจาะเลือดตรวจค่ะ ต้องทำยังไงบ้าง");
    expect(r.intent).toBe("LAB_TEST_INQUIRY");
  });

  it("routes a 'ตรวจ RSV' question to LAB_TEST_INQUIRY", async () => {
    const r = await detectIntent("อยากตรวจ RSV ให้น้องค่ะ");
    expect(r.intent).toBe("LAB_TEST_INQUIRY");
  });

  it("still routes a plain bare-RSV vaccine question into the vaccine gate, not LAB_TEST_INQUIRY", async () => {
    const r = await detectIntent("RSV ราคาเท่าไหร่คะ");
    expect(r.intent).not.toBe("LAB_TEST_INQUIRY");
  });

  // Live-test fail: the original LAB_TEST_PATTERN required "ตรวจ" and "RSV" to sit
  // directly next to each other (whitespace only) — real questions almost always
  // have a word in between ("ตรวจหาเชื้อ", "ตรวจว่ามี"), and parents naturally
  // describe symptoms in the same sentence as the reason for asking, which used to
  // let MEDICAL_QUESTION win once the (too-strict) LAB_TEST_PATTERN failed to match
  // — NOT an ordering bug (LAB_TEST_INQUIRY is checked well before MEDICAL_QUESTION
  // unconditionally), purely a pattern-strictness one.
  it("routes 'ตรวจหาเชื้อ RSV' (a word between ตรวจ and RSV) to LAB_TEST_INQUIRY, not MEDICAL_QUESTION, even with symptom words present", async () => {
    const r = await detectIntent("ลูกไอมีเสมหะ มีน้ำมูก อยากตรวจหาเชื้อ RSV ให้ลูกด้วยค่ะ");
    expect(r.intent).toBe("LAB_TEST_INQUIRY");
  });

  it("routes 'ตรวจว่ามี RSV ไหม' to LAB_TEST_INQUIRY", async () => {
    const r = await detectIntent("อยากตรวจว่ามี RSV ไหมคะ");
    expect(r.intent).toBe("LAB_TEST_INQUIRY");
  });

  // Priority 4, ภาพ 2 ซ้าย verbatim: asking about medicine (not the vaccine) for a
  // disease that also happens to be a vaccine name.
  it("routes the ภาพ 2 ซ้าย verbatim medicine question to PRODUCT_STOCK_INQUIRY, not a vaccine price", async () => {
    const r = await detectIntent("มียาไข้หวัดใหญ่ไหม");
    expect(r.intent).toBe("PRODUCT_STOCK_INQUIRY");
  });

  // Priority 4, ภาพ 4 ซ้าย verbatim: "อยู่ตรงไหน" phrasing (not the bare "อยู่ไหน" already covered).
  it("routes the ภาพ 4 ซ้าย verbatim location question to LOCATION", async () => {
    const r = await detectIntent("คลีนิคอยู่ตรงไหนคะ");
    expect(r.intent).toBe("LOCATION");
  });

  // Priority 4, ภาพ 6 ซ้าย (illustrative — exact screenshot wording unavailable): a
  // facility-policy question about sick/well zones must not be misread as the
  // parent reporting their own child's illness.
  it("does not treat a sick/well-zone policy question as MEDICAL_QUESTION", async () => {
    const r = await detectIntent("คลินิกแบ่งโซนเด็กป่วยกับไม่ป่วยยังไงคะ");
    expect(r.intent).not.toBe("MEDICAL_QUESTION");
  });

  // Regression: a real personal symptom report must still route correctly.
  it("still routes a real symptom report ('ลูกป่วยมีไข้') to MEDICAL_QUESTION", async () => {
    const r = await detectIntent("ลูกป่วยมีไข้ค่ะ");
    expect(r.intent).toBe("MEDICAL_QUESTION");
  });

  // ภาพ 7 ขวา verbatim: traced against real production data — the "penta" alias and
  // "ราคา" price keyword both already resolve correctly at the intent-routing layer
  // (see vaccine.test.ts for the actual root cause, which is a missing vaccine_rules
  // row, not a routing bug). This locks in that no keyword collision (NEXT_DOSE,
  // DOSE_COUNT_COMPARISON, apptChange's bare "นัด", MEDICAL_QUESTION, etc.) steals this
  // message at the routing layer — resolveVaccineGroup is mocked to return no group
  // here (no real DB in this test file), so this only proves the routing side, not the
  // DB-dependent group resolution itself.
  it("routes the ภาพ 7 ขวา verbatim message to a vaccine-price intent with ageMonths=4, no keyword collision", async () => {
    const r = await detectIntent("ขอสอบถามราคาวัคซีน Penta เข็มที่ 2 สำหรับเด็ก4 เดือน ค่ะ ราคาเข็มละเท่าไหร่คะ");
    expect(r.intent).toBe("VACCINE_PRICE");
    expect(r.ageMonths).toBe(4);
  });

  // ภาพ 5 ซ้าย verbatim (live-test fail): a past-tense, date-stamped "already
  // vaccinated" mention was winning over the real question at the end of the
  // sentence, because resolveVaccineGroup() does a plain substring scan with no
  // positional awareness — see the full explanation on stripPastVaccinationMention
  // in intent.ts. These test the pure helper directly (no DB needed); the
  // end-to-end alias-resolution behavior is covered separately in
  // intent.vaccineAliasContext.test.ts, which mocks realistic alias rows.
  it("strips text up to and including a DD/MM/YY date when 'ฉีด' precedes it (past-vaccination record)", () => {
    const stripped = stripPastVaccinationMention(
      "น้องพราฉีดวัคซีนไข้หวัดใหญ่19/4/69 วันนี้จะเข้าไปฉีดวัคซีน 1 ขวบครึ่งได้ไหมค่ะ",
    );
    expect(stripped.trim()).toBe("วันนี้จะเข้าไปฉีดวัคซีน 1 ขวบครึ่งได้ไหมค่ะ");
    expect(stripped).not.toContain("ไข้หวัดใหญ่");
  });

  it("leaves text unchanged when a date is present but 'ฉีด' does not precede it", () => {
    const text = "นัดหมอวันที่ 19/4/69 ค่ะ วัคซีนไข้หวัดใหญ่ราคาเท่าไหร่คะ";
    expect(stripPastVaccinationMention(text)).toBe(text);
  });

  it("leaves text unchanged when there is no DD/MM/YY-style date at all", () => {
    const text = "วัคซีนไข้หวัดใหญ่ราคาเท่าไรคะ";
    expect(stripPastVaccinationMention(text)).toBe(text);
  });
});

describe("detectIntent — round 5 bug fixes", () => {
  // เคส 1 verbatim: "โลเคชั่น" (the transliterated loanword) was missing from the
  // location keyword list — only "อยู่ไหน"/"อยู่ตรงไหน" existed (round 4).
  it("routes the เคส 1 verbatim 'โลเคชั่น' question to LOCATION", async () => {
    const r = await detectIntent("ขอโลเคชั่น คลินิคหน่อยค่า");
    expect(r.intent).toBe("LOCATION");
  });

  // เคส 2 verbatim (2nd message): "ต้องเว้นวัคซีนหรือไปฉีดได้ตามปกติคะ" — a post-illness
  // vaccination-timing question. Medical safety: must NEVER assert a specific number of
  // days — must defer to a doctor, same as VACCINE_DELAY's existing DOCTOR_REFERRAL answer.
  it("routes the เคส 2 verbatim post-illness timing question to VACCINE_DELAY (medical safety — defers to a doctor, asserts no day count)", async () => {
    const r = await detectIntent("ต้องเว้นวัคซีนหรือไปฉีดได้ตามปกติคะ");
    expect(r.intent).toBe("VACCINE_DELAY");
  });

  // stripIllnessRecoveryMention() pure-function tests — the actual mechanism behind
  // เคส 2's 1st message (น้องเพิ่งหายจาก rsv). End-to-end alias-resolution behavior
  // (that "rsv" no longer resolves vaccineGroup) is covered in
  // intent.vaccineAliasContext.test.ts, which mocks a realistic alias row.
  it("strips a Latin-letter disease code immediately following 'เพิ่งหายจาก'", () => {
    expect(stripIllnessRecoveryMention("น้องเพิ่งหายจาก rsv").trim()).toBe("น้อง");
  });

  it("strips a Latin-letter disease code immediately following 'หายจาก'", () => {
    expect(stripIllnessRecoveryMention("น้องหายจาก covid มาค่ะ")).not.toContain("covid");
  });

  it("does not touch a Thai vaccine name later in the same message (only strips the word immediately after the marker)", () => {
    // Deliberately scoped to Latin letters only (see the comment on
    // ILLNESS_RECOVERY_PATTERN in intent.ts) — this locks in that scoping so a
    // future broadening doesn't accidentally eat a real vaccine name elsewhere
    // in the sentence, since Thai text often has no spaces between clauses.
    const text = "น้องหายจากไข้แล้ว อยากฉีดวัคซีนไข้หวัดใหญ่ค่ะ";
    expect(stripIllnessRecoveryMention(text)).toContain("วัคซีนไข้หวัดใหญ่");
  });

  it("leaves text unchanged when there is no illness-recovery marker at all", () => {
    const text = "วัคซีน RSV ราคาเท่าไหร่คะ";
    expect(stripIllnessRecoveryMention(text)).toBe(text);
  });
});

describe("detectIntent — review request (2026-10-07)", () => {
  it.each(["รีวิว", "ขอลิงก์รีวิวค่ะ", "อยากรีวิวคลินิกค่ะ"])("routes '%s' to REVIEW_REQUEST", async (m) => {
    expect((await detectIntent(m)).intent).toBe("REVIEW_REQUEST");
  });
  it("does not hijack vaccine questions that mention 'รีวิว'", async () => {
    expect((await detectIntent("รีวิววัคซีนไอพีวีหน่อยค่ะ")).intent).not.toBe("REVIEW_REQUEST");
  });
  it("does not hijack booking", async () => {
    expect((await detectIntent("จองคิวค่ะ")).intent).toBe("BOOKING_MENU");
  });
});
