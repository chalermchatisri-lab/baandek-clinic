import { admin } from "../lib/supabase";
import { env } from "../lib/env";

export type Intent =
  | "APPOINTMENT_CHANGE"
  | "CLINIC_STATUS"
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
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const has = (t: string, kws: string[]) => kws.some((k) => t.includes(k));

// Cheap keyword fast-paths (cover ~90% of traffic without an AI call).
const KW = {
  price: ["ราคา", "เท่าไร", "เท่าไหร่", "กี่บาท", "ค่าฉีด", "ค่าใช้จ่าย"],
  avail: ["มีไหม", "มีมั้ย", "มีรึเปล่า", "มีหรือเปล่า", "มีวัคซีน", "มีสต็อก"],
  status: ["เปิดไหม", "ปิดไหม", "หยุดไหม", "วันนี้เปิด", "ยังเปิด", "ไปทัน", "เปิด-ปิดวันนี้", "เปิดปิด", "เช็ควันทำการ"],
  time: ["เวลาทำการ", "เวลาเปิด", "กี่โมง", "ตารางเวลา"],
  location: ["ที่อยู่", "แผนที่", "อยู่ไหน", "ไปยังไง", "พิกัด", "การเดินทาง"],
  // "นัด" added broadly on purpose: catches "จะนัดฉีดวัคซีนได้ไหม", "ขอนัดหน่อย" etc.
  // Without it, these fall through to the generic "วัคซีน" bucket below and get
  // misanswered as a price/info question instead of routed to appointment flow.
  apptChange: ["เลื่อนนัด", "เปลี่ยนนัด", "ขอเลื่อน", "มาไม่ได้", "ไปไม่ได้", "ไม่สะดวก", "พลาดนัด", "เช็คนัด", "ตรวจสอบนัด", "เช็คคิว", "นัด"],
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
  symptom: [
    "ไม่สบาย", "ป่วย", "มีไข้", "ตัวร้อน", "ไข้สูง", "ไข้ขึ้น",
    "ท้องเสีย", "ถ่ายเหลว", "อาเจียนบ่อย", "อาเจียน",
    "ผื่นขึ้น", "มีผื่น", "ผื่นแดง",
    "ไอมาก", "ไอบ่อย", "ไอแห้ง", "ไอมีเสมหะ", "เด็กไอ",
    "มีน้ำมูก", "น้ำมูกไหล",
    "ปวดท้อง", "ปวดหัว", "ปวดศีรษะ",
    "ซึมลง", "ซึมมาก", "ตัวซึม",
    "ไม่ดื่มนม", "ไม่กินนม", "ไม่ยอมกินนม",
    "หายใจลำบาก", "หายใจติดขัด", "หายใจเร็ว",
    "ท้องผูก", "มีแผล", "แผลติดเชื้อ",
    "ตัวบวม", "หน้าบวม",
    "คันตามตัว", "มีอาการคัน",
    "ตุ่มใส", "มีตุ่ม",
    "เจ็บคอ", "เจ็บตา", "เจ็บหู",
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
};

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
async function resolveVaccineGroup(text: string): Promise<string | undefined> {
  const t = norm(text);
  const { data } = await admin.from("vaccine_aliases").select("alias, group_code");
  if (!data) return undefined;
  // longest alias that appears in the text wins (avoids "pcv" stealing "pcv13")
  const hit = data
    .filter((r) => t.includes(r.alias))
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  return hit?.group_code;
}

export async function detectIntent(message: string): Promise<IntentResult> {
  const text = norm(message);
  if (!text) return { intent: "UNKNOWN", text };

  if (has(text, KW.booking))    return { intent: "BOOKING_MENU", text };
  if (has(text, KW.apptChange)) return { intent: "APPOINTMENT_CHANGE", text };
  if (has(text, KW.status))     return { intent: "CLINIC_STATUS", text };
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
  // must not be swallowed by the vaccine-question path below.
  if (has(text, KW.symptom))      return { intent: "MEDICAL_QUESTION", text };
  if (has(text, KW.productStock)) return { intent: "PRODUCT_STOCK_INQUIRY", text };

  const group = await resolveVaccineGroup(text);
  const ageMonths = parseAgeMonths(text);

  if (group || KW.price.some((k) => text.includes(k)) || text.includes("วัคซีน")) {
    if (has(text, KW.price)) return { intent: "VACCINE_PRICE", text, vaccineGroup: group, ageMonths };
    if (has(text, KW.avail)) return { intent: "VACCINE_AVAILABILITY", text, vaccineGroup: group, ageMonths };
    if (group) return { intent: "VACCINE_INFO", text, vaccineGroup: group, ageMonths };
  }

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
