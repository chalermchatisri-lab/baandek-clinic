import { admin } from "../lib/supabase";
import { env } from "../lib/env";
import { detectIntent } from "./intent";
import { buildVaccineAdvice, DOCTOR_REFERRAL, buildAgeGroupVaccineList, buildAgeCardFlex, BRAND_GREEN, BRAND_GREEN_DARK, BRAND_CREAM, TEXT_DARK, TEXT_MUTED } from "./vaccine";
import { getClinicStatus } from "./clinicStatus";
import { buildAppointmentResultByPhone } from "./appointmentCheck";
import { findSpecificStockMatches, getPriorityStockOverview, buildSpecificStockReply, buildOverviewStockReply } from "./stock";

export type TextMessage = { type: "text"; text: string; quickReply?: unknown };
export type FlexMessage = { type: "flex"; altText: string; contents: Record<string, unknown>; quickReply?: unknown };
export type ReplyMessage = TextMessage | FlexMessage;

// *** เพิ่ม 2026-09-03 (รอบเย็น) ***: การ์ด Flex ทั่วไป (ไม่ผูกกับวัคซีน) ใช้ธีมสีเดียวกับ
// การ์ดวัคซีน (BRAND_GREEN/BRAND_CREAM จาก vaccine.ts) ให้บอททั้งตัวดูเป็นแบรนด์เดียวกัน —
// LINE เท่านั้น (Flex เป็นฟอร์แมต LINE) Messenger ยังใช้ข้อความล้วนเดิมทุกจุด
const MENU_HERO_BASE = `${env.supabaseUrl}/storage/v1/object/public/menu-hero`;
type FlexButton = { label: string; uri?: string; text?: string }; // uri = เปิดลิงก์/โทร, text = ส่งข้อความ (quick-reply แบบเดิม)
function buildSimpleFlexCard(opts: {
  title: string;
  heroUrl: string;
  bodyLines: string[];
  buttons?: FlexButton[]; // *** แก้ 2026-09-03 ***: เดิมรับปุ่มเดียว — ปุ่มที่ 2 (เช่น "เช็คนัดหมาย",
  // "Facebook") เคยใช้ quickReply ลอยแยกจากการ์ด ทำให้ดูหลุดออกมาไม่ติดกัน (feedback จาก Yai)
  // ย้ายมาไว้ในการ์ดเดียวกันหมด เรียงเป็นปุ่มซ้อนกันใน footer แทน
  altText: string;
}): FlexMessage {
  const contents: Record<string, unknown> = {
    type: "bubble",
    hero: { type: "image", url: opts.heroUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: BRAND_CREAM,
      paddingAll: "16px",
      contents: [
        { type: "text", text: opts.title, weight: "bold", size: "md", color: TEXT_DARK, wrap: true },
        ...opts.bodyLines.map((line) => ({ type: "text", text: line, wrap: true, size: "sm", color: TEXT_MUTED, margin: "sm" })),
      ],
    },
  };
  if (opts.buttons?.length) {
    contents.footer = {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "12px",
      contents: opts.buttons.map((btn, i) => ({
        type: "button",
        style: i === 0 ? "primary" : "secondary",
        color: i === 0 ? BRAND_GREEN : undefined,
        height: "sm",
        action: btn.uri
          ? { type: "uri", label: btn.label, uri: btn.uri }
          : { type: "message", label: btn.label, text: btn.text ?? btn.label },
      })),
    };
  }
  return { type: "flex", altText: opts.altText, contents };
}

// *** เพิ่ม 2026-09-03 (รอบค่ำ) ***: carousel รวมโปรโมชั่น + วัคซีนใหม่ + ประกาศปิดคลินิก (ถ้ามี)
// เป็นการ์ดเดียวเลื่อนดูได้ ธีมเดียวกับการ์ดอื่นๆ — ไม่มีรูป hero ต่อรายการเพราะข้อมูลในตาราง
// promotions/vaccine_news ไม่มีฟิลด์รูปภาพ ใช้ป้ายสีบอกหมวดแทน (Flex เป็นฟอร์แมต LINE เท่านั้น)
// *** แก้ 2026-09-03 (feedback: การ์ดยาวไป) ***: ตัดให้สั้นลงมาก — วัคซีนใหม่โชว์แค่ชื่อ ไม่มี
// คำอธิบาย, วันหยุดโชว์แค่วันที่ปิดประจำ + วันหยุดที่ใกล้ที่สุดวันเดียว (ไม่ใช่ทั้งเดือน),
// การ์ดเปลี่ยนเป็น size "micro" (แคบ+เตี้ยลง) ทุกใบ
const NEWS_BADGE_PROMO = "🎉 โปรโมชั่น";
const NEWS_BADGE_VACCINE = "💉 วัคซีนใหม่";
const NEWS_BADGE_CLOSURE = "📅 วันหยุด";
const NEWS_LINE_MAX = 60; // กันบรรทัดยาวเกินทำให้การ์ดสูงเกินไปโดยไม่ตั้งใจ
const trimLine = (s: string) => (s.length > NEWS_LINE_MAX ? s.slice(0, NEWS_LINE_MAX - 1) + "…" : s);

type BodyLine = string | { text: string; color: string };
function newsBubble(badge: string, badgeColor: string, title: string, bodyLines: BodyLine[], opts?: { buttons?: FlexButton[]; heroUrl?: string }): Record<string, unknown> {
  const bubble: Record<string, unknown> = {
    type: "bubble",
    size: "micro",
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: BRAND_CREAM,
      paddingAll: "12px",
      contents: [
        { type: "text", text: badge, size: "xxs", weight: "bold", color: badgeColor },
        { type: "text", text: trimLine(title), weight: "bold", size: "sm", wrap: true, color: TEXT_DARK, margin: "sm" },
        ...bodyLines.slice(0, 2).map((line) => {
          const isObj = typeof line !== "string";
          const text = isObj ? line.text : line;
          const color = isObj ? line.color : TEXT_MUTED;
          return { type: "text", text: trimLine(text), size: "xs", color, wrap: true, margin: "sm" };
        }),
      ],
    },
  };
  // *** เพิ่ม 2026-09-03 ***: รูป hero ตามหมวด (ไม่ใช่ต่อรายการ) — ทำครั้งเดียว 3 รูปใช้ซ้ำได้
  // ทุกโปรโมชั่น/วัคซีนใหม่/วันหยุดที่เพิ่มเข้ามาทีหลัง ไม่ต้องสร้างรูปใหม่ทุกครั้ง
  if (opts?.heroUrl) {
    bubble.hero = { type: "image", url: opts.heroUrl, size: "full", aspectRatio: "4:3", aspectMode: "cover" };
  }
  if (opts?.buttons?.length) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "12px",
      contents: opts.buttons.map((btn, i) => ({
        type: "button",
        style: i === 0 ? "secondary" : "link",
        height: "sm",
        action: btn.uri
          ? { type: "uri", label: btn.label, uri: btn.uri }
          : { type: "message", label: btn.label, text: btn.text ?? btn.label },
      })),
    };
  }
  return bubble;
}

