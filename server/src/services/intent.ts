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
  | "VACCINE_PACKAGE"
  | "VACCINE_GENERAL_INFO"
  | "VACCINE_DELAY"
  | "VACCINE_NEXT_DOSE"
  | "VACCINE_DOSE_COUNT_QUESTION"
  | "ANIMAL_BITE"
  | "LAB_TEST_INQUIRY"
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
  specificDay?: number;    // 1-31, set only for CLINIC_STATUS_SPECIFIC_DATE (bare "วันที่ N", no month)
  // *** เพิ่ม 2026-09-29 (round 4, Priority 2) ***: ISO yyyy-mm-dd already fully resolved —
  // set instead of specificDay when the date came from an explicit day+month (+ optional
  // year) or a bare weekday name embedded in a free-form sentence (ดู extractExplicitDate/
  // extractBareWeekdayDate ด้านล่าง) reply.ts ใช้ค่านี้ตรงๆ แทนการ roll-forward แบบ specificDay
  resolvedDate?: string;
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
  // *** แก้ 2026-09-29 (round 4, Priority 4) ***: เคสจริง "คลีนิคอยู่ตรงไหนคะ" ไม่ match
  // "อยู่ไหน" เดิมเพราะมีคำว่า "ตรง" แทรกอยู่ระหว่าง "อยู่" กับ "ไหน" ("อยู่ตรงไหน" ไม่ใช่
  // substring ของ "อยู่ไหน") ตกไป fallback ทั้งที่ควรตอบที่อยู่คลินิก — เพิ่ม literal phrase นี้
  location: ["ที่อยู่", "แผนที่", "อยู่ไหน", "อยู่ตรงไหน", "ไปยังไง", "พิกัด", "การเดินทาง"],
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
  // *** เพิ่ม 2026-09-06 (round 2, issue 2) ***: คลินิกไม่มีแพ็กเกจวัคซีนรวม — เช็คก่อน
  // generic price/วัคซีน gate ด้านล่างเสมอ ไม่งั้น "แพ็กเกจวัคซีนราคาเท่าไหร่" จะโดน
  // KW.price + "วัคซีน" ดักไปตอบการ์ดเลือกอายุ (ไม่มี group ให้ resolve) ซึ่งไม่ตรงคำถาม
  vaccinePackage: ["แพ็กเกจ", "แพคเกจ", "เหมาจ่าย"],
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
    // *** เพิ่ม 2026-09-06 (round 2, issue 5) ***: "ขี้ตา" หลุด fallback เพราะไม่มี keyword
    // ไหนจับ ตรวจแล้วไม่ชนกับคำไทยทั่วไปคำอื่น (ไม่ใช่ substring ของคำอื่นที่ใช้บ่อย) — "ตุ่ม"
    // เพิ่มเป็น bare token เสริมจาก "ตุ่มใส"/"มีตุ่ม" เดิม เผื่อประโยคที่ไม่มีคำนำหน้า/ตามท้าย
    "ขี้ตา", "ตุ่ม",
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
  // *** เพิ่ม 2026-09-29 (round 4, Priority 1 — medical safety) ***: เคสจริง "มีวัคซีนแมวช่วนไหม"
  // (พิมพ์ตก น่าจะหมายถึง "โดนแมวข่วน") เดิมบอทตีความเป็นคำถามวัคซีนทั่วไป (เพราะมีคำว่า
  // "มีวัคซีน" ซึ่งตรงกับ KW.avail พอดี) โชว์การ์ดเลือกอายุ ทั้งที่เป็นเหตุฉุกเฉินทางการแพทย์จริง
  // ต้องเช็คก่อนทุก intent อื่นเสมอ (ดู detectIntent) รวม "ช่วน" เป็น typo ของ "ข่วน" ไว้ด้วยตรงๆ
  // เพราะเป็นคำที่เจอจริงจากภาพหน้าจอ ไม่ใช่การเดา
  animalBite: [
    "โดนกัด", "หมากัด", "แมวกัด", "สัตว์กัด", "ถูกกัด",
    "โดนข่วน", "แมวข่วน", "หมาข่วน", "สัตว์ข่วน", "ถูกข่วน",
    "แมวช่วน", "หมาช่วน", "สัตว์ช่วน",
    "พิษสุนัขบ้า", "หมาบ้า",
  ],
  // *** เพิ่ม 2026-09-29 (round 4, Priority 3, ภาพ 8-9) ***: คำถามเรื่องตรวจแล็บ (RSV/เจาะเลือด)
  // ตกไป fallback เพราะไม่มี keyword ไหนจับเลย — "เจาะเลือด"/"ตรวจเลือด" เป็น full-phrase ปลอดภัย
  // (ไม่ชนคำอื่น) ส่วน RSV ไม่ใส่เป็น bare token เพราะ "RSV" เป็นทั้งชื่อวัคซีน (ดู vaccine.ts
  // GROUP_DISPLAY_NAME) และชื่อสินค้าใน stock.ts (nirsevimab ฯลฯ) อยู่แล้ว — ต้องเช็คคู่กับคำว่า
  // "ตรวจ" เท่านั้น (ดู LAB_TEST_PATTERN ด้านล่าง) ไม่งั้นคำถามราคา/สต็อก RSV ตามปกติจะโดนแย่งไป
  labTest: ["เจาะเลือด", "ตรวจเลือด", "ตรวจภูมิ"],
};

