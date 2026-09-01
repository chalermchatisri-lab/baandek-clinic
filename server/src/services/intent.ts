import { admin } from "../lib/supabase";
import { env } from "../lib/env";

export type Intent =
  | "APPOINTMENT_CHANGE"
  | "APPOINTMENT_CHECK"
  | "APPOINTMENT_CONFIRM"
  | "END_CONVERSATION"
  | "CLINIC_STATUS"
  | "CLINIC_STATUS_SPECIFIC_DATE"
  | "CLINIC_DATE_UNCLEAR"
  | "CLINIC_TIME"
  | "LOCATION"
  | "VACCINE_PRICE"
  | "VACCINE_AVAILABILITY"
  | "VACCINE_INFO"
  | "MEDICAL_QUESTION"
  | "PRODUCT_STOCK_INQUIRY"
  | "SERVICES"
  | "HOLIDAYS"
  | "NEWS"
  | "PROMOTIONS"
  | "VACCINE_NEWS"
  | "CLOSURE_ANNOUNCEMENT"
  | "CONTACT"
  | "BOOKING_MENU"
  | "UNKNOWN";

export interface IntentResult {
  intent: Intent;
  text: string;
  vaccineGroup?: string;   // resolved from vaccine_aliases when relevant
  ageMonths?: number | null;
  specificDay?: number;    // 1-31, set only for CLINIC_STATUS_SPECIFIC_DATE
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const has = (t: string, kws: string[]) => kws.some((k) => t.includes(k));

// Cheap keyword fast-paths (cover ~90% of traffic without an AI call).
const KW = {
  price: ["ราคา", "เท่าไร", "เท่าไหร่", "กี่บาท", "ค่าฉีด", "ค่าใช้จ่าย"],
  avail: ["มีไหม", "มีมั้ย", "มีรึเปล่า", "มีหรือเปล่า", "มีวัคซีน", "มีสต็อก"],
  status: ["เปิดไหม", "ปิดไหม", "หยุดไหม", "วันนี้เปิด", "ยังเปิด", "ไปทัน", "เปิด-ปิดวันนี้", "เปิดปิด", "เช็ควันทำการ"],
  // *** เพิ่ม 2026-09-01 (bug 3) ***: bare "เปิดไหม" ด้านบนพลาดคำถามจริงที่มีคำแทรกระหว่าง
  // เปิด/ปิด/หยุด กับ ไหม เช่น "เปิดปกติใช่ไหมคะ" (เจอจริง — ตกไป FALLBACK ทั้งที่ตอบได้)
  // ดู STATUS_QUESTION_PATTERN ด้านล่างไฟล์ — เป็น regex เสริม ไม่ได้แทนที่ literal list นี้
  time: ["เวลาทำการ", "เวลาเปิด", "กี่โมง", "ตารางเวลา"],
  location: ["ที่อยู่", "แผนที่", "อยู่ไหน", "ไปยังไง", "พิกัด", "การเดินทาง"],
  // "Check my appointment" — MUST be tested before apptChange (see detectIntent).
  // The booking-menu quick-reply button sends exactly "เช็คนัดหมาย", which contains
  // both "เช็คนัด" and "นัด"; those used to live in apptChange, so the button
  // dead-ended on APPOINTMENT_CHANGE (reschedule guidance) instead of prompting for
  // a phone number — the live bug after the LINE cutover. These check-phrasings now
  // belong here; the reschedule/"can't make it" phrasings stay in apptChange below.
  apptCheck: ["เช็คนัดหมาย", "เช็คนัด", "ตรวจสอบนัด", "เช็คคิว", "ดูนัด"],
  // "นัด" kept here on purpose: catches "จะนัดฉีดวัคซีนได้ไหม", "ขอนัดหน่อย" etc.
  // Without it, these fall through to the generic "วัคซีน" bucket below and get
  // misanswered as a price/info question instead of routed to appointment flow.
  apptChange: ["เลื่อนนัด", "เปลี่ยนนัด", "ขอเลื่อน", "มาไม่ได้", "ไปไม่ได้", "ไม่สะดวก", "พลาดนัด", "นัด"],
  // *** เพิ่ม 2026-09-01 (บั๊ก) ***: ต้องเช็คก่อน apptChange เสมอ เหตุผลเดียวกับ apptCheck
  // ด้านบน — ข้อความถาม "ยืนยันมาตามนัดเดิม" (ไม่ได้ขอเลื่อน) มักมีคำว่า "นัด" อยู่ด้วย เช่น
  // "ทางรพ.นัดฉีด 15 ก.ย เราต้องไปฉีด 15 ก.ย หรือไปก่อนคะ" ซึ่งชนกับ apptChange's bare "นัด"
  // ทำให้บอทตอบเนื้อหาเลื่อนนัดทั้งที่ลูกค้าไม่ได้ขอเลื่อนเลย
  apptConfirm: [
    "มาตามนัดเดิม", "ไปตามนัดเดิม", "มาวันนัดเดิม", "ไปวันนัดเดิม", "ตามนัดเดิม",
    "หรือไปก่อน", "หรือมาก่อน", "ไปก่อนได้ไหม", "มาก่อนได้ไหม",
    "ต้องไปตามนัด", "ต้องมาตามนัด",
  ],
  services: ["บริการ"],
  holidays: ["วันหยุด", "ปิดยาว", "หยุดยาว", "หยุดคลินิก"],
  news: ["ข่าวสาร", "ข่าว"],
  promo: ["โปรโมชั่น", "โปรโมชัน", "โปรโมท"],
  vaccineNew: ["วัคซีนใหม่"],
  closureAnnounce: ["ประกาศปิดคลินิก"],
  contact: ["ติดต่อ", "เบอร์โทร", "เบอร์", "โทรศัพท์", "ไลน์ไอดี"],
  booking: ["จองคิว", "จอง", "นัดคิว"],
  // Concrete symptom/sickness phrasing — checked BEFORE vaccine-alias resolution
  // so a disease name (e.g. "มือเท้าปาก", also a vaccine_aliases entry) said in a
  // symptom sentence ("ลูกเป็นมือเท้าปาก ไม่สบายค่ะ") routes here instead of always
  // being read as a vaccine question. Deliberately avoids bare short syllables like
  // "ไอ" or "ยา" that collide with unrelated words (e.g. "ยา" is a substring of the
  // very common "อยาก") — every entry is a full phrase, matching the style of the
  // other KW buckets above.
  //
  // *** แก้ 2026-08-30 ***: ทดสอบจริงบน FB Messenger "ลูกไข้ 38 องศาทำให้ดี" ไม่ตอบอะไร
  // เลย เพราะไม่มีคำไหนในลิสต์เดิม match — bare "ไข้"/"แพ้"/"จาม" เพิ่มเข้ามาใหม่ (คำอาการ
  // สั้นๆ ที่ผู้ปกครองพิมพ์จริง) "ไข้" ต่างจาก "ไอ"/"ยา" ตรงที่ไม่พบว่าชนกับคำไทยทั่วไปคำไหน
  // จึงปลอดภัยกว่าจะเปิดเป็น bare token ส่วน "ไอ" ยังคงเป็น full-phrase เท่านั้นเหมือนเดิม
  // (เสี่ยงชนกับ "ไอศกรีม"/"ไอเดีย"/"ไอโฟน" ฯลฯ) เพิ่มคำถามปลายเปิด "ทำไงดี"/"ทำยังไงดี"/
  // "ทำอย่างไรดี"/"ควรทำยังไง"/"ทำให้ดี" ด้วย — คำเหล่านี้ทั่วไปพอที่จะจับคำถามนอกเรื่องได้
  // บ้าง (เช่น "จ่ายเงินยังไงดี" ที่ไม่มีคำ intent อื่นนำหน้ามาก่อน) แต่ยอมรับ trade-off นี้
  // เพราะ priority ในการ route (บริการ/นัด/ราคา/ฯลฯ) เช็คก่อนหน้าอยู่แล้ว และตอนนี้ทุก
  // ข้อความมี safety-net fallback รองรับเสมอ (ดู reply.ts) พลาดเป็น MEDICAL_QUESTION ยังดี
  // กว่าพลาดเป็นความเงียบเหมือนเคส 2026-08-30
  // *** แก้ 2026-09-01 (บั๊ก) ***: bare "ไข้" ย้ายออกจาก list นี้ไปเป็น hasBareFeverWord()
  // แทน (เช็คท้ายไฟล์) เพราะเดิมไปแมตช์เป็น substring ในชื่อวัคซีน/โรคที่ขึ้นต้นด้วย "ไข้"
  // (ไข้หวัดใหญ่/ไข้เลือดออก/ไข้สมองอักเสบเจอี/ไข้กาฬหลังแอ่น) ทำให้ "มีวัคซีนไข้หวัดใหญ่ไหม"
  // ตอบ MEDICAL_QUESTION แทนที่จะตอบเรื่องวัคซีน — "มีไข้"/"ไข้สูง"/"ไข้ขึ้น" ด้านล่างไม่ชน
  // ปัญหานี้ (ไม่ปรากฏเป็น substring ในชื่อวัคซีนกลุ่มนี้) จึงคงไว้เหมือนเดิมได้
  symptom: [
    "ไม่สบาย", "ป่วย", "มีไข้", "ตัวร้อน", "ไข้สูง", "ไข้ขึ้น",
    "ท้องเสีย", "ถ่ายเหลว", "อาเจียนบ่อย", "อาเจียน",
    "ผื่น", "ผื่นขึ้น", "มีผื่น", "ผื่นแดง",
    "แพ้", "จาม",
    "ไอมาก", "ไอบ่อย", "ไอแห้ง", "ไอมีเสมหะ", "เด็กไอ",
    "น้ำมูก", "มีน้ำมูก", "น้ำมูกไหล",
    "ปวดท้อง", "ปวดหัว", "ปวดศีรษะ",
    "ซึมลง", "ซึมมาก", "ตัวซึม",
    "ไม่ดื่มนม", "ไม่กินนม", "ไม่ยอมกินนม",
    "หายใจลำบาก", "หายใจติดขัด", "หายใจเร็ว",
    "ท้องผูก", "มีแผล", "แผลติดเชื้อ",
    "ตัวบวม", "หน้าบวม",
    "คันตามตัว", "มีอาการคัน",
    "ตุ่มใส", "มีตุ่ม",
    "เจ็บคอ", "เจ็บตา", "เจ็บหู",
    "ทำไงดี", "ทำยังไงดี", "ทำอย่างไรดี", "ควรทำยังไง", "ทำให้ดี",
  ],
  // Non-vaccine product/supply stock questions (milk, medicine, diapers).
  // Full-phrase entries only, same reasoning as `symptom` above.
  productStock: [
    "นมมีไหม", "มีนมไหม", "นมมีหรือเปล่า", "นมมีรึเปล่า", "มีนมขาย", "นมมีขายไหม",
    "สต็อกนม", "มีสต็อกนม",
    "มียาไหม", "ยามีไหม", "สต็อกยา", "มีสต็อกยา", "มียาเด็กไหม", "ยาเด็กมีไหม",
    "เวชภัณฑ์มีไหม", "มีเวชภัณฑ์ไหม",
    "ผ้าอ้อมมีไหม", "มีผ้าอ้อมไหม",
    "ของใช้เด็กมีไหม", "มีของใช้เด็กไหม",
  ],
  // *** เพิ่ม 2026-09-01 (บั๊ก 4, ยืนยันแล้ว) ***: เช็คเป็นตัวสุดท้ายก่อนตกไป Gemini/UNKNOWN
  // (ดู detectIntent) เพื่อให้คำถามจริงที่มี "ขอบคุณ" นำหน้าแต่ตามด้วยคำถามจริงๆ (เช่น
  // "ขอบคุณค่ะ แล้วขอถามราคาวัคซีนหน่อยค่ะ") ยังโดน KW.price ดักตอบก่อนอยู่ดี ไม่ใช่ END_CONVERSATION
  thanks: ["ขอบคุณ", "ขอบใจ", "thank you", "thanks"],
};

// "ค่ะ"/"ครับ"/"คะ" เดี่ยวๆ (ทั้งข้อความมีแค่นี้) — ต้อง exact match เท่านั้น ห้าม substring
// เด็ดขาด เพราะเป็นคำลงท้ายประโยคที่พบในเกือบทุกข้อความภาษาไทย ถ้าเช็คแบบ includes() จะจับ
// ผิดมหาศาล (เช่น "ราคาเท่าไหร่ค่ะ" ก็มี "ค่ะ" อยู่ในนั้นด้วย) รวม "คะ" เข้ามาด้วยแม้ทาง
// ไวยากรณ์เป็นคำถาม เพราะในทางปฏิบัติผู้ปกครองมักพิมพ์รับทราบสั้นๆ ด้วยคำนี้เหมือนกัน
const BARE_ACKNOWLEDGEMENT = new Set(["ค่ะ", "ครับ", "คะ"]);

// ชื่อวัคซีน/โรคที่ขึ้นต้นด้วย "ไข้" แต่ไม่ใช่การรายงานอาการป่วย — ตัดออกจากข้อความก่อนเช็ค
// ว่ามี "ไข้" เหลืออยู่แบบ bare หรือไม่ (ดูคอมเมนต์ที่ KW.symptom ด้านบนสำหรับบั๊กเต็ม)
// ตรวจสอบกับ vaccine_aliases จริงแล้ว 2026-09-01: ครอบคลุมทั้ง "ไข้สมองอักเสบเจอี" (คำเดียว
// พอเพราะ "เจอี" ไม่มี "ไข้" อยู่แล้ว) และ 3 alias ของ "ไข้กาฬหลังแอ่น" (acwy/ชนิดบี/บี)
const FEVER_VACCINE_NAMES = ["ไข้หวัดใหญ่", "ไข้เลือดออก", "ไข้สมองอักเสบ", "ไข้กาฬหลังแอ่น"];

function hasBareFeverWord(text: string): boolean {
  let stripped = text;
  for (const name of FEVER_VACCINE_NAMES) stripped = stripped.split(name).join("");
  return stripped.includes("ไข้");
}

// เสริม KW.status (literal list) ด้วย pattern ที่ยอมให้มีคำแทรกสั้นๆ ระหว่าง เปิด/ปิด/หยุด
// กับคำถามท้ายประโยค — ตั้งใจใช้ "คำเติมที่รู้จักแล้วเท่านั้น" (ไม่ใช่ .{0,N} กว้างๆ) เพื่อกัน
// การจับผิดกับคำถามคนละบริบทที่บังเอิญมี "หยุด"/"ปิด" อยู่ด้วย เช่น "หยุดกินยาได้ไหม" (ถาม
// เรื่องยา ไม่ใช่เรื่องวันเปิด-ปิดคลินิก) — ทดสอบแล้วว่า pattern นี้ไม่แมตช์ประโยคแบบนั้น
// เพราะ "กินยาได้" ไม่ตรงกับคำเติมกลุ่มไหนเลย
const STATUS_QUESTION_PATTERN =
  /(เปิด|ปิด|หยุด)\s*(ตามปกติ|ปกติ)?\s*(อยู่)?\s*(ใช่)?\s*(ไหม|มั้ย|รึเปล่า|หรือเปล่า|หรือไม่)/;

// จับ "ตัวเลข + องศา" (เช่น "38 องศา", "38.5°") แยกจาก KW.symptom เพราะผู้ปกครองมักบอก
// อุณหภูมิลอยๆ โดยไม่มีคำอื่นที่ list ด้านบนจับได้เลย (เช่น "ลูกไข้ 38 องศาทำให้ดี" —
// เคสจริง 2026-08-30 ที่ทำให้บอทเงียบสนิทบน Messenger) การบอกอุณหภูมิเป็นองศาในบริบท
// คลินิกเด็กถือเป็นสัญญาณอาการป่วยได้เลยในตัวเอง ไม่ต้องรอคำว่า "ไข้" อยู่ข้างๆ ด้วยซ้ำ
const TEMPERATURE_READING = /\d+(\.\d+)?\s*(องศา|°c?)/i;

export function parseAgeMonths(text: string): number | null {
  const t = norm(text);
  const y = t.match(/(\d+)\s*(?:ปี|ขวบ)/);
  const m = t.match(/(\d+)\s*เดือน/);
  if (y || m) return (y ? +y[1]! * 12 : 0) + (m ? +m[1]! : 0);
  const code = t.match(/(?:^|\s)(\d+)\s*m(?:\s|$)/i);   // 2M, 12M — not PCV20
  return code ? +code[1]! : null;
}

// Alias lookup replaces the giant hardcoded AI_ALIAS regex.
// Indexed table (vaccine_aliases) + trigram = resilient to new phrasings.
//
// *** แก้ 2026-08-30 ***: ฟังก์ชันนี้ถูกเรียกแบบไม่มีเงื่อนไขสำหรับ "ทุกข้อความที่ไม่ตรง
// keyword bucket ไหนเลยด้านบน" (ดู detectIntent ท้ายไฟล์) เดิมไม่มี try/catch ล้อม
// admin.from() เลย — ถ้า Supabase สะดุดแม้แค่ชั่วคราว (network blip, timeout) exception
// จะลอยขึ้นไปทะลุ detectIntent -> buildReplyMessages -> route handler ที่ไม่มี try/catch
// เหมือนกัน (line.ts/messenger.ts) จบที่ reply()/send() ไม่ถูกเรียกเลย = ผู้ปกครองไม่ได้รับ
// คำตอบอะไรทั้งสิ้น นี่คือสาเหตุที่เป็นไปได้มากที่สุดของเคสเงียบจริงบน Messenger — ครอบ
// try/catch ให้ล้มแบบปลอดภัย (คืน undefined เหมือนไม่พบ group) แทนที่จะปล่อยให้พังทั้งสาย
async function resolveVaccineGroup(text: string): Promise<string | undefined> {
  const t = norm(text);
  try {
    const { data } = await admin.from("vaccine_aliases").select("alias, group_code");
    if (!data) return undefined;
    // longest alias that appears in the text wins (avoids "pcv" stealing "pcv13")
    const hit = data
      .filter((r) => t.includes(r.alias))
      .sort((a, b) => b.alias.length - a.alias.length)[0];
    return hit?.group_code;
  } catch (err) {
    console.error("resolveVaccineGroup: Supabase query failed, falling back to no-group", err);
    return undefined;
  }
}

// ---- Specific-date / weekday-name status questions ----
// Ported from IntentEngine.js (old Apps Script): extractSpecificDayOfMonth_,
// isSpecificDateStatusIntent_, isClinicDateUnclearIntent_.

function extractSpecificDayOfMonth(text: string): number | null {
  const match = text.match(/วันที่\s*(\d{1,2})/);
  if (!match) return null;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}

// Must use full month names/abbreviations, never bare "เดือน" — otherwise age
// questions like "วัคซีน 2 เดือน" would be misread as a date reference.
const THAI_MONTH_TOKENS =
  /(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/;
const THAI_WEEKDAY_TOKENS = /(วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัส|วันศุกร์|วันเสาร์|วันอาทิตย์)/;

// A weekday/month name said WITHOUT the "วันที่ N" format above (e.g.
// "วันอังคารเปิดไหม", "วันพุธที่ 12 ส.ค. เปิดมั้ย") — these used to fall through to
// the generic KW.status match below and get answered with *today's* status
// regardless of which day was actually asked about.
function isClinicDateUnclear(text: string): boolean {
  if (extractSpecificDayOfMonth(text) !== null) return false;
  if (/(วันนี้|พรุ่งนี้|มะรืน)/.test(text)) return false;

  const hasMonth = THAI_MONTH_TOKENS.test(text);
  const hasWeekday = THAI_WEEKDAY_TOKENS.test(text);
  if (!hasMonth && !hasWeekday) return false;

  const hasOpenCloseWord = /(เปิด|ปิด|หยุด)/.test(text);
  // Weekday names use a stricter rule (open/close word required) so this doesn't
  // steal a general schedule question like "เวลาทำการวันจันทร์" from CLINIC_TIME.
  if (hasWeekday && !hasMonth) return hasOpenCloseWord;
  return hasOpenCloseWord || /(กี่โมง|เวลา)/.test(text);
}

export async function detectIntent(message: string): Promise<IntentResult> {
  const text = norm(message);
  if (!text) return { intent: "UNKNOWN", text };

  // เช็คก่อนสุด — exact match ล้วน ไม่มีความเสี่ยงชนกับ intent อื่นเลย (ดูคอมเมนต์ที่
  // BARE_ACKNOWLEDGEMENT ด้านบนสำหรับเหตุผลที่ต้อง exact match ไม่ใช่ substring)
  if (BARE_ACKNOWLEDGEMENT.has(text)) return { intent: "END_CONVERSATION", text };

  if (has(text, KW.booking))    return { intent: "BOOKING_MENU", text };
  // apptCheck before apptChange: "เช็คนัดหมาย" (the booking-menu button payload)
  // contains "นัด", which apptChange also matches — order decides the winner.
  if (has(text, KW.apptCheck))  return { intent: "APPOINTMENT_CHECK", text };
  // apptConfirm before apptChange too — same reasoning (ดูคอมเมนต์ที่ KW.apptConfirm ด้านบน)
  if (has(text, KW.apptConfirm)) return { intent: "APPOINTMENT_CONFIRM", text };
  if (has(text, KW.apptChange)) return { intent: "APPOINTMENT_CHANGE", text };

  // Checked before the generic KW.status match below, which would otherwise catch
  // these via a bare "เปิดไหม"/"ปิดไหม" and wrongly answer with *today's* status.
  // No open/close word required here — CLINIC_DATE_UNCLEAR's own redirect message
  // tells the user to type exactly "วันที่ 12" with nothing else, so a bare
  // "วันที่ N" must be enough on its own (a live-test bug: it wasn't, and matching
  // digits with nothing else fell all the way through to FALLBACK_MESSAGE).
  const specificDay = extractSpecificDayOfMonth(text);
  if (specificDay !== null) {
    return { intent: "CLINIC_STATUS_SPECIFIC_DATE", text, specificDay };
  }
  if (isClinicDateUnclear(text)) {
    return { intent: "CLINIC_DATE_UNCLEAR", text };
  }

  if (has(text, KW.status) || STATUS_QUESTION_PATTERN.test(text))
    return { intent: "CLINIC_STATUS", text };
  if (has(text, KW.time))       return { intent: "CLINIC_TIME", text };
  if (has(text, KW.location))   return { intent: "LOCATION", text };
  if (has(text, KW.services))   return { intent: "SERVICES", text };
  if (has(text, KW.closureAnnounce)) return { intent: "CLOSURE_ANNOUNCEMENT", text };
  if (has(text, KW.vaccineNew))      return { intent: "VACCINE_NEWS", text };
  if (has(text, KW.promo))           return { intent: "PROMOTIONS", text };
  if (has(text, KW.holidays))   return { intent: "HOLIDAYS", text };
  if (has(text, KW.news))       return { intent: "NEWS", text };
  if (has(text, KW.contact))    return { intent: "CONTACT", text };

  // Checked before resolveVaccineGroup() on purpose: a symptom sentence naming a
  // disease that also happens to be a vaccine_aliases entry (e.g. "มือเท้าปาก")
  // must not be swallowed by the vaccine-question path below. TEMPERATURE_READING
  // checked in the same slot — a bare "38 องศา" is medical context on its own even
  // with zero KW.symptom words nearby (see TEMPERATURE_READING comment above).
  if (has(text, KW.symptom) || hasBareFeverWord(text) || TEMPERATURE_READING.test(text))
    return { intent: "MEDICAL_QUESTION", text };
  if (has(text, KW.productStock)) return { intent: "PRODUCT_STOCK_INQUIRY", text };

  const group = await resolveVaccineGroup(text);
  const ageMonths = parseAgeMonths(text);

  if (group || KW.price.some((k) => text.includes(k)) || text.includes("วัคซีน")) {
    if (has(text, KW.price)) return { intent: "VACCINE_PRICE", text, vaccineGroup: group, ageMonths };
    if (has(text, KW.avail)) return { intent: "VACCINE_AVAILABILITY", text, vaccineGroup: group, ageMonths };
    // Falls here for "วัคซีน" + age with no specific product/price/avail word
    // (e.g. every age-picker button payload: "วัคซีน 2 เดือน") — this used to fall
    // all the way through to UNKNOWN/FALLBACK_MESSAGE instead of reaching
    // VACCINE_INFO's own no-group handling in reply.ts.
    return { intent: "VACCINE_INFO", text, vaccineGroup: group, ageMonths };
  }

  // *** แก้ 2026-09-01 (บั๊ก 4) ***: ต้องเช็คหลังสุด — หลังลองทุก intent ที่เจาะจงกว่าแล้ว
  // จริงๆ (รวม vaccine-group resolution ด้านบน) ไม่ใช่ก่อนหน้านั้น เดิมวางไว้ก่อน
  // resolveVaccineGroup() ทำให้ "ขอบคุณค่ะ แล้วขอถามราคาวัคซีนหน่อยค่ะ" (มีคำถามจริงต่อท้าย
  // คำขอบคุณ) โดน END_CONVERSATION ดักไปก่อนที่จะถึงคิวถามราคา (เจอจาก regression test เอง)
  if (has(text, KW.thanks)) return { intent: "END_CONVERSATION", text };

  // Only reach the AI when cheap paths miss — keeps latency + cost low.
  return env.geminiKey ? await geminiFallback(text) : { intent: "UNKNOWN", text };
}

async function geminiFallback(text: string): Promise<IntentResult> {
  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiKey}`;
    const prompt =
      `จำแนก intent ของข้อความคลินิกเด็กนี้เป็นหนึ่งใน: ` +
      `APPOINTMENT_CHANGE, CLINIC_STATUS, CLINIC_TIME, LOCATION, VACCINE_PRICE, ` +
      `VACCINE_AVAILABILITY, VACCINE_INFO, UNKNOWN. ตอบเป็นคำเดียว.\nข้อความ: "${text}"`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const j = (await res.json()) as any;
    const label = String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "UNKNOWN")
      .trim().toUpperCase();
    const valid: Intent[] = [
      "APPOINTMENT_CHANGE", "CLINIC_STATUS", "CLINIC_TIME", "LOCATION",
      "VACCINE_PRICE", "VACCINE_AVAILABILITY", "VACCINE_INFO", "UNKNOWN",
    ];
    const intent = (valid.find((v) => label.includes(v)) ?? "UNKNOWN") as Intent;
    return { intent, text };
  } catch {
    return { intent: "UNKNOWN", text };
  }
}