async function buildNewsCarousel(): Promise<FlexMessage> {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: promos }, { data: vaccineNews }, closureParts, phone] = await Promise.all([
    admin.from("promotions").select("title, discount, condition")
      .eq("active", true).in("kind", ["bot", "both"])
      .or(`start_date.is.null,start_date.lte.${today}`)
      .or(`end_date.is.null,end_date.gte.${today}`),
    admin.from("vaccine_news").select("vaccine_name, short_hook, description")
      .eq("status", true).in("channel", ["bot", "both"])
      .or(`expire_date.is.null,expire_date.gte.${today}`),
    closuresNextOneParts(),
    config("PHONE"),
  ]);

  const bubbles: Record<string, unknown>[] = [];
  // *** แก้ 2026-09-03 (feedback: ไม่บอกเงื่อนไข อาจทำให้กังวลว่าจะมารับส่วนลดได้จริงไหม) ***:
  // เพิ่ม "เงื่อนไข" กลับเข้ามา (ตัดออกไปตอนย่อการ์ดรอบก่อน) — สมมติว่าส่วนลดเป็นต่อเข็ม
  // (ตรงกับตัวอย่างที่ Yai ให้มา) ถ้าในอนาคตมีโปรที่ไม่ใช่ต่อเข็ม ต้องปรับคำตรงนี้
  for (const p of promos ?? []) {
    const lines: BodyLine[] = [];
    if (p.discount) lines.push(`ลด ${p.discount} บาทต่อเข็ม`);
    if (p.condition) lines.push({ text: `เงื่อนไข: ${p.condition}`, color: TEXT_MUTED });
    bubbles.push(newsBubble(NEWS_BADGE_PROMO, BRAND_GREEN_DARK, p.title, lines, { heroUrl: `${MENU_HERO_BASE}/menu_hero_news_promo.png` }));
  }
  // hook: ใช้ short_hook ที่เขียนไว้ดีแล้ว (สรุปสั้นอ่านลื่น) ถ้ามี — fallback ไปตัด description
  // ดิบๆ ที่ 40 ตัวอักษรเฉพาะแถวที่ยังไม่มี short_hook (เผื่อเพิ่มข่าวใหม่แล้วลืมใส่)
  const trimHook = (s: string) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
  for (const n of vaccineNews ?? []) {
    const hookText = n.short_hook ?? (n.description ? trimHook(n.description) : null);
    const hook: BodyLine[] = hookText ? [hookText] : [];
    const buttons: FlexButton[] = [];
    if (phone) buttons.push({ label: "สอบถามเพิ่มเติม", uri: `tel:${phone}` });
    if (n.description) buttons.push({ label: "📄 ดูข้อความทั้งหมด", text: `ดูข้อความเต็ม: ${n.vaccine_name}` });
    bubbles.push(newsBubble(NEWS_BADGE_VACCINE, "#2563EB", n.vaccine_name, hook, { buttons, heroUrl: `${MENU_HERO_BASE}/menu_hero_news_vaccine.png` }));
  }
  // *** แก้ 2026-09-03 (feedback: ตัดเหตุผลออก โชว์แค่วันพอ + แยกสีปิดประจำ/ปิดพิเศษ) ***
  if (closureParts.weekly || closureParts.nearestDate) {
    const lines: BodyLine[] = [];
    if (closureParts.weekly) lines.push({ text: closureParts.weekly, color: "#C2410C" });
    if (closureParts.nearestDate) lines.push({ text: closureParts.nearestDate, color: BRAND_GREEN_DARK });
    bubbles.push(newsBubble(NEWS_BADGE_CLOSURE, "#C2410C", "วันหยุดที่จะถึงนี้", lines, { heroUrl: `${MENU_HERO_BASE}/menu_hero_news_closure.png` }));
  }

  const altText = bubbles.length
    ? `มีข่าวสาร ${bubbles.length} เรื่อง — เลื่อนดูในแชทได้เลยค่ะ`
    : "ช่วงนี้ยังไม่มีข่าวสารใหม่ค่ะ";

  if (bubbles.length === 0) {
    // carousel ว่างส่งไม่ได้ตาม LINE spec — ใช้ bubble เดี่ยวแทนกรณีไม่มีข่าวสารเลย
    return {
      type: "flex",
      altText,
      contents: newsBubble("📰 ข่าวสาร", BRAND_GREEN_DARK, "ยังไม่มีข่าวสารใหม่ตอนนี้", ["แวะกลับมาเช็คใหม่อีกครั้งนะคะ 😊"]),
    };
  }

  return { type: "flex", altText, contents: { type: "carousel", contents: bubbles.slice(0, 10) } };
}

/** ข้อความเต็มของข่าววัคซีน ตอบกลับตอนกดปุ่ม "📄 ดูข้อความทั้งหมด" ในการ์ด carousel */
async function buildVaccineNewsFullText(vaccineName: string): Promise<string> {
  const { data } = await admin
    .from("vaccine_news").select("vaccine_name, description")
    .eq("vaccine_name", vaccineName).eq("status", true).maybeSingle();
  if (!data?.description) {
    return "ขออภัยค่ะ ไม่พบรายละเอียดข่าวนี้แล้ว อาจถูกปรับปรุงไปแล้ว สอบถามเพิ่มเติมได้ที่เจ้าหน้าที่ค่ะ";
  }
  return `💉 ${data.vaccine_name}\n\n${data.description}`;
}


// Thai date: "2026-08-22" -> "22 ส.ค. 2569"
const TH_MON = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
function thaiDate(ymd: string): string {
  const d = new Date(ymd + "T00:00:00");
  return `${d.getDate()} ${TH_MON[d.getMonth()]} ${d.getFullYear() + 543}`;
}

// เบอร์คลินิกสำรอง ใช้เฉพาะกรณี clinic_config อ่านไม่สำเร็จ/ยังไม่มีค่า — ต้องตรงกับ
// fallback เดิมที่ใช้ใน APPOINTMENT_CHANGE ด้านล่าง (ค่าเดียวกันทั้งไฟล์)
const CLINIC_PHONE_FALLBACK = "085-065-9715";

/** One reply brain for every channel — replaces the old system's 5 duplicated
 *  buildClinicMessageForLine/Messenger/Facebook/... builders.
 *
 *  *** แก้ 2026-08-30 ***: เดิมไม่มี try/catch ล้อม admin.from() เลย — ถ้า Supabase
 *  สะดุด exception จะทะลุขึ้นไปทั้งสาย (buildReplyMessages -> route handler ที่ไม่มี
 *  try/catch เหมือนกัน) จบที่ไม่ตอบอะไรกลับผู้ใช้เลย ทุก case ที่เรียก config() (SERVICES/
 *  CONTACT/APPOINTMENT_CHANGE/ฯลฯ) จะพังแบบเงียบๆ ได้หมดถ้า Supabase มีปัญหาชั่วคราว —
 *  ครอบ try/catch คืน null แทนการปล่อยให้พังทั้งสาย (ผู้เรียกทุกจุดมี ?? fallback อยู่แล้ว)
 */
async function config(key: string): Promise<string | null> {
  try {
    const { data } = await admin.from("clinic_config").select("value").eq("key", key).maybeSingle();
    return data?.value ?? null;
  } catch (err) {
    console.error(`config("${key}"): Supabase query failed, falling back to null`, err);
    return null;
  }
}

/** ข้อความ safety-net สุดท้าย — ต้องส่งเสมอเมื่อ (1) detector จับ intent อะไรไม่ได้เลย
 *  (ตกไป default case) หรือ (2) เกิด exception ระหว่างประมวลผล (ดู buildReplyMessages
 *  ท้ายไฟล์) ไม่ใช่ error message ทางเทคนิค แต่เป็นข้อความสุภาพที่ชี้ทางให้โทรคลินิก
 *  โดยเฉพาะกรณีเร่งด่วน/เรื่องอาการ — เบอร์ดึงจาก config เสมอ ไม่ hardcode */
async function buildSafetyNetMessage(): Promise<string> {
  let phone = CLINIC_PHONE_FALLBACK;
  try {
    phone = (await config("PHONE")) ?? CLINIC_PHONE_FALLBACK;
  } catch {
    // config() ครอบ try/catch ของตัวเองแล้ว ไม่ควร throw มาถึงตรงนี้ได้เลย — เผื่อไว้
    // อีกชั้นเพื่อยืนยันว่าฟังก์ชันนี้ "ห้ามพังเด็ดขาด" ไม่ว่าจะเกิดอะไรขึ้นก่อนหน้า
  }
  // *** แก้ 2026-09-01 (bug 2) ***: เปลี่ยนโทนจาก "อาจไม่เข้าใจข้อความนี้" (สื่อเหมือนบอท
  // พลาด) เป็นโทนต้อนรับเชิงบวก — เหตุผลเดียวกับที่แก้ FALLBACK_MESSAGE ใน clinic_config
  // (ดู update-clinic-config ที่ deploy พร้อมกันรอบนี้) ข้อความนี้เป็นชั้นสำรองกรณี
  // FALLBACK_MESSAGE ว่าง/Supabase ล่ม จึงต้องปรับให้โทนตรงกันด้วย
  return (
    "สวัสดีค่ะ 😊 น้องไดโนช่วยตอบได้ดีที่สุดสำหรับเรื่องทั่วไปค่ะ " +
    `หากต้องการสอบถามเร่งด่วนหรือเรื่องอาการของลูกน้อย กรุณาโทร ☎️ ${phone} ได้เลยค่ะ`
  );
}