const LAB_TEST_PATTERN = /(ตรวจ\s*rsv|rsv\s*ตรวจ)/i;

// *** เพิ่ม 2026-09-29 (round 4, Priority 4) ***: เคสจริง "มียาไข้หวัดใหญ่ไหม" (ถามยา ไม่ใช่
// วัคซีน) — KW.productStock เดิมต้อง exact-phrase เต็ม ("มียาไหม" ฯลฯ) ไม่ match เพราะมีชื่อโรค
// แทรกอยู่ระหว่าง "มียา" กับ "ไหม" ตกไปจน resolveVaccineGroup() เจอ "ไข้หวัดใหญ่" เป็น
// vaccine_aliases (ชื่อโรคเดียวกับชื่อวัคซีน) แล้วดึงไปตอบราคาวัคซีนแทนที่จะตอบเรื่องยา —
// เพิ่ม pattern กว้างขึ้น "มียา...ไหม/มั้ย/หรือเปล่า/รึเปล่า" (มีอะไรคั่นกลางได้) เช็คคู่กับ
// KW.productStock เดิมในจุดเดียวกัน (ก่อน resolveVaccineGroup เสมออยู่แล้ว)
const MEDICINE_AVAIL_PATTERN = /มียา.{0,20}(ไหม|มั้ย|หรือเปล่า|รึเปล่า)/;

// *** เพิ่ม 2026-09-29 (round 4, Priority 3, ภาพ 5 ขวา) ***: เคสจริง "อยากให้นัดวัคซีนตัวต่อไป
// ต้องไปฉีดเมื่อไหร่" — มีคำว่า "นัด" ปนอยู่ ("นัดวัคซีนตัวต่อไป") โดน apptChange's bare "นัด"
// ดักไปตอบเนื้อหาเลื่อนนัดทั่วไป ทั้งที่คำถามจริงคือ "วัคซีนตัวต่อไปต้องฉีดเมื่อไหร่" (ถามกำหนด
// เข็มถัดไป ไม่ใช่ขอเลื่อนนัด) — ต้องเช็คก่อน apptChange เสมอ (ดู detectIntent)
const NEXT_DOSE_QUESTION_PATTERN =
  /(ตัวต่อไป|เข็มต่อไป|ครั้งต่อไป|ตัวถัดไป|เข็มถัดไป).*(เมื่อไหร่|เมื่อไร|กี่โมง|วันไหน|วันอะไร)/;

// *** เพิ่ม 2026-09-29 (round 4, Priority 3, ภาพ 1) ***: เคสจริง "แบบ2เข็มกับเข็มเดียวต่างกันไม่
// คะ" (ถามต่อเนื่องจากคำถามราคาวัคซีนไข้หวัดใหญ่ก่อนหน้า) — ไม่มีคำว่า "วัคซีน"/"ฉีด" หรือชื่อ
// วัคซีนใดๆ อยู่ในข้อความนี้เองเลย ระบบไม่มี conversation memory ข้ามข้อความ (out of MVP scope
// ตอนนี้) จึงตอบเจาะจงวัคซีนที่ถามไปก่อนหน้าไม่ได้ — แต่ตอบกว้างๆ อย่างปลอดภัยได้โดยไม่ต้อง
// hardcode ข้อมูลจำนวนเข็มต่อวัคซีน (ขัด Iron Rule "data over code") ดีกว่าปล่อยตกไป fallback
// ทั่วไปที่ไม่เกี่ยวข้องเลย
const DOSE_COUNT_COMPARISON_PATTERN = /(\d+\s*เข็ม|เข็มเดียว).*(ต่างกัน|แตกต่าง|เหมือนกัน)/;

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

