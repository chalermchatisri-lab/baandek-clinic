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

export async function buildReplyMessages(text: string): Promise<TextMessage[]> {
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
    case "CLINIC_STATUS":
    case "CLINIC_TIME": {
      const now = new Date(Date.now() + 7 * 3600 * 1000); // Bangkok
      const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
      const today = await getClinicStatus(ymdOf(now));
      const parts: string[] = [(today.isOpen ? "🟢 " : "🔴 ") + `วันนี้ ${today.text}`];

      if (!today.isOpen) {
        for (let i = 1; i <= 14; i++) {
          const d = new Date(now.getTime() + i * 86400000);
          const st = await getClinicStatus(ymdOf(d));
          if (st.isOpen) {
            const dateLine = st.text.split("\n")[0]?.replace(/ คลินิกเปิดค่ะ.*/, "") ?? "";
            parts.push(`🟢 เปิดทำการอีกครั้ง ${dateLine}`);
            break;
          }
        }
      }

      const tomorrow = await getClinicStatus(ymdOf(new Date(now.getTime() + 86400000)));
      parts.push((tomorrow.isOpen ? "🟢 " : "🔴 ") + `พรุ่งนี้ ${tomorrow.text}`);

      const summary = await closuresListText();
      if (summary) parts.push(summary);

      return [{ type: "text", text: parts.join("\n\n") }];
    }
    case "LOCATION": {
      const [maps, addr] = await Promise.all([config("GOOGLE_MAPS"), config("ADDRESS")]);
      return [{
        type: "text",
        text: `📍 คลินิกบ้านเด็ก\n\n${addr ?? ""}` +
              (maps ? `\n\nเปิดเส้นทางใน Google Maps:\n${maps}` : ""),
      }];
    }
    case "APPOINTMENT_CHANGE":
      return [{
        type: "text",
        text: "ต้องการตรวจสอบ/เลื่อนนัดใช่ไหมคะ 🗓️\nกรุณาพิมพ์เบอร์โทรที่ลงทะเบียนไว้ (10 หลัก) เพื่อดูนัดที่กำลังจะถึงค่ะ",
      }];
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