// Used both when a message-type event isn't text (image/sticker/etc. — see
// line.ts/messenger.ts) and for the MEDICAL_QUESTION intent below. Two variants
// because the reference text opens with "ขอบคุณที่ส่งรูปมาให้ดูนะคะ" (thanks for
// the photo), which would be wrong to say back to someone who only typed words.
//
// *** แก้ 2026-08-30 ***: ทั้ง 3 ข้อความนี้ (รวม INCOMPLETE_PHONE_MESSAGE ด้านล่าง) เดิม
// hardcode เบอร์ 085-065-9715 ไว้ตรงๆ เป็น const string ไม่ได้ดึงจาก clinic_config เหมือน
// SERVICES/CONTACT/APPOINTMENT_CHANGE — ถ้าเปลี่ยนเบอร์ผ่าน Dashboard จุดเหล่านี้จะยังโชว์
// เบอร์เก่าค้าง แปลงเป็น async function ดึงเบอร์จาก config() ทุกครั้งที่เรียก (มี fallback
// เดียวกันถ้า config ว่าง) — ผู้เรียกใน line.ts/messenger.ts ต้อง await ฟังก์ชันเหล่านี้แทน
// *** แก้ 2026-08-30 (Yai) ***: ย่อหน้าที่ 2 เปลี่ยนจาก "ไข้สูง ซึม ไม่ดื่มนม หายใจ
// ลำบาก...พาน้องมาพบแพทย์ทันที หรือโทรคลินิก" เป็น "ไข้สูงมากร่วมกับอาการ...ไปโรงพยาบาล
// ทันที" — เหตุผลจากหมอเจ้าของคลินิก (Yai): (1) "ไข้สูงมากร่วมกับอาการ ซึม/ไม่ดื่มนม/
// หายใจลำบาก" หมายถึงอาการทั้งชุดรวมกันคือสัญญาณรุนแรง ไม่ใช่ตัดกรณีไข้สูงเดี่ยวๆ ออก —
// ไข้สูงมากแต่ไม่ซึมอาจไม่ serious เท่า (2) เปลี่ยนจากพบแพทย์ที่คลินิก/โทรคลินิก เป็นไป
// รพ. ตรงเพราะข้อความนี้เจอตอนอาการรุนแรงซึ่งมักเกิดนอกเวลาทำการคลินิก และเคสรุนแรงใน
// เด็กเล็กมากอาจต้องตรวจเพิ่มเติมพิเศษที่ รพ. เท่านั้น — ไม่มีเบอร์โทรในย่อหน้านี้แล้ว
// (ตั้งใจ ไม่ใช่พลาด) จึงไม่ต้องดึง config("PHONE") มาใช้ในสองฟังก์ชันนี้อีกต่อไป — ย่อหน้า
// แรก (คำแนะนำทั่วไปกรณีไม่รุนแรง ให้พบแพทย์ที่คลินิก) ยังคงเดิมทุกตัวอักษร
//
// *** แก้ chunk 3 (2026-09-01) ***: ในทางปฏิบัติรูปที่ส่งเข้ามาส่วนใหญ่คือถามสินค้า
// (ยา/นม/วัคซีน) ไม่ใช่ถามอาการ — เพิ่มย่อหน้าแรกชวนพิมพ์ชื่อยี่ห้อ/รุ่นแทน (เพื่อให้บอต
// เช็คสต็อกจากข้อความได้ ดู PRODUCT_STOCK_INQUIRY) ส่วนคำแนะนำเรื่องความปลอดภัยทาง
// การแพทย์ของหมอ (Yai) ด้านล่างยังคงไว้ทุกตัวอักษรเผื่อเป็นรูปอาการจริงๆ — บอตแยกไม่ได้
// จากรูปอย่างเดียวว่าเป็นกรณีไหน จึงให้คำตอบครอบคลุมทั้งสองกรณีเสมอ
export async function buildMedicalQuestionAttachmentMessage(): Promise<string> {
  return (
    "เห็นรูปแล้วค่ะ 📸 รบกวนพิมพ์ชื่อยี่ห้อ/รุ่นที่สอบถามด้วยนะคะ จะได้เช็คสต็อก/ราคาให้ถูกต้องค่ะ\n\n" +
    "แต่ถ้าเป็นการสอบถามอาการของน้อง น้องไดโนไม่สามารถวินิจฉัยอาการจากรูปภาพหรือข้อความได้ค่ะ " +
    "เพื่อความปลอดภัยของน้อง แนะนำให้พาน้องมาพบแพทย์ที่คลินิกเพื่อตรวจอย่างละเอียดนะคะ\n\n" +
    "หากมีอาการรุนแรง เช่น ไข้สูงมากร่วมกับอาการ ซึม ไม่ดื่มนม หายใจลำบาก กรุณารีบพาน้องไปโรงพยาบาลทันที"
  );
}

async function buildMedicalQuestionTextMessage(): Promise<string> {
  return (
    "ขอบคุณที่แจ้งอาการมานะคะ 🙏 น้องไดโนไม่สามารถวินิจฉัยอาการจากข้อความได้ค่ะ " +
    "เพื่อความปลอดภัยของน้อง แนะนำให้พาน้องมาพบแพทย์ที่คลินิกเพื่อตรวจอย่างละเอียดนะคะ\n\n" +
    "หากมีอาการรุนแรง เช่น ไข้สูงมากร่วมกับอาการ ซึม ไม่ดื่มนม หายใจลำบาก กรุณารีบพาน้องไปโรงพยาบาลทันที"
  );
}

// *** เพิ่ม 2026-08-31 ***: เดิมเป็น stub ข้อความ static บอกให้โทรถามเอง ไม่เคยเช็คสต็อกจริง
// เลย ตอนนี้ผูกกับ stock_items จริง (sync จาก KallayaClinic.mdb ทุกวัน 20:00) — ถ้าลูกค้า
// เอ่ยชื่อสินค้าเจาะจง (เช่น "มีนม Enfalac ไหม") ตอบเฉพาะรายการนั้น ถ้าถามกว้างๆ (เช่น
// "มีนมไหม", "มียาไหม" — คำที่ KW.productStock จับอยู่แล้ว) ตอบสรุปตามลำดับความสำคัญ:
// นมก่อน ตามด้วยวัคซีน 7 รายการที่ถามบ่อย (ดู services/stock.ts) จำนวนที่โชว์ลูกค้าเป็น
// สถานะ (มี/ใกล้หมด/หมด) ไม่ใช่ตัวเลขจริง — ตัวเลขจริงมีแค่ใน Dashboard/แจ้งเตือน LINE ฝั่ง
// admin เท่านั้น
async function buildProductStockMessage(text: string): Promise<string> {
  try {
    const specific = await findSpecificStockMatches(text);
    if (specific.length > 0) return buildSpecificStockReply(specific);
    const overview = await getPriorityStockOverview();
    return buildOverviewStockReply(overview);
  } catch (err) {
    console.error("buildProductStockMessage: stock lookup failed, falling back to phone referral", err);
    const phone = (await config("PHONE")) ?? CLINIC_PHONE_FALLBACK;
    return (
      "ขอบคุณที่สอบถามนะคะ 🙏 ขณะนี้ระบบเช็คสต็อกขัดข้องชั่วคราวค่ะ " +
      `กรุณาโทรสอบถามเจ้าหน้าที่โดยตรงนะคะ ☎️ ${phone} (ในเวลาทำการ)`
    );
  }
}