// *** เพิ่ม 2026-09-06 (round 2, issue 4) ***: คำถามทั่วไปแบบ "สนใจไปฉีดวัคซีนต้องทำไงคะ"
// (ไม่ระบุอายุ/ชื่อวัคซีน) เดิมมีคำว่า "วัคซีน" อยู่ในประโยค ทำให้ตกไปที่ generic
// vaccine gate ท้าย detectIntent() แล้วได้การ์ดเลือกอายุ ทั้งที่ลูกค้าถามกว้างๆ ว่า "ต้องทำ
// ยังไง" ไม่ได้ถามหาวัคซีนเฉพาะเจาะจง — เช็ค pattern นี้ก่อนเข้า vaccine gate เสมอ (ดู
// detectIntent) และต้องไม่มีทั้ง group ที่ resolve ได้และ ageMonths ด้วย ไม่งั้นคำถามเจาะจง
// อายุอย่าง "ลูกอายุ 6 เดือน ต้องฉีดอะไรบ้าง" จะโดนแย่งไปตอบผิดทาง (ต้องคงพฤติกรรมเดิม)
const VACCINE_HOWTO_PATTERN = /ทำ(ยังไง|ไง|อย่างไร)/;

// *** เพิ่ม 2026-09-16 (round 3, ภาพ 2) ***: เคสจริงบน FB Messenger — ผู้ปกครองถามว่าลูกครบ
// 2 เดือนวันที่ 16 "ต้องฉีดวันนั้นเลยหรือล่าช้าได้กี่วัน" บอทตอบแค่เวลาเปิด-ปิดคลินิกวันที่ 16
// เพราะข้อความมี "วันที่ 16" ปนอยู่ โดน extractSpecificDayOfMonth() ด้านล่างดักไปก่อน (เช็คก่อน
// ทุก intent ที่เจาะจงกว่ารวมถึง vaccine gate) ทั้งที่คำถามจริงคือ "เลื่อนฉีดวัคซีนได้กี่วัน" ไม่ใช่
// "วันที่ 16 เปิดไหม" — เพิ่มเช็คนี้ก่อน specificDay เสมอ (ดู detectIntent) คำตอบใช้ DOCTOR_REFERRAL
// เดิม (ดู reply.ts) ไม่ได้เขียนเกณฑ์จำนวนวันใหม่เอง — เกณฑ์ระยะห่างเข็มเป็นเรื่องการแพทย์ ต้อง
// ให้แพทย์ที่คลินิกประเมินเป็นรายบุคคล (สอดคล้องกับ DOCTOR_NOTE ใน vaccine.ts ที่พูดถึง
// "รับวัคซีนล่าช้า" ไว้แล้วว่าต้องปรึกษาแพทย์)
//
// *** แก้ 2026-09-16 (live-test fail, ภาพ 2 ข้อความจริง) ***: เวอร์ชันแรกเช็คแค่ text.includes
// ("วัคซีน"/"ฉีด") เป็นสัญญาณบริบทวัคซีน — พลาดข้อความจริงที่ทดสอบ "ลูกครบ 2 เดือน วันที่ 16
// กำหนดล่าช้าได้กี่วัน" เพราะไม่มีคำว่า "วัคซีน"/"ฉีด" อยู่เลยแม้แต่คำเดียว (ผู้ปกครองพูดถึง
// "กำหนด" เฉยๆ ไม่เอ่ยชื่อวัคซีน) — testcase ที่เขียนไว้ก่อน push ("ต้องฉีดวันนั้นเลย...")
// บังเอิญมีคำว่า "ฉีด" ปนอยู่ทำให้ผ่าน local test แต่ไม่ครอบคลุมเคสจริงที่ไม่เอ่ยคำนี้เลย —
// คลินิกนี้ผูกกำหนดวัคซีนกับอายุเป็นหลัก (ดู AGE_CODE_MAP ใน reply.ts) ดังนั้น "ครบ N เดือน/ปี/
// ขวบ" ที่ตามด้วยคำถามเรื่องล่าช้า/เลื่อน ก็ถือเป็นบริบทวัคซีนได้เองโดยไม่ต้องเอ่ยชื่อ ("ครบ" =
// อายุถึงกำหนดฉีดตามเกณฑ์ ไม่ใช่คำทั่วไปที่จะไปชนบริบทอื่น) เพิ่มเป็นสัญญาณสำรองแทนการบังคับ
// ต้องมีคำว่าวัคซีน/ฉีดเป๊ะๆ
function isVaccineDelayQuestion(text: string): boolean {
  const mentionsVaccine =
    text.includes("วัคซีน") || text.includes("ฉีด") || /ครบ\s*\d+\s*(เดือน|ปี|ขวบ)/.test(text);
  const mentionsDelay = /ล่าช้า|เลื่อนฉีด|เลื่อนวัคซีน|ช้ากว่ากำหนด/.test(text) ||
    (text.includes("เลื่อน") && text.includes("กี่วัน"));
  return mentionsVaccine && mentionsDelay;
}

