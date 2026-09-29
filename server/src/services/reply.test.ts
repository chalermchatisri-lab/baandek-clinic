import { describe, it, expect, vi } from "vitest";

// reply.ts pulls in Supabase (via config()/admin.from()) and several sibling
// services — mock everything so this test runs without real credentials or
// network access, same approach as intent.test.ts.
vi.mock("../lib/supabase", () => {
  // Minimal chainable query-builder stub: every method returns itself so
  // arbitrary .select().eq().maybeSingle() / .select().eq().gte().order().limit()
  // chains work, and the chain is thenable so `await` on any link resolves.
  function makeQuery(result: unknown) {
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      or: () => q,
      gte: () => q,
      lte: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (v: unknown) => void) => resolve(result),
    };
    return q;
  }
  return { admin: { from: () => makeQuery({ data: null }) } };
});
vi.mock("../lib/env", () => ({
  env: { supabaseUrl: "https://example.supabase.co", liffId: "" },
}));
vi.mock("./vaccine", () => ({
  buildVaccineAdvice: vi.fn(),
  DOCTOR_REFERRAL: "DOCTOR_REFERRAL",
  buildAgeGroupVaccineList: vi.fn().mockResolvedValue("MOCK_1Y_VACCINE_LIST"),
  buildAgeCardFlex: vi.fn(),
  BRAND_GREEN: "#000", BRAND_GREEN_DARK: "#000", BRAND_CREAM: "#fff",
  TEXT_DARK: "#000", TEXT_MUTED: "#666",
}));
vi.mock("./clinicStatus", () => ({
  getClinicStatus: vi.fn().mockResolvedValue({
    date: "2026-09-27", isOpen: true, sessions: [{ open: "09:00", close: "17:00" }],
    text: "วันอาทิตย์ที่ 27 ก.ย. 2569 คลินิกเปิดค่ะ 🕘\nเวลา 09:00–17:00 น.",
  }),
}));
vi.mock("./stock", () => ({
  findSpecificStockMatches: vi.fn(), getPriorityStockOverview: vi.fn(),
  buildSpecificStockReply: vi.fn(), buildOverviewStockReply: vi.fn(),
}));
vi.mock("../lib/symptomContext", () => ({
  markSymptomContext: vi.fn(), hasSymptomContext: () => false, clearSymptomContext: vi.fn(),
}));

const appointmentCheck = await import("./appointmentCheck");
vi.spyOn(appointmentCheck, "buildAppointmentResultByPhone").mockResolvedValue({
  found: true,
  text: "นัดหมายที่กำลังจะถึงของคุณ เฉอลินน์ ค่ะ\n\n📅 20 ก.ย. 2569 เวลา 10:00\n   วัคซีน",
});

const { buildReplyMessages } = await import("./reply");

// Round 3, ภาพ 1 (ด่วน/PDPA): a parent on FB Messenger typed a phone number and
// the bot answered with the child's real name + appointment dates, directly on
// FB — checking/telling real appointment data must only ever happen on LINE OA.
describe("buildReplyMessages — PDPA: real appointment data must never reach Messenger", () => {
  it("does not call the phone lookup and does not leak appointment data when a phone number is sent on messenger", async () => {
    const msgs = await buildReplyMessages("0918239450", "messenger", "fb-user-1");
    expect(appointmentCheck.buildAppointmentResultByPhone).not.toHaveBeenCalled();
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).not.toContain("เฉอลินน์");
    expect(combined).not.toContain("นัดหมายที่กำลังจะถึง");
    expect(combined.toLowerCase()).toContain("line");
  });

  it("still looks up and returns real appointment data for a complete phone number on line", async () => {
    const msgs = await buildReplyMessages("0918239450", "line", "line-user-1");
    expect(appointmentCheck.buildAppointmentResultByPhone).toHaveBeenCalledWith("0918239450");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("เฉอลินน์");
  });

  it("redirects to LINE OA for the 'เช็คนัดหมาย' menu button on messenger instead of prompting for a phone number", async () => {
    const msgs = await buildReplyMessages("เช็คนัดหมาย", "messenger", "fb-user-2");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined.toLowerCase()).toContain("line");
    expect(combined).not.toContain("พิมพ์เบอร์โทรศัพท์ที่ลงทะเบียนนัดหมายไว้");
  });

  it("still prompts for a phone number for 'เช็คนัดหมาย' on line", async () => {
    const msgs = await buildReplyMessages("เช็คนัดหมาย", "line", "line-user-2");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("พิมพ์เบอร์โทรศัพท์ที่ลงทะเบียนนัดหมายไว้");
  });
});

// Round 4 integration smoke tests — these exercise the full buildReplyMessages
// path (detectIntent + the reply.ts case) for the new round-4 intents, since
// intent.test.ts only checks routing, not that the reply case itself runs
// without throwing against its real dependencies (config(), buildAgeGroupVaccineList, etc.).
describe("buildReplyMessages — round 4 new intents render without throwing", () => {
  it("ANIMAL_BITE renders the verbatim first-aid text", async () => {
    const msgs = await buildReplyMessages("มีวัคซีนแมวช่วนไหม", "messenger", "u1");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("ล้างแผลด้วยน้ำสะอาดและสบู่ทันที 15 นาที");
    expect(combined).toContain("พิษสุนัขบ้าและบาดทะยัก");
  });

  it("VACCINE_NEXT_DOSE renders the data-driven 1-year list and the 1-month spacing rule", async () => {
    const msgs = await buildReplyMessages("อยากให้นัดวัคซีนตัวต่อไป ต้องไปฉีดเมื่อไหร่", "line", "u2");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("MOCK_1Y_VACCINE_LIST");
    expect(combined).toContain("อย่างน้อย 1 เดือน");
  });

  it("VACCINE_DOSE_COUNT_QUESTION renders the generic deflection", async () => {
    const msgs = await buildReplyMessages("แบบ2เข็มกับเข็มเดียวต่างกันไม่คะ", "line", "u3");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("ระบุชื่อวัคซีนที่สอบถาม");
  });

  it("LAB_TEST_INQUIRY renders the factual swab-test answer, not a staff-contact deflection", async () => {
    const msgs = await buildReplyMessages("อยากตรวจ RSV ให้น้องค่ะ", "line", "u4");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("Swab จมูก");
    expect(combined).toContain("ไม่มีบริการเจาะเลือด");
  });

  it("CLINIC_STATUS_SPECIFIC_DATE with a resolvedDate (weekday parsed from a sentence) renders the status text", async () => {
    const msgs = await buildReplyMessages("วันอาทิตย์เปิดมั้ย", "line", "u5");
    const combined = msgs.map((m) => (m.type === "text" ? m.text : "")).join("\n");
    expect(combined).toContain("คลินิกเปิดค่ะ");
  });
});