// Age-picker quick-reply — the entry point when someone asks about vaccines
// without naming one or giving an age (e.g. bare "วัคซีน"). Each button resends
// its own payload through the normal text pipeline: "วัคซีน 2 เดือน" etc. always
// includes the word "วัคซีน" so it passes the existing vaccine-branch gate below,
// and every payload uses an explicit month number (not "1 ปีครึ่ง") because
// parseAgeMonths() doesn't understand "ครึ่ง" — sending "18 เดือน" sidesteps that
// instead of teaching the parser a one-off case. "4-12 ปี" is a range, not a
// single age, so it's matched as literal text below rather than parsed as a month count.
const AGE_PICKER_ITEMS = [
  { label: "2 เดือน", text: "วัคซีน 2 เดือน" },
  { label: "4 เดือน", text: "วัคซีน 4 เดือน" },
  { label: "6 เดือน", text: "วัคซีน 6 เดือน" },
  { label: "9 เดือน", text: "วัคซีน 9 เดือน" },
  { label: "1 ปี", text: "วัคซีน 12 เดือน" },
  { label: "1 ปีครึ่ง", text: "วัคซีน 18 เดือน" },
  { label: "2 ปี", text: "วัคซีน 24 เดือน" },
  { label: "3 ปี", text: "วัคซีน 36 เดือน" },
  { label: "4 ปี", text: "วัคซีน 48 เดือน" },
  { label: "4-12 ปี", text: "วัคซีน 4-12 ปี" },
].map((it) => ({ type: "action", action: { type: "message", label: it.label, text: it.text } }));

const AGE_GROUP_4_TO_12_YEARS = ["48M", "51M", "132M", "138M"];

// *** เพิ่ม 2026-09-03 ***: ผูกทุกปุ่มใน AGE_PICKER_ITEMS เข้ากับ vaccine_doses.age_group
// จริง + ไฟล์ hero image (อัปโหลดไว้ที่ Supabase Storage bucket "vaccine-hero", public) —
// ใช้ทั้งฝั่ง Flex (LINE) และฝั่งข้อความล้วน (Messenger) ทางเดียวกันหมด ไม่มีอายุไหนตอบ
// จาก hardcode อีกต่อไป (ก่อนหน้านี้ 2/4/6/9/12/18 เดือน ตอบจากข้อความ hardcode)
const HERO_BASE = `${env.supabaseUrl}/storage/v1/object/public/vaccine-hero`;
const AGE_CODE_MAP: Record<number, { codes: string[]; label: string; hero: string }> = {
  2: { codes: ["2M"], label: "2 เดือน", hero: `${HERO_BASE}/vaccine_hero_2M.png` },
  4: { codes: ["4M"], label: "4 เดือน", hero: `${HERO_BASE}/vaccine_hero_4M.png` },
  6: { codes: ["6M"], label: "6 เดือน", hero: `${HERO_BASE}/vaccine_hero_6M.png` },
  9: { codes: ["9M"], label: "9 เดือน", hero: `${HERO_BASE}/vaccine_hero_9M.png` },
  12: { codes: ["12M"], label: "1 ปี", hero: `${HERO_BASE}/vaccine_hero_12M.png` },
  18: { codes: ["18M"], label: "1 ปีครึ่ง", hero: `${HERO_BASE}/vaccine_hero_18M.png` },
  24: { codes: ["24M"], label: "2 ปี", hero: `${HERO_BASE}/vaccine_hero_24M.png` },
  36: { codes: ["36M"], label: "3 ปี", hero: `${HERO_BASE}/vaccine_hero_36M.png` },
  48: { codes: ["48M"], label: "4 ปี", hero: `${HERO_BASE}/vaccine_hero_48M.png` },
};
const AGE_GROUP_4_12Y = { codes: AGE_GROUP_4_TO_12_YEARS, label: "4-12 ปี", hero: `${HERO_BASE}/vaccine_hero_4_12Y.png` };

/** ช่วงอายุเดียว ตอบเป็น Flex (LINE) หรือข้อความล้วน (Messenger, Flex เป็นฟอร์แมต LINE
 *  เท่านั้น) — ทั้งคู่ query DB สดเหมือนกัน ต่างกันแค่รูปแบบการแสดงผล
 *  ageMonths: null สำหรับก้อนอายุกว้างอย่าง "4-12 ปี" (ใช้ตัดสินกฎอายุของไข้หวัดใหญ่ในตัว vaccine.ts) */
async function buildAgeGroupReply(
  group: { codes: string[]; label: string; hero: string },
  link: string,
  channel: Channel,
  ageMonths: number | null,
): Promise<ReplyMessage[]> {
  if (channel === "line") {
    const { flex } = await buildAgeCardFlex(group.codes, group.label, group.hero, link, ageMonths);
    return [flex as unknown as FlexMessage];
  }
  return [{ type: "text", text: await buildAgeGroupVaccineList(group.codes, group.label, link, ageMonths) }];
}

async function buildIncompletePhoneMessage(): Promise<string> {
  const phone = (await config("PHONE")) ?? CLINIC_PHONE_FALLBACK;
  return (
    "ขออภัยค่ะ เบอร์โทรศัพท์ที่พิมพ์มายังไม่ครบ 10 หลักค่ะ 🙏\n" +
    "กรุณาตรวจสอบเลขหมายอีกครั้ง แล้วพิมพ์เบอร์โทรที่ลงทะเบียนไว้ (10 หลัก) ให้ครบถ้วนนะคะ\n" +
    `☎️ หากต้องการความช่วยเหลือ ติดต่อคลินิกได้ที่ ${phone}`
  );
}

// A message made up only of digits/spaces/dashes/parens/plus (no other text) is the
// user attempting to answer the "พิมพ์เบอร์โทร (10 หลัก)" prompt — regardless of how
// many digits, so a too-short/too-long attempt still lands here instead of leaking
// into the generic intent fallback (previously: <9 or >11 digits missed this gate
// entirely and fell through to detectIntent()).
function looksLikePhoneAttempt(text: string): boolean {
  const trimmed = text.trim();
  return /\d/.test(trimmed) && /^[0\s\-()+\d]+$/.test(trimmed);
}

// A *complete* phone is exactly 10 digits, or the "66" + 9-digit international
// form. Anything else digit-shaped (9 digits from a dropped leading zero, 11
// random digits, etc.) used to slip through normalizePhone()'s lenient
// auto-correction, get queried anyway, and come back "ไม่พบนัดหมาย" — which told
// the user their registered number wasn't on file when the real problem was a
// mistyped/incomplete number.
function isCompletePhone(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("66"));
}

const TH_DAY: Record<string, string> = {
  Monday: "วันจันทร์", Tuesday: "วันอังคาร", Wednesday: "วันพุธ",
  Thursday: "วันพฤหัสบดี", Friday: "วันศุกร์", Saturday: "วันเสาร์", Sunday: "วันอาทิตย์",
};

/** "เดือนนี้มีวันหยุดต่อเนื่อง ..." block only (no recurring-weekday line). */
async function closuresListText(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: closures } = await admin
    .from("closures").select("start_date, end_date, reason, message, closure_type")
    .eq("active", true).gte("end_date", today).order("start_date").limit(10);
  if (!closures || closures.length === 0) return "";
  const lines = closures.map((c) => {
    const range = c.start_date === c.end_date
      ? thaiDate(c.start_date)
      : `${thaiDate(c.start_date)} – ${thaiDate(c.end_date)}`;
    return `🗓️ ${range}\n${c.message ?? c.reason ?? ""}`;
  });
  return "เดือนนี้มีวันหยุดต่อเนื่อง\n\n" + lines.join("\n\n");
}

/** Recurring weekly-closed line(s), e.g. "🔴 ปิดทุกวันจันทร์เป็นประจำ". */
async function weeklyClosedText(): Promise<string> {
  const { data: hours } = await admin.from("clinic_hours").select("day").eq("status", "CLOSED");
  const closedDays = [...new Set((hours ?? []).map((h) => h.day))];
  return closedDays.map((d) => `🔴 ปิดทุก${TH_DAY[d] ?? d}เป็นประจำ`).join("\n");
}

/** สั้นกว่า closuresListText() — เอามาแค่วันหยุดพิเศษที่ใกล้ที่สุดวันเดียว (ไม่ใช่ทั้งเดือน)
 *  และไม่รวมเหตุผล/ข้อความ (feedback: ผู้ปกครองอยากรู้แค่ "วันไหนปิด" พอ ไม่ต้องรู้สาเหตุ)
 *  คืนค่าแยกเป็น 2 ส่วนเพื่อให้การ์ดข่าวสารใช้คนละสีได้ (ปิดประจำ vs ปิดพิเศษ) — เมนู "วันหยุด"
 *  หลัก (HOLIDAYS/CLOSURE_ANNOUNCEMENT) ยังใช้ closuresListText() แบบเต็ม+เหตุผลเหมือนเดิม */