// *** เพิ่ม 2026-09-16 (round 3, ภาพ 2 + ภาพ 6) ***: ป้องกัน extractSpecificDayOfMonth()
// ด้านล่าง (bare "วันที่ N") ไม่ให้แย่งคำถามที่จริงๆ เป็นเรื่องวัคซีน/นัดหมายไปตอบผิดทางเป็นแค่
// "วันที่ N เปิด-ปิดกี่โมง" — ภาพ 6 เป็นอีกเคสรูปแบบเดียวกัน: "แจ้งฉีดรอบก่อนวันที่ 14 ก.ค. ...
// นัดใหม่ไม่มีเขียนในสมุด ครบ 2 เดือนแล้วเข้ามาได้เลยไหม" บอทตอบวันเปิดคลินิกซึ่งไม่มีใครถาม —
// ข้อความที่มีคำเหล่านี้ปนอยู่กับ "วันที่ N" ควรปล่อยผ่านไปให้ intent ที่เจาะจงกว่าด้านล่าง
// (vaccine gate, apptChange ฯลฯ) ตัดสินแทน ไม่ใช่ตัดจบที่นี่ก่อนเลย
const SPECIFIC_DATE_DISTRACTOR_PATTERN = /วัคซีน|ฉีด|สมุด|กี่วัน|ล่าช้า/;

