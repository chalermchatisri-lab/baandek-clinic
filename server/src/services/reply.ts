import { admin } from "../lib/supabase";
import { env } from "../lib/env";
import { detectIntent } from "./intent";
import { buildVaccineAdvice, DOCTOR_REFERRAL } from "./vaccine";
import { getClinicStatus } from "./clinicStatus";
import { buildAppointmentResultByPhone } from "./appointmentCheck";

export type TextMessage = { type: "text"; text: string; quickReply?: unknown };

// Thai date: "2026-08-22" -> "22 ส.ค. 2569"
const TH_MON = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
function thaiDate(ymd: string): string {
  const d = new Date(ymd + "T00:00:00");
  return `${d.getDate()} ${TH_MON[d.getMonth()]} ${d.getFullYear() + 543}`;
}

/** One reply brain for every channel — replaces the old system's 5 duplicated
 *  buildClinicMessageForLine/Messenger/Facebook/... builders. */
async function config(key: string): Promise<string | null> {
  const { data } = await admin.from("clinic_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// Used both when a message-type event isn't text (image/sticker/etc. — see
// line.ts/messenger.ts) and for the MEDICAL_QUESTION intent below. Two variants
// because the reference text opens with "ขอบคุณที่ส่งรูปมาให้ดูนะคะ" (thanks for
// the photo), which would be wrong to say back to someone who only typed words.
export const MEDICAL_QUESTION_ATTACHMENT_MESSAGE =
  "ขอบคุณที่ส่งรูปมาให้ดูนะคะ 🙏 น้องไดโนไม่สามารถวินิจฉัยอาการจากรูปภาพหรือข้อความได้ค่ะ " +
  "เพื่อความปลอดภัยของน้อง แนะนำให้พาน้องมาพบแพทย์ที่คลินิกเพื่อตรวจอย่างละเอียดนะคะ\n\n" +
  "หากมีอาการรุนแรง เช่น ไข้สูง ซึม ไม่ดื่มนม หายใจลำบาก กรุณารีบพาน้องมาพบแพทย์ทันที หรือโทร ☎️ 085-065-9715";

const MEDICAL_QUESTION_TEXT_MESSAGE =
  "ขอบคุณที่แจ้งอาการมานะคะ 🙏 น้องไดโนไม่สามารถวินิจฉัยอาการจากข้อความได้ค่ะ " +
  "เพื่อความปลอดภัยของน้อง แนะนำให้พาน้องมาพบแพทย์ที่คลินิกเพื่อตรวจอย่างละเอียดนะคะ\n\n" +
  "หากมีอาการรุนแรง เช่น ไข้สูง ซึม ไม่ดื่มนม หายใจลำบาก กรุณารีบพาน้องมาพบแพทย์ทันที หรือโทร ☎️ 085-065-9715";

const PRODUCT_STOCK_MESSAGE =
  "ขอบคุณที่สอบถามนะคะ 🙏 เรื่องสต็อกสินค้า (นม/ยา/เวชภัณฑ์) ขณะนี้ระบบยังไม่สามารถเช็คสต็อกแบบเรียลไทม์ได้ค่ะ " +
  "กรุณาโทรสอบถามเจ้าหน้าที่โดยตรงเพื่อความชัดเจนก่อนเดินทางมานะคะ ☎️ 085-065-9715 (ในเวลาทำการ)";

const INCOMPLETE_PHONE_MESSAGE =
  "ขออภัยค่ะ เบอร์โทรศัพท์ที่พิมพ์มายังไม่ครบ 10 หลักค่ะ 🙏\n" +
  "กรุณาตรวจสอบเลขหมายอีกครั้ง แล้วพิมพ์เบอร์โทรที่ลงทะเบียนไว้ (10 หลัก) ให้ครบถ้วนนะคะ\n" +
  "☎️ หากต้องการความช่วยเหลือ ติดต่อคลินิกได้ที่ 085-065-9715";

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

export async function buildReplyMessages(text: string, channel: Channel): Promise<TextMessage[]> {
  // Fast path: a lone phone number = user answering the appointment prompt.
  if (looksLikePhoneAttempt(text)) {
    if (!isCompletePhone(text)) {
      return [{ type: "text", text: INCOMPLETE_PHONE_MESSAGE }];
    }
    const r = await buildAppointmentResultByPhone(text);
    return [{ type: "text", text: r.text }];
  }

  const r = await detectIntent(text);
  switch (r.intent) {
    case "VACCINE_INFO":
    case "VACCINE_PRICE":
    case "VACCINE_AVAILABILITY": {
      if (!r.vaccineGroup)
        return [{
          type: "text",
          text: "💉 ตรวจสอบราคาวัคซีน\n\n" +
            "ราคาวัคซีนขึ้นอยู่กับชนิด ยี่ห้อ จำนวนเข็ม และช่วงอายุของเด็กค่ะ\n\n" +
            "สามารถตรวจสอบรายการและราคาเบื้องต้นได้ที่\n" +
            "https://baandek-line-worker.baandek-clinic.workers.dev/vaccine-advisor\n\n" +
            "กรุณายืนยันราคาและสต็อกกับเจ้าหน้าที่อีกครั้งก่อนรับบริการค่ะ",
        }];
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
      return [{ type: "text", text: MEDICAL_QUESTION_TEXT_MESSAGE }];
    case "PRODUCT_STOCK_INQUIRY":
      return [{ type: "text", text: PRODUCT_STOCK_MESSAGE }];
    case "CLINIC_STATUS":
    case "CLINIC_TIME": {
      const now = new Date(Date.now() + 7 * 3600 * 1000); // Bangkok
      const today = await getClinicStatus(ymdOf(now));
      const parts: string[] = [(today.isOpen ? "🟢 " : "🔴 ") + `วันนี้ ${today.text}`];

      if (!today.isOpen) {
        const line = await nextOpenDateLine(now);
        if (line) parts.push(line);
      }

      const tomorrow = await getClinicStatus(ymdOf(new Date(now.getTime() + 86400000)));
      parts.push((tomorrow.isOpen ? "🟢 " : "🔴 ") + `พรุ่งนี้ ${tomorrow.text}`);

      const summary = await closuresListText();
      if (summary) parts.push(summary);

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
      return [{
        type: "text",
        text: `📍 คลินิกบ้านเด็ก\n\n${addr ?? ""}` +
              (maps ? `\n\nเปิดเส้นทางใน Google Maps:\n${maps}` : ""),
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
      return [{
        type: "text",
        text: "🏥 บริการของเรา\n\n" +
          "🩺 คลินิกตรวจโรคทั่วไป\n" +
          "ราคา 300–1,000+ บาท (ขึ้นกับค่ายาและเวชภัณฑ์)\n" +
          "(รวมกลุ่มอาการป่วยทั่วไปและอาการปวดศีรษะ)\n\n" +
          "👶 คลินิกสุขภาพเด็กดี\n" +
          "รวมคำแนะนำด้านพัฒนาการและการเลี้ยงดูเด็ก\n\n" +
          "กรุณาสอบถามราคาและรายละเอียดเพิ่มเติมกับเจ้าหน้าที่ก่อนเข้ารับบริการค่ะ" +
          (phone ? `\n☎️ ${phone}` : ""),
      }];
    }
    case "HOLIDAYS":
    case "CLOSURE_ANNOUNCEMENT": {
      const summary = await closuresSummaryText();
      const body = summary || "ช่วงนี้คลินิกไม่มีวันหยุดพิเศษค่ะ 😊 เปิดตามเวลาปกติ";
      return [{
        type: "text",
        text: "📅 วันหยุดของคลินิกบ้านเด็ก\n\n" + body + "\n\nกรุณาวางแผนก่อนเข้ารับบริการนะคะ",
      }];
    }
    case "NEWS": {
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
      return [{ type: "text", text: lines.join("\n") }];
    }
    case "BOOKING_MENU": {
      const liffUrl = env.liffId ? `https://liff.line.me/${env.liffId}` : "";
      const items: unknown[] = [];
      if (liffUrl) items.push({ type: "action", action: { type: "uri", label: "📅 จองคิว", uri: liffUrl } });
      items.push({ type: "action", action: { type: "message", label: "🔍 เช็คนัดหมาย", text: "เช็คนัดหมาย" } });
      return [{
        type: "text",
        text: "ต้องการจองคิว หรือเช็คนัดหมายคะ? 🗓️\nเลือกเมนูด้านล่างได้เลยค่ะ 👇",
        quickReply: { items },
      }];
    }
    default: {
      const fallback = await config("FALLBACK_MESSAGE");
      return [{
        type: "text",
        text: fallback ?? "สวัสดีค่ะ บ้านเด็กคลินิก พิมพ์ชื่อวัคซีนหรือ 'เวลาทำการ' ได้เลยค่ะ",
      }];
    }
  }
}