async function closuresNextOneParts(): Promise<{ weekly: string; nearestDate: string | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: closures } = await admin
    .from("closures").select("start_date, end_date")
    .eq("active", true).gte("end_date", today).order("start_date").limit(1);
  const weekly = await weeklyClosedText();
  const c = closures?.[0];
  if (!c) return { weekly, nearestDate: null };
  const range = c.start_date === c.end_date
    ? thaiDate(c.start_date)
    : `${thaiDate(c.start_date)} – ${thaiDate(c.end_date)}`;
  return { weekly, nearestDate: `🗓️ ${range}` };
}

/** Full holidays summary — recurring line + upcoming closures, used by HOLIDAYS/CLOSURE_ANNOUNCEMENT. */
async function closuresSummaryText(): Promise<string> {
  const [weekly, list] = await Promise.all([weeklyClosedText(), closuresListText()]);
  return [weekly, list].filter(Boolean).join("\n\n");
}

const ymdOf = (d: Date): string => d.toISOString().slice(0, 10);

/** "🟢 เปิดทำการอีกครั้ง ..." line for the nearest open day within 2 weeks after
 *  `fromDate`, or null if none (shared by CLINIC_STATUS and the specific-date case
 *  below — both need "when's the next open day" after finding a closed date). */
async function nextOpenDateLine(fromDate: Date): Promise<string | null> {
  for (let i = 1; i <= 14; i++) {
    const d = new Date(fromDate.getTime() + i * 86400000);
    const st = await getClinicStatus(ymdOf(d));
    if (st.isOpen) {
      const dateLine = st.text.split("\n")[0]?.replace(/ คลินิกเปิดค่ะ.*/, "") ?? "";
      return `🟢 เปิดทำการอีกครั้ง ${dateLine}`;
    }
  }
  return null;
}

/** One day's 🟢/🔴 status line + (if closed) the next-open-date line — shared by
 *  the day-scoped and full CLINIC_STATUS/CLINIC_TIME replies below (see comment
 *  at that case's usage for why day-scoping exists). */
async function dayStatusBlock(target: Date, label: string): Promise<string[]> {
  const status = await getClinicStatus(ymdOf(target));
  const lines = [(status.isOpen ? "🟢 " : "🔴 ") + `${label} ${status.text}`];
  if (!status.isOpen) {
    const line = await nextOpenDateLine(target);
    if (line) lines.push(line);
  }
  return lines;
}

// Ported from resolveUpcomingDateByDayOfMonth_ (old Apps Script, MessageBuilder.gs.js)
// — day-of-month N -> nearest real date (today counts), rolling to next month if
// this month's Nth day already passed or doesn't exist (e.g. day=30 in February).
// `bangkokNow` must come from `new Date(Date.now() + 7*3600*1000)` and is read with
// getUTC*/Date.UTC only (matches clinicStatus.ts's bangkokToday()) so this is
// correct regardless of the server's actual timezone.
function resolveUpcomingDateByDayOfMonth(day: number, bangkokNow: Date): Date | null {
  const y = bangkokNow.getUTCFullYear();
  const m = bangkokNow.getUTCMonth();
  const todayMs = Date.UTC(y, m, bangkokNow.getUTCDate());

  const forMonthOffset = (offset: number): Date | null => {
    const candidate = new Date(Date.UTC(y, m + offset, day));
    return candidate.getUTCDate() === day ? candidate : null;
  };

  const thisMonth = forMonthOffset(0);
  if (thisMonth && thisMonth.getTime() >= todayMs) return thisMonth;
  return forMonthOffset(1);
}

export type Channel = "line" | "messenger";