// *** แก้ 2026-09-29 (round 4, Priority 3, ภาพ 5 ซ้าย) ***: เคสจริง "วันนี้เข้าไปฉีด 1 ขวบครึ่ง
// ได้ไหม" — เดิม parser ไม่รู้จัก "ครึ่ง" เลย ("1 ขวบครึ่ง" อ่านได้แค่ "1 ขวบ" = 12 เดือน ตกหล่น
// 6 เดือนของ "ครึ่ง" ไป) เช็คก่อน y/m เสมอเพื่อจับ "X ปี/ขวบครึ่ง" เป็นกรณีพิเศษ (+6 เดือน) แทน
export function parseAgeMonths(text: string): number | null {
  const t = norm(text);
  const half = t.match(/(\d+)\s*(?:ปี|ขวบ)\s*ครึ่ง/);
  if (half) return +half[1]! * 12 + 6;
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

// *** เพิ่ม 2026-09-29 (round 4, Priority 2) ***: เคสจริง "วันอาทิตย์ที่ 27 ก.ย.69 เปิดช่วงเย็น
// ไหม" และ "วันอาทิตย์เปิดมั้ย" — เดิมทั้งคู่ตกไป CLINIC_DATE_UNCLEAR (ขอให้พิมพ์ใหม่เป็น
// "วันที่ 12" เท่านั้น) ทั้งที่วันที่/ชื่อวันฝังอยู่ในประโยคชัดเจนอยู่แล้ว ควร parse ตรงๆ ได้เลย
// ไม่ต้องให้ผู้ใช้พิมพ์ใหม่ — สองฟังก์ชันด้านล่าง resolve เป็น ISO date ตรงๆ (ไม่ใช่แค่ day-of-
// month แบบ extractSpecificDayOfMonth เดิม) reply.ts ใช้ผลลัพธ์นี้ผ่าน IntentResult.resolvedDate
// เรียก getClinicStatus() ตรงได้เลยเหมือน CLINIC_STATUS_SPECIFIC_DATE เดิมทุกประการ
const THAI_MONTH_INDEX: Record<string, number> = {
  "ม.ค.": 0, "มกราคม": 0, "ก.พ.": 1, "กุมภาพันธ์": 1, "มี.ค.": 2, "มีนาคม": 2,
  "เม.ย.": 3, "เมษายน": 3, "พ.ค.": 4, "พฤษภาคม": 4, "มิ.ย.": 5, "มิถุนายน": 5,
  "ก.ค.": 6, "กรกฎาคม": 6, "ส.ค.": 7, "สิงหาคม": 7, "ก.ย.": 8, "กันยายน": 8,
  "ต.ค.": 9, "ตุลาคม": 9, "พ.ย.": 10, "พฤศจิกายน": 10, "ธ.ค.": 11, "ธันวาคม": 11,
};

const EXPLICIT_DATE_PATTERN =
  /(\d{1,2})\s*(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)\s*(\d{2,4})?/;

/** "27 ก.ย.69" / "27 ก.ย. 2569" (ฝังอยู่ตรงไหนของประโยคก็ได้) -> ISO date ตรงๆ ไม่ผ่าน
 *  roll-forward logic แบบ resolveUpcomingDateByDayOfMonth เพราะมีเดือน(+ปี)ระบุชัดแล้ว ไม่กำกวม
 *  — ปีย่อ 2 หลัก ("69") ตีเป็น พ.ศ. เสมอ (25xx) แปลงเป็น ค.ศ. โดยลบ 543; ไม่ระบุปี -> ใช้ปีปัจจุบัน */
function extractExplicitDate(text: string, bangkokNow: Date): string | null {
  const m = text.match(EXPLICIT_DATE_PATTERN);
  if (!m) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  const monthIdx = THAI_MONTH_INDEX[m[2]!];
  if (monthIdx == null) return null;
  let yearCE = bangkokNow.getUTCFullYear();
  if (m[3]) {
    let y = Number(m[3]);
    if (y < 100) y += 2500; // ปีย่อ 2 หลัก พ.ศ. เช่น "69" -> 2569
    yearCE = y - 543;
  }
  const d = new Date(Date.UTC(yearCE, monthIdx, day));
  if (d.getUTCMonth() !== monthIdx || d.getUTCDate() !== day) return null; // วันที่ไม่มีจริง เช่น 30 ก.พ.
  return d.toISOString().slice(0, 10);
}

const THAI_WEEKDAY_TO_DOW: Record<string, number> = {
  "วันอาทิตย์": 0, "วันจันทร์": 1, "วันอังคาร": 2, "วันพุธ": 3,
  "วันพฤหัส": 4, "วันศุกร์": 5, "วันเสาร์": 6,
};

/** ชื่อวันลอยๆ ไม่มีวันที่/เดือนกำกับ (เช่น "วันอาทิตย์เปิดมั้ย") -> resolve เป็นวันที่ที่ใกล้
 *  ที่สุด (นับวันนี้ด้วยถ้าตรง) เหมือน resolveUpcomingDateByDayOfMonth แต่นับวันในสัปดาห์แทน
 *  day-of-month — ต้องมีคำเปิด/ปิด/หยุด เท่านั้น (กฎเดิมของ isClinicDateUnclear) กันชนกับคำถาม
 *  ตารางเวลาทั่วไปอย่าง "เวลาทำการวันจันทร์" (ควรเป็น CLINIC_TIME ไม่ใช่คำถามวันที่เจาะจง) */
function extractBareWeekdayDate(text: string, bangkokNow: Date): string | null {
  if (extractSpecificDayOfMonth(text) !== null) return null;
  if (THAI_MONTH_TOKENS.test(text)) return null; // มีเดือนด้วย -> ให้ extractExplicitDate จัดการแทน
  const m = text.match(THAI_WEEKDAY_TOKENS);
  if (!m) return null;
  if (!/(เปิด|ปิด|หยุด)/.test(text)) return null;
  const targetDow = THAI_WEEKDAY_TO_DOW[m[0]];
  if (targetDow == null) return null;
  const y = bangkokNow.getUTCFullYear(), mo = bangkokNow.getUTCMonth(), d = bangkokNow.getUTCDate();
  const today = new Date(Date.UTC(y, mo, d));
  const diff = (targetDow - today.getUTCDay() + 7) % 7;
  return new Date(today.getTime() + diff * 86400000).toISOString().slice(0, 10);
}

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

  // *** เพิ่ม 2026-09-29 (round 4, Priority 1 — medical safety) ***: เช็คก่อนทุก intent อื่น
  // เสมอ — ดูคอมเมนต์ที่ KW.animalBite ด้านบน ห้ามให้คำว่า "มีวัคซีน"/"บริการ"/ฯลฯ ที่อาจปนอยู่
  // ในประโยคเดียวกันแย่งไปตอบผิดทางได้เด็ดขาด เพราะเป็นเหตุฉุกเฉินทางการแพทย์จริง
  if (has(text, KW.animalBite)) return { intent: "ANIMAL_BITE", text };

  if (has(text, KW.booking))    return { intent: "BOOKING_MENU", text };
  // apptCheck before apptChange: "เช็คนัดหมาย" (the booking-menu button payload)
  // contains "นัด", which apptChange also matches — order decides the winner.
  if (has(text, KW.apptCheck))  return { intent: "APPOINTMENT_CHECK", text };
  // apptConfirm before apptChange too — same reasoning (ดูคอมเมนต์ที่ KW.apptConfirm ด้านบน)
  if (has(text, KW.apptConfirm)) return { intent: "APPOINTMENT_CONFIRM", text };
  // เช็คก่อน apptChange เสมอ — ดูคอมเมนต์ที่ NEXT_DOSE_QUESTION_PATTERN ด้านบน "นัดวัคซีนตัวต่อไป"
  // มีคำว่า "นัด" ปนอยู่ ต้องไม่ให้ apptChange's bare "นัด" แย่งไปตอบเลื่อนนัดทั่วไป
  if (NEXT_DOSE_QUESTION_PATTERN.test(text)) return { intent: "VACCINE_NEXT_DOSE", text };
  if (has(text, KW.apptChange)) return { intent: "APPOINTMENT_CHANGE", text };

  // Checked before extractSpecificDayOfMonth() below — a "delay/how many days late
  // can the dose be" question often names a specific day-of-month too (e.g. "ลูกครบ
  // 2 เดือนวันที่ 16 ต้องฉีดวันนั้นเลยหรือล่าช้าได้กี่วัน") and must not be answered
  // with that day's clinic hours (ดูคอมเมนต์ที่ isVaccineDelayQuestion ด้านบน)
  if (isVaccineDelayQuestion(text)) return { intent: "VACCINE_DELAY", text };

  // Checked before the generic KW.status match below, which would otherwise catch
  // these via a bare "เปิดไหม"/"ปิดไหม" and wrongly answer with *today's* status.
  // No open/close word required here — CLINIC_DATE_UNCLEAR's own redirect message
  // tells the user to type exactly "วันที่ 12" with nothing else, so a bare
  // "วันที่ N" must be enough on its own (a live-test bug: it wasn't, and matching
  // digits with nothing else fell all the way through to FALLBACK_MESSAGE).
  // *** แก้ 2026-09-16 (round 3, ภาพ 2 + ภาพ 6) ***: แต่ถ้ามี distractor (วัคซีน/ฉีด/สมุด/
  // กี่วัน/ล่าช้า) ปนอยู่ด้วย ปล่อยผ่านไปให้ intent เจาะจงกว่าด้านล่างตัดสินแทน (ดูคอมเมนต์ที่
  // SPECIFIC_DATE_DISTRACTOR_PATTERN ด้านบน)
  const specificDay = extractSpecificDayOfMonth(text);
  if (specificDay !== null && !SPECIFIC_DATE_DISTRACTOR_PATTERN.test(text)) {
    return { intent: "CLINIC_STATUS_SPECIFIC_DATE", text, specificDay };
  }

  // *** เพิ่ม 2026-09-29 (round 4, Priority 2) ***: ลองแปลง "วันที่ + เดือน (+ปี)" หรือ "ชื่อวัน"
  // ที่ฝังอยู่ในประโยคให้เป็นวันที่จริงก่อนเสมอ — ดูคอมเมนต์ที่ extractExplicitDate/
  // extractBareWeekdayDate ด้านบน กันไม่ให้ตกไป CLINIC_DATE_UNCLEAR (ขอให้พิมพ์ใหม่) ทั้งที่
  // resolve ได้เองอยู่แล้ว
  const bangkokNow = new Date(Date.now() + 7 * 3600 * 1000);
  const explicitDate = extractExplicitDate(text, bangkokNow);
  if (explicitDate) {
    return { intent: "CLINIC_STATUS_SPECIFIC_DATE", text, resolvedDate: explicitDate };
  }
  const weekdayDate = extractBareWeekdayDate(text, bangkokNow);
  if (weekdayDate) {
    return { intent: "CLINIC_STATUS_SPECIFIC_DATE", text, resolvedDate: weekdayDate };
  }

  if (isClinicDateUnclear(text)) {
    return { intent: "CLINIC_DATE_UNCLEAR", text };
  }

  if (has(text, KW.status) || STATUS_QUESTION_PATTERN.test(text))
    return { intent: "CLINIC_STATUS", text };
  if (has(text, KW.time))       return { intent: "CLINIC_TIME", text };
  if (has(text, KW.location))   return { intent: "LOCATION", text };
  // *** แก้ 2026-09-16 (round 3, ภาพ 5) ***: เคสจริงบน FB Messenger — ถามราคาฉีดวัคซีนของเด็ก
  // อายุ 4 เดือน บอทตอบเมนูบริการทั่วไป (คลินิกตรวจโรค/คลินิกสุขภาพเด็กดี) เพราะข้อความมีคำว่า
  // "บริการ" ปนอยู่ (เช่น "สอบถามบริการฉีดวัคซีน...") ซึ่งเช็คก่อน vaccine gate ด้านล่างเสมอ —
  // บั๊ก pattern เดียวกับที่เคยแก้ (KW ทั่วไปดักก่อน intent เจาะจงกว่า) ต้องไม่ให้ "บริการ" ชนะ
  // เมื่อข้อความมีคำวัคซีน/ฉีดด้วย ปล่อยผ่านไปให้ vaccine gate (price/availability/info ตามอายุ) ตัดสินแทน
  if (has(text, KW.services) && !(text.includes("วัคซีน") || text.includes("ฉีด")))
    return { intent: "SERVICES", text };
  if (has(text, KW.closureAnnounce)) return { intent: "CLOSURE_ANNOUNCEMENT", text };
  if (has(text, KW.vaccineNew))      return { intent: "VACCINE_NEWS", text };
  if (has(text, KW.promo))           return { intent: "PROMOTIONS", text };
  if (has(text, KW.holidays))   return { intent: "HOLIDAYS", text };
  if (has(text, KW.news))       return { intent: "NEWS", text };
  if (has(text, KW.contact))    return { intent: "CONTACT", text };

  // *** เพิ่ม 2026-09-29 (round 4, Priority 3, ภาพ 8-9) ***: เช็คก่อน symptom/vaccine gate เสมอ
  // — ดูคอมเมนต์ที่ KW.labTest/LAB_TEST_PATTERN ด้านบน
  if (has(text, KW.labTest) || LAB_TEST_PATTERN.test(text)) return { intent: "LAB_TEST_INQUIRY", text };

  // Checked before resolveVaccineGroup() on purpose: a symptom sentence naming a
  // disease that also happens to be a vaccine_aliases entry (e.g. "มือเท้าปาก")
  // must not be swallowed by the vaccine-question path below. TEMPERATURE_READING
  // checked in the same slot — a bare "38 องศา" is medical context on its own even
  // with zero KW.symptom words nearby (see TEMPERATURE_READING comment above).
  // *** แก้ 2026-09-29 (round 4, Priority 4) ***: เคสจริง "แบ่งโซนเด็กป่วย/ไม่ป่วยยังไงคะ" —
  // คำถามเรื่องนโยบายแบ่งโซนของคลินิก ไม่ใช่การรายงานอาการของลูกตัวเอง แต่โดน bare "ป่วย"
  // ใน KW.symptom ดักไปตอบ MEDICAL_QUESTION ผิดทาง — "โซน" เป็นคำเฉพาะเจาะจงพอที่จะกันชน
  // (ไม่ปรากฏในบริบทอาการป่วยทั่วไป) ยกเว้นไว้ ปล่อยตกไป fallback ให้เจ้าหน้าที่ตอบเองแทน
  // (ยืนยันจาก Yai ว่าไม่ต้องการคำตอบอัตโนมัติสำหรับคำถามนี้ แค่ต้องไม่ใช่ MEDICAL_QUESTION)
  if ((has(text, KW.symptom) || hasBareFeverWord(text) || TEMPERATURE_READING.test(text)) && !text.includes("โซน"))
    return { intent: "MEDICAL_QUESTION", text };
  // *** แก้ 2026-09-29 (round 4, Priority 4) ***: ดูคอมเมนต์ที่ MEDICINE_AVAIL_PATTERN ด้านบน
  if (has(text, KW.productStock) || MEDICINE_AVAIL_PATTERN.test(text))
    return { intent: "PRODUCT_STOCK_INQUIRY", text };

  // เช็คก่อน resolveVaccineGroup()/vaccine gate เสมอ — ดูคอมเมนต์ที่ KW.vaccinePackage ด้านบน
  if (has(text, KW.vaccinePackage)) return { intent: "VACCINE_PACKAGE", text };

  // *** เพิ่ม 2026-09-29 (round 4, Priority 3, ภาพ 1) ***: ดูคอมเมนต์ที่ DOSE_COUNT_COMPARISON_PATTERN
  // ด้านบน — เช็คก่อน vaccine gate เสมอ (ข้อความนี้เองไม่มีคำว่าวัคซีน/ฉีดเลย ไปไม่ถึง gate ด้านล่าง
  // อยู่แล้ว แต่เช็คเป็นจุดเดียวกับ vaccinePackage เพื่อความชัดเจนของลำดับ)
  if (DOSE_COUNT_COMPARISON_PATTERN.test(text)) return { intent: "VACCINE_DOSE_COUNT_QUESTION", text };

  const group = await resolveVaccineGroup(text);
  const ageMonths = parseAgeMonths(text);

  // เช็คก่อน vaccine gate ด้านล่างเสมอ — ดูคอมเมนต์ที่ VACCINE_HOWTO_PATTERN ด้านบน ต้องไม่มี
  // ทั้ง group และ ageMonths ไม่งั้นคำถามเจาะจงอายุ/วัคซีนจะโดนแย่งคำตอบไปตอบผิดทาง
  if (!group && ageMonths == null && (text.includes("วัคซีน") || text.includes("ฉีด")) && VACCINE_HOWTO_PATTERN.test(text)) {
    return { intent: "VACCINE_GENERAL_INFO", text };
  }

  // *** แก้ 2026-09-29 (round 4, Priority 3, ภาพ 5 ซ้าย) ***: เคสจริง "วันนี้เข้าไปฉีด 1 ขวบครึ่ง
  // ได้ไหม" — ไม่มีคำว่า "วัคซีน" เลย มีแค่ "ฉีด" ซึ่งเดิม gate นี้เช็คแค่ text.includes("วัคซีน")
  // เท่านั้น (ไม่รวม "ฉีด" ทั้งที่จุดอื่นในไฟล์เดียวกัน เช่น VACCINE_HOWTO_PATTERN/
  // isVaccineDelayQuestion ถือว่า "ฉีด" เป็นสัญญาณบริบทวัคซีนอยู่แล้ว) ทำให้ข้อความนี้ไม่เข้า
  // gate เลย ตกไป fallback ทั้งที่มีทั้งอายุ (ผ่าน parseAgeMonths ครึ่งปีที่แก้ด้านบนแล้ว) และ
  // คำว่า "ฉีด" ชัดเจน
  if (group || KW.price.some((k) => text.includes(k)) || text.includes("วัคซีน") || text.includes("ฉีด")) {
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