export async function buildReplyMessages(text: string, channel: Channel): Promise<ReplyMessage[]> {
  // *** แก้ 2026-08-30 ***: ครอบทั้งฟังก์ชันด้วย try/catch — ห้ามเงียบเด็ดขาดไม่ว่า
  // เหตุผลอะไร (detector จับ intent ไม่ได้ก็ตกไป default case ซึ่งตอบเสมออยู่แล้ว แต่ถ้า
  // เกิด exception ระหว่างทาง เช่น Supabase สะดุดใน resolveVaccineGroup()/config()/
  // vaccine.ts ฯลฯ เดิมจะทะลุขึ้นไปถึง route handler ที่ไม่มี try/catch เหมือนกัน จบที่ไม่
  // ส่งอะไรกลับผู้ใช้เลย — เคสจริง 2026-08-30 บน Messenger) ไม่ได้ re-indent โค้ดเดิมด้านใน
  // ทั้งหมดเพื่อให้ diff เทียบง่าย
  try {
  // Fast path: "📄 ดูข้อความทั้งหมด" button from the news carousel -> full description
  // (ปุ่มส่ง message action เป็นข้อความนี้ เหมือนผู้ใช้พิมพ์เอง — pattern เดียวกับปุ่มอื่นๆ
  // ในบอท เช่น "เช็คนัดหมาย" — ไม่ผ่าน detectIntent เพราะเป็นคำสั่งเฉพาะจากปุ่ม ไม่ใช่ประโยค
  // ธรรมชาติที่ต้องตีความ)
  const fullNewsMatch = text.match(/^ดูข้อความเต็ม: (.+)$/);
  if (fullNewsMatch?.[1]) {
    return [{ type: "text", text: await buildVaccineNewsFullText(fullNewsMatch[1]) }];
  }

  // Fast path: a lone phone number = user answering the appointment prompt.
  if (looksLikePhoneAttempt(text)) {
    if (!isCompletePhone(text)) {
      return [{ type: "text", text: await buildIncompletePhoneMessage() }];
    }
    const r = await buildAppointmentResultByPhone(text);
    return [{ type: "text", text: r.text }];
  }

  const r = await detectIntent(text);
  switch (r.intent) {
    case "VACCINE_INFO":
    case "VACCINE_PRICE":
    case "VACCINE_AVAILABILITY": {
      if (!r.vaccineGroup) {
        const link = (await config("VACCINE_ADVISOR")) ??
          "https://baandek-line-worker.baandek-clinic.workers.dev/vaccine-advisor";

        // The "4-12 ปี" picker button is a range, not a single age — matched as
        // literal text rather than going through r.ageMonths (see AGE_PICKER_ITEMS).
        if (text.includes("4-12 ปี")) {
          return await buildAgeGroupReply(AGE_GROUP_4_12Y, link, channel, null);
        }
        // Age already clear -> answer directly, skip the picker (decided: don't
        // re-ask what the user already told us).
        const ageGroup = r.ageMonths != null ? AGE_CODE_MAP[r.ageMonths] : undefined;
        if (ageGroup) {
          return await buildAgeGroupReply(ageGroup, link, channel, r.ageMonths ?? null);
        }

        // No age given, or an age outside every known bucket -> show the picker.
        // *** เพิ่ม 2026-09-03 ***: LINE ได้ Flex hero card สวยๆ แทนข้อความล้วน ปุ่ม
        // quickReply เดิม (AGE_PICKER_ITEMS) ยังติดมาด้วยเหมือนเดิม — quickReply เป็น
        // ฟีเจอร์แยกจากชนิด message ผูกกับ message ประเภทไหนก็ได้ Messenger ไม่รองรับ
        // Flex เลยคงข้อความล้วน + quick reply แบบเดิมไว้
        const promptText =
          "💉 กรุณาเลือกช่วงอายุของน้อง เพื่อดูวัคซีนที่แนะนำตามเกณฑ์อายุค่ะ 😊\n\n" +
          `หรือดูรายการและราคาทั้งหมดได้ที่\n${link}`;
        if (channel === "line") {
          return [{
            type: "flex",
            altText: promptText,
            contents: {
              type: "bubble",
              hero: { type: "image", url: `${HERO_BASE}/vaccine_hero_picker.png`, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
              body: {
                type: "box",
                layout: "vertical",
                backgroundColor: "#FFF6E6",
                paddingAll: "16px",
                contents: [
                  { type: "text", text: "กรุณาเลือกช่วงอายุของน้อง 😊", weight: "bold", size: "md", wrap: true, color: "#3C3C3C" },
                  { type: "text", text: "เพื่อดูวัคซีนที่แนะนำตามเกณฑ์อายุ กดปุ่มด้านล่างเลือกอายุน้องได้เลยค่ะ", wrap: true, size: "sm", color: "#8C8C8C", margin: "sm" },
                ],
              },
              footer: {
                type: "box",
                layout: "vertical",
                paddingAll: "12px",
                contents: [{ type: "button", style: "link", height: "sm", action: { type: "uri", label: "ดูรายการและราคาทั้งหมด", uri: link } }],
              },
            },
            quickReply: { items: AGE_PICKER_ITEMS },
          }];
        }
        return [{ type: "text", text: promptText, quickReply: { items: AGE_PICKER_ITEMS } }];
      }
      const res = await buildVaccineAdvice(r.vaccineGroup, r.ageMonths ?? null);
      // Standard rules only — anything outside a matching rule -> refer to doctor.
      if (res.status !== "ok" || res.cards.length === 0) {
        return [{ type: "text", text: DOCTOR_REFERRAL }];
      }
      const lines = res.cards.map((c) => {
        const opts = c.priceOptions?.length
          ? "\n  " + c.priceOptions.map((p) => `${p.name} ${p.price.toLocaleString()} บาท`).join("\n  ")
          : c.price ? ` — ${c.price.toLocaleString()} บาท` : "";
        const schedule = c.doses
          ? `\n  เข็มมาตรฐาน ${c.doses} เข็ม` + (c.interval ? ` (ห่างกัน ${c.interval} วัน)` : "")
          : "";
        return `• ${c.title} (${c.ageRange})` + opts + schedule + (c.message ? `\n  ${c.message}` : "");
      });
      return [{
        type: "text",
        text: lines.join("\n\n") + "\n\n———\n" +
          "ข้อมูลนี้เป็นแนวทางมาตรฐานค่ะ 🩺 กรณีรับล่าช้า ประวัติไม่ครบ หรือมีข้อสงสัย กรุณาปรึกษาแพทย์ที่คลินิกค่ะ",
      }];
    }
    case "MEDICAL_QUESTION":
      return [{ type: "text", text: await buildMedicalQuestionTextMessage() }];
    case "PRODUCT_STOCK_INQUIRY":
      return [{ type: "text", text: await buildProductStockMessage(r.text) }];
    // *** เพิ่ม 2026-09-01 (bug 4, ยืนยันแล้ว 1 ก.ย.) ***: ข้อความปิดท้ายสนทนา (ขอบคุณ/
    // รับทราบสั้นๆ) เดิมตกไป default case ได้ FALLBACK_MESSAGE เต็ม (ยาวเกินบริบท) — ตอบ
    // emoji สั้นแทน ไม่ต้องส่งข้อความยาว (sticker-only message ก็ตอบแบบเดียวกัน แต่ทำที่
    // routes/line.ts และ routes/messenger.ts เพราะ sticker เป็นคนละ event type จาก text
    // เลย ไม่มีทางส่งมาถึง detectIntent()/buildReplyMessages() ตรงนี้ได้)
    case "END_CONVERSATION":
      return [{ type: "text", text: "🙏" }];
    // *** แก้ 2026-09-01 (bug 3) ***: เดิมถามแค่ "พรุ่งนี้เปิดไหมคะ" (เจาะจงวันเดียว) ก็ยัง
    // ได้คำตอบยาวทั้งวันนี้+พรุ่งนี้+สรุปวันหยุดทั้งเดือนเสมอ ไม่ตรงกับสิ่งที่ถาม — ถ้าข้อความ
    // ระบุ "วันนี้" หรือ "พรุ่งนี้" อย่างใดอย่างหนึ่งเพียงวันเดียว ตอบเฉพาะวันนั้นวันเดียว
    // ถ้าถามกว้างๆ ไม่ระบุวัน (หรือถามทั้งสองวันพร้อมกัน) คงพฤติกรรมเดิมไว้ (วันนี้+พรุ่งนี้+
    // สรุปวันหยุด) เพราะนั่นคือคำถามกว้างจริงๆ ที่สมควรได้คำตอบครบ
    case "CLINIC_STATUS":
    case "CLINIC_TIME": {
      const now = new Date(Date.now() + 7 * 3600 * 1000); // Bangkok
      const tomorrowDate = new Date(now.getTime() + 86400000);
      const mentionsToday = /วันนี้/.test(r.text);
      const mentionsTomorrow = /พรุ่งนี้/.test(r.text);

      let parts: string[];
      if (mentionsTomorrow && !mentionsToday) {
        parts = await dayStatusBlock(tomorrowDate, "พรุ่งนี้");
      } else if (mentionsToday && !mentionsTomorrow) {
        parts = await dayStatusBlock(now, "วันนี้");
      } else {
        parts = await dayStatusBlock(now, "วันนี้");
        parts.push(...(await dayStatusBlock(tomorrowDate, "พรุ่งนี้")));
        const summary = await closuresListText();
        if (summary) parts.push(summary);
      }

      if (channel === "line") {
        return [buildSimpleFlexCard({
          title: "🕐 เวลาทำการวันนี้/พรุ่งนี้",
          heroUrl: `${MENU_HERO_BASE}/menu_hero_clinicstatus.png`,
          bodyLines: parts,
          altText: parts.join("\n\n"),
        })];
      }
      return [{ type: "text", text: parts.join("\n\n") }];
    }
    // Ported from CLINIC_STATUS_SPECIFIC_DATE (old Apps Script) — "วันที่ N เปิดไหม".
    // getClinicStatus() already handles any target date correctly (clinic_hours +
    // closures), so this only needed the day-of-month -> nearest-real-date math above.
    case "CLINIC_STATUS_SPECIFIC_DATE": {
      const now = new Date(Date.now() + 7 * 3600 * 1000);
      const target = resolveUpcomingDateByDayOfMonth(r.specificDay!, now);
      if (!target) {
        return [{
          type: "text",
          text: `ขออภัยค่ะ ไม่พบวันที่ ${r.specificDay} ในเดือนนี้หรือเดือนหน้าค่ะ กรุณาตรวจสอบวันที่อีกครั้งนะคะ`,
        }];
      }
      const status = await getClinicStatus(ymdOf(target));
      const parts: string[] = [(status.isOpen ? "🟢 " : "🔴 ") + status.text];
      if (!status.isOpen) {
        const line = await nextOpenDateLine(target);
        if (line) parts.push(line);
      }
      return [{ type: "text", text: parts.join("\n\n") }];
    }
    // Ported from CLINIC_DATE_UNCLEAR (old Apps Script) — a weekday/month name said
    // without the "วันที่ N" format above (e.g. "วันอังคารเปิดไหม"). Redirects instead
    // of guessing, which used to silently answer with *today's* status regardless of
    // which day was actually asked about.
    case "CLINIC_DATE_UNCLEAR":
      return [{
        type: "text",
        text:
          "รบกวนระบุวันที่อีกครั้งนะคะ เพื่อให้เช็คได้ตรงวันค่ะ 😊\n\n" +
          "📅 พิมพ์ว่า \"วันที่ 12\" (ใส่เฉพาะตัวเลขวันที่)\n" +
          "    ระบบจะเช็ควันที่ใกล้ที่สุดให้ พร้อมบอกวันหยุดพิเศษด้วยค่ะ\n\n" +
          "หรือถ้าต้องการเช็ควันนี้/พรุ่งนี้\n" +
          "    พิมพ์ว่า \"วันนี้เปิดมั้ย\" หรือ \"พรุ่งนี้เปิดมั้ย\" ได้เลยค่ะ",
      }];
    case "LOCATION": {
      const [maps, addr] = await Promise.all([config("GOOGLE_MAPS"), config("ADDRESS")]);
      const text = `📍 คลินิกบ้านเด็ก\n\n${addr ?? ""}` +
        (maps ? `\n\nเปิดเส้นทางใน Google Maps:\n${maps}` : "");
      if (channel === "line") {
        return [buildSimpleFlexCard({
          title: "📍 คลินิกบ้านเด็ก",
          heroUrl: `${MENU_HERO_BASE}/menu_hero_location.png`,
          bodyLines: [addr ?? ""],
          buttons: maps ? [{ label: "เปิดเส้นทางใน Google Maps", uri: maps }] : undefined,
          altText: text,
        })];
      }
      return [{ type: "text", text }];
    }
    case "APPOINTMENT_CHECK": {
      // The "เช็คนัดหมาย" booking-menu button (and natural "เช็คนัด"/"ตรวจสอบนัด"
      // phrasings) land here. Deliberately stateless: we just prompt for a phone
      // number, and the looksLikePhoneAttempt fast-path at the top of
      // buildReplyMessages() picks up whatever number the user sends next and runs
      // buildAppointmentResultByPhone(). A bare phone number is unambiguous enough to
      // route on its own, so there's no need to track who was asked (matches the
      // old Cloudflare Worker's flow minus its awaiting-phone KV state).
      const base =
        "กรุณาพิมพ์เบอร์โทรศัพท์ที่ลงทะเบียนนัดหมายไว้ (10 หลัก) ค่ะ 📱\n\n" +
        "ระบบจะตรวจสอบนัดหมายที่กำลังจะถึงให้นะคะ\n\n" +
        "⚠️ ระบบค้นหาด้วยเบอร์โทรศัพท์ กรุณาตรวจสอบว่าเบอร์ถูกต้อง เผื่อกรณีเบอร์ถูกส่งต่อ/เปลี่ยนมือ อาจแสดงข้อมูลของผู้อื่นได้";
      // LINE-only UI hint: on LINE the keyboard is often collapsed behind the Rich
      // Menu, so parents don't see where to type. Irrelevant on Messenger.
      const lineHint =
        "\n\nหากไม่เห็นช่องพิมพ์ข้อความ กรุณากดไอคอนคีย์บอร์ด ⌨️ ที่มุมซ้ายล่างก่อนนะคะ";
      return [{ type: "text", text: channel === "line" ? base + lineHint : base }];
    }
    // *** เพิ่ม 2026-09-01 (bug 5) ***: เดิม "นัด" ใน apptChange (bare keyword) ดักคำถามยืนยัน
    // มาตามนัดเดิม (เช่น "...หรือไปก่อนคะ") ไปตอบเนื้อหาเลื่อนนัดทั้งที่ลูกค้าไม่ได้ขอเลื่อน —
    // แยก intent นี้ออกมา ตอบยืนยันเป็นประโยคแรกเสมอ ตามด้วยเกณฑ์อายุ/ระยะห่างเข็มที่เกี่ยวข้อง
    // สั้นๆ (ตอบตรงคำถาม "หรือไปก่อน" ได้เลยในตัว) ไม่ดึงข้อความเลื่อนนัดทั้งก้อนมาซ้ำ
    case "APPOINTMENT_CONFIRM": {
      const phone = (await config("PHONE")) ?? CLINIC_PHONE_FALLBACK;
      return [{
        type: "text",
        text:
          "มาตามวันนัดเดิมได้เลยค่ะ 😊\n\n" +
          "ไม่แนะนำให้มาก่อนวันนัด เนื่องจากระยะห่างระหว่างเข็มวัคซีนมีเกณฑ์กำหนดไว้ตามอายุ มาก่อนอาจยังไม่ครบกำหนดที่จะฉีดได้ค่ะ\n\n" +
          "หากมีเหตุจำเป็นไม่สามารถมาตามนัดเดิมได้ พาน้องมาหลังวันนัดเดิมได้ค่ะ (พิมพ์ \"เลื่อนนัด\" เพื่อดูรายละเอียดเพิ่มเติม)\n\n" +
          `หากไม่แน่ใจ สามารถโทรสอบถามคลินิกในเวลาทำการได้ค่ะ ☎️ ${phone}`,
      }];
    }
    case "APPOINTMENT_CHANGE": {
      // Ported verbatim from buildAppointmentChangeReply() (old Apps Script,
      // MessageBuilder.gs.js) per explicit instruction to keep the original
      // wording exactly ("พาน้องมา", not "ติดต่อคลินิก") — proven rule-based
      // guidance, replacing the old system's placeholder-short "โทรติดต่อคลินิก".
      // booking.ts still only creates new bookings (no reschedule endpoint), so
      // this is guidance/next-steps text, not something the bot resolves itself.
      //
      // Channel-split kept as agreed: LINE already has a "เช็คนัดหมาย" Rich Menu
      // button, so the guidance stands alone. Messenger has no phone-check flow
      // at all (LIFF booking only opens inside LINE), so it also gets a nudge
      // toward the LINE OA.
      const phone = (await config("PHONE")) ?? "085-065-9715";
      const base =
        "📅 กรณีเปลี่ยนวันนัดหรือมาช้ากว่านัด\n\n" +
        "หากไม่สะดวกมาตามวันนัดเดิม โดยทั่วไปสามารถพาน้องมาหลังวันนัดเดิมได้ค่ะ\n\n" +
        "สำหรับการรับวัคซีน ไม่แนะนำให้มาก่อนวันนัด เนื่องจากระยะห่างของวัคซีนอาจยังไม่ครบตามเกณฑ์\n\n" +
        "หากพลาดวันนัดแล้ว แนะนำให้พาน้องมาโดยเร็วที่สุดในวันที่สะดวกค่ะ\n\n" +
        "เมื่อมาถึงคลินิก แพทย์จะตรวจสอบประวัติและวางแผนการรับวัคซีนที่เหมาะสมให้อีกครั้ง\n\n" +
        "หากไม่แน่ใจ สามารถโทรสอบถามคลินิกในเวลาทำการได้ค่ะ\n\n" +
        `☎️ ${phone}`;
      if (channel === "line") {
        return [{ type: "text", text: base }];
      }
      const lineOa = (await config("LINE_OA")) ?? "@739fjvrr";
      return [{
        type: "text",
        text: base +
          `\n\n💡 ทราบหรือไม่คะ ทาง LINE Official Account "คลินิกบ้านเด็ก" สามารถเช็คนัดหมายด้วยเบอร์โทรได้เองทันทีค่ะ ` +
          `เพิ่มเพื่อนได้ที่ LINE ID: ${lineOa}`,
      }];
    }
    case "SERVICES": {
      const phone = await config("PHONE");
      const text = "🏥 บริการของเรา\n\n" +
        "🩺 คลินิกตรวจโรคทั่วไป\n" +
        "ราคา 300–1,000+ บาท (ขึ้นกับค่ายาและเวชภัณฑ์)\n" +
        "(รวมกลุ่มอาการป่วยทั่วไปและอาการปวดศีรษะ)\n\n" +
        "👶 คลินิกสุขภาพเด็กดี\n" +
        "รวมคำแนะนำด้านพัฒนาการและการเลี้ยงดูเด็ก\n\n" +
        "กรุณาสอบถามราคาและรายละเอียดเพิ่มเติมกับเจ้าหน้าที่ก่อนเข้ารับบริการค่ะ" +
        (phone ? `\n☎️ ${phone}` : "");
      if (channel === "line") {
        return [buildSimpleFlexCard({
          title: "🏥 บริการของเรา",
          heroUrl: `${MENU_HERO_BASE}/menu_hero_service.png`,
          bodyLines: [
            "🩺 คลินิกตรวจโรคทั่วไป — 300–1,000+ บาท (ขึ้นกับค่ายาและเวชภัณฑ์)",
            "👶 คลินิกสุขภาพเด็กดี — คำแนะนำด้านพัฒนาการและการเลี้ยงดูเด็ก",
            "กรุณาสอบถามราคาและรายละเอียดเพิ่มเติมกับเจ้าหน้าที่ก่อนเข้ารับบริการค่ะ" + (phone ? ` ☎️ ${phone}` : ""),
          ],
          altText: text,
        })];
      }
      return [{ type: "text", text }];
    }
    case "HOLIDAYS":
    case "CLOSURE_ANNOUNCEMENT": {
      const summary = await closuresSummaryText();
      const body = summary || "ช่วงนี้คลินิกไม่มีวันหยุดพิเศษค่ะ 😊 เปิดตามเวลาปกติ";
      const text = "📅 วันหยุดของคลินิกบ้านเด็ก\n\n" + body + "\n\nกรุณาวางแผนก่อนเข้ารับบริการนะคะ";
      if (channel === "line") {
        return [buildSimpleFlexCard({
          title: "📅 วันหยุดของคลินิกบ้านเด็ก",
          heroUrl: `${MENU_HERO_BASE}/menu_hero_holidays.png`,
          bodyLines: [body, "กรุณาวางแผนก่อนเข้ารับบริการนะคะ"],
          altText: text,
        })];
      }
      return [{ type: "text", text }];
    }
    case "NEWS": {
      // *** เพิ่ม 2026-09-03 (รอบค่ำ) ***: เดิมกดปุ่ม "ข่าวสาร" แล้วต้องเลือกหมวดก่อน (โปรโมชั่น/
      // วัคซีนใหม่/ประกาศปิดคลินิก) ถึงจะเห็นเนื้อหาจริง หลายคนไม่กดต่อดูหมวดอื่น — เปลี่ยนเป็น
      // carousel รวมทุกเรื่องไว้ในการ์ดเดียว เลื่อนดูได้เลยไม่ต้องเลือกก่อน (LINE เท่านั้น,
      // Messenger ยังเป็น quick-reply แบบเดิมเพราะ carousel เป็นฟอร์แมต LINE Flex)
      if (channel === "line") {
        return [await buildNewsCarousel()];
      }
      const items = [
        { type: "action", action: { type: "message", label: "โปรโมชั่น", text: "โปรโมชั่น" } },
        { type: "action", action: { type: "message", label: "วัคซีนใหม่", text: "วัคซีนใหม่" } },
        { type: "action", action: { type: "message", label: "ประกาศปิดคลินิก", text: "ประกาศปิดคลินิก" } },
      ];
      return [{ type: "text", text: "สนใจข้อมูลเรื่องไหนดีคะ เลือกได้เลยค่ะ 👇", quickReply: { items } }];
    }
    case "VACCINE_NEWS": {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await admin
        .from("vaccine_news").select("vaccine_name, description")
        .eq("status", true)
        .in("channel", ["bot", "both"])
        .or(`expire_date.is.null,expire_date.gte.${today}`);
      if (!data || data.length === 0)
        return [{ type: "text", text: "ไม่มีวัคซีนใหม่ช่วงนี้ค่ะ" }];
      const lines = data.map((n) => `📰 ${n.vaccine_name}\n${n.description ?? ""}`);
      const [footer, version] = await Promise.all([config("FOOTER"), config("VERSION")]);
      const tail = [footer, version].filter(Boolean).join("\n");
      return [{ type: "text", text: "💉 วัคซีนใหม่\n\n" + lines.join("\n\n") + (tail ? `\n\n${tail}` : "") }];
    }
    case "PROMOTIONS": {
      const today = new Date().toISOString().slice(0, 10);
      const { data: promos } = await admin
        .from("promotions").select("title, vaccine_group, discount, condition")
        .eq("active", true)
        .in("kind", ["bot", "both"])
        .or(`start_date.is.null,start_date.lte.${today}`)
        .or(`end_date.is.null,end_date.gte.${today}`);
      if (!promos || promos.length === 0)
        return [{ type: "text", text: "ช่วงนี้ยังไม่มีโปรโมชันค่ะ 😊" }];
      const lines = promos.map((p) =>
        `✅ ${p.title}\n` +
        (p.vaccine_group ? `กลุ่มวัคซีน: ${p.vaccine_group}\n` : "") +
        (p.discount ? `ส่วนลด: ${p.discount}\n` : "") +
        (p.condition ? `เงื่อนไข: ${p.condition}` : ""));
      return [{
        type: "text",
        text: "🎉 โปรโมชั่นปัจจุบัน\n\n" + lines.join("\n\n") +
          "\n\nหมายเหตุ: โปรโมชั่นอาจมีการเปลี่ยนแปลง กรุณาสอบถามแอดมินอีกครั้งค่ะ",
      }];
    }
    case "CONTACT": {
      const [phone, fbPage, lineOa] = await Promise.all([
        config("PHONE"), config("FACEBOOK_PAGE"), config("LINE_OA_ID"),
      ]);
      const lines = ["📞 ติดต่อพนักงาน", ""];
      if (phone) lines.push(`☎️ โทร: ${phone}`);
      if (fbPage) lines.push(`💬 Messenger: https://m.me/${fbPage}`);
      if (fbPage) lines.push(`👍 Facebook: https://www.facebook.com/${fbPage}`);
      if (lineOa) lines.push(`🟢 LINE: ${lineOa}`);
      lines.push("", "ยินดีให้บริการในเวลาทำการค่ะ");
      const text = lines.join("\n");
      if (channel === "line") {
        const bodyLines: string[] = [];
        if (phone) bodyLines.push(`☎️ โทร: ${phone}`);
        if (fbPage) bodyLines.push(`👍 Facebook: facebook.com/${fbPage}`);
        if (lineOa) bodyLines.push(`🟢 LINE: ${lineOa}`);
        bodyLines.push("ยินดีให้บริการในเวลาทำการค่ะ");
        const buttons: FlexButton[] = [];
        if (phone) buttons.push({ label: `โทร ${phone}`, uri: `tel:${phone}` });
        if (fbPage) buttons.push({ label: "Facebook", uri: `https://www.facebook.com/${fbPage}` });
        return [buildSimpleFlexCard({
          title: "📞 ติดต่อพนักงาน",
          heroUrl: `${MENU_HERO_BASE}/menu_hero_contact.png`,
          bodyLines,
          buttons,
          altText: text,
        })];
      }
      return [{ type: "text", text }];
    }
    case "BOOKING_MENU": {
      const liffUrl = env.liffId ? `https://liff.line.me/${env.liffId}` : "";
      const text = "ต้องการจองคิว หรือเช็คนัดหมายคะ? 🗓️\nเลือกเมนูด้านล่างได้เลยค่ะ 👇";
      if (channel === "line") {
        // *** แก้ 2026-09-03 ***: เดิม "เช็คนัดหมาย" เป็น quick-reply ลอยแยกจากการ์ด Flex
        // ดูหลุดไม่ติดกัน (feedback จาก Yai) — ย้ายมาเป็นปุ่มที่ 2 ในการ์ดเดียวกันแทน
        const buttons: FlexButton[] = [];
        if (liffUrl) buttons.push({ label: "📅 จองคิว", uri: liffUrl });
        buttons.push({ label: "🔍 เช็คนัดหมาย", text: "เช็คนัดหมาย" });
        return [buildSimpleFlexCard({
          title: "🗓️ จองคิว / เช็คนัดหมาย",
          heroUrl: `${MENU_HERO_BASE}/menu_hero_booking.png`,
          bodyLines: ["ต้องการจองคิวใหม่ หรือเช็คนัดหมายที่จองไว้แล้ว เลือกได้เลยค่ะ"],
          buttons,
          altText: text,
        })];
      }
      const items: unknown[] = [];
      if (liffUrl) items.push({ type: "action", action: { type: "uri", label: "📅 จองคิว", uri: liffUrl } });
      items.push({ type: "action", action: { type: "message", label: "🔍 เช็คนัดหมาย", text: "เช็คนัดหมาย" } });
      return [{ type: "text", text, quickReply: { items } }];
    }
    default: {
      // *** แก้ 2026-08-30 ***: เปลี่ยน hardcoded ultimate fallback จาก "สวัสดีค่ะ..."
      // เดิม (ไม่มีเบอร์/ไม่ชี้ทางกรณีเร่งด่วน) เป็น buildSafetyNetMessage() — ยัง
      // เคารพค่า FALLBACK_MESSAGE ที่ admin ตั้งไว้ใน dashboard เหมือนเดิมถ้ามี
      const fallback = await config("FALLBACK_MESSAGE");
      return [{
        type: "text",
        text: fallback ?? (await buildSafetyNetMessage()),
      }];
    }
  }
  } catch (err) {
    console.error(`buildReplyMessages("${text}", "${channel}") threw — falling back to safety-net message`, err);
    return [{ type: "text", text: await buildSafetyNetMessage() }];
  }
}
