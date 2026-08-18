import { admin } from "../lib/supabase";
import { env } from "../lib/env";
import { detectIntent } from "./intent";
import { buildVaccineAdvice, DOCTOR_REFERRAL } from "./vaccine";
import { getClinicStatus } from "./clinicStatus";
import { buildAppointmentResultByPhone, normalizePhone } from "./appointmentCheck";

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

function looksLikePhone(text: string): boolean {
  const d = text.replace(/\D/g, "");
  return d.length >= 9 && d.length <= 11 && /^[0\s\-()+\d]+$/.test(text.trim());
}

export async function buildReplyMessages(text: string): Promise<TextMessage[]> {
  // Fast path: a lone phone number = user answering the appointment prompt.
  if (looksLikePhone(text) && normalizePhone(text)) {
    const r = await buildAppointmentResultByPhone(text);
    return [{ type: "text", text: r.text }];
  }

  const r = await detectIntent(text);
  switch (r.intent) {
    case "VACCINE_INFO":
    case "VACCINE_PRICE":
    case "VACCINE_AVAILABILITY": {
      if (!r.vaccineGroup)
        return [{ type: "text", text: "ระบุชื่อวัคซีนและอายุได้เลยค่ะ เช่น PCV 2 เดือน" }];
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
      const s = await getClinicStatus();
      return [{ type: "text", text: s.text }];
    }
    case "LOCATION": {
      const [maps, addr, phone] = await Promise.all([
        config("GOOGLE_MAPS"), config("ADDRESS"), config("PHONE"),
      ]);
      return [{
        type: "text",
        text: `📍 บ้านเด็กคลินิก\n${addr ?? ""}` +
              (maps ? `\n🗺️ ${maps}` : "") + (phone ? `\n📞 ${phone}` : ""),
      }];
    }
    case "APPOINTMENT_CHANGE":
      return [{
        type: "text",
        text: "ต้องการตรวจสอบ/เลื่อนนัดใช่ไหมคะ 🗓️\nกรุณาพิมพ์เบอร์โทรที่ลงทะเบียนไว้ (10 หลัก) เพื่อดูนัดที่กำลังจะถึงค่ะ",
      }];
    case "SERVICES": {
      const { data } = await admin
        .from("services").select("title, description, icon")
        .eq("active", true).order("display_order");
      if (!data || data.length === 0)
        return [{ type: "text", text: "ขออภัยค่ะ ยังไม่มีข้อมูลบริการในระบบ" }];
      const lines = data.map((s) =>
        `${s.icon ?? "•"} ${s.title}` + (s.description ? `\n   ${s.description}` : ""));
      return [{ type: "text", text: "🏥 บริการของบ้านเด็กคลินิก\n\n" + lines.join("\n\n") }];
    }
    case "HOLIDAYS": {
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await admin
        .from("closures").select("start_date, end_date, reason")
        .eq("active", true).gte("end_date", today).order("start_date").limit(10);
      if (!data || data.length === 0)
        return [{ type: "text", text: "ช่วงนี้คลินิกไม่มีวันหยุดพิเศษค่ะ 😊 เปิดตามเวลาปกติ" }];
      const lines = data.map((c) => {
        const range = c.start_date === c.end_date
          ? thaiDate(c.start_date)
          : `${thaiDate(c.start_date)} – ${thaiDate(c.end_date)}`;
        return `🗓️ ${range}` + (c.reason ? ` — ${c.reason}` : "");
      });
      return [{ type: "text", text: "📅 วันหยุด/ปิดพิเศษ\n\n" + lines.join("\n") + "\n\nกรุณาวางแผนก่อนเข้ารับบริการนะคะ" }];
    }
    case "NEWS": {
      const [{ data: promos }, { data: news }] = await Promise.all([
        admin.from("promotions").select("title, description, discount, condition").eq("active", true),
        admin.from("vaccine_news").select("vaccine_name, description").eq("status", true),
      ]);
      const parts: string[] = [];
      for (const p of promos ?? [])
        parts.push(`🎁 ${p.title}` + (p.discount ? ` — ${p.discount}` : "") +
          (p.description ? `\n   ${p.description}` : "") + (p.condition ? `\n   เงื่อนไข: ${p.condition}` : ""));
      for (const n of news ?? [])
        parts.push(`📰 ${n.vaccine_name}` + (n.description ? `\n   ${n.description}` : ""));
      if (parts.length === 0)
        return [{ type: "text", text: "ช่วงนี้ยังไม่มีโปรโมชันหรือข่าวสารใหม่ค่ะ 😊" }];
      return [{ type: "text", text: "📢 โปรโมชัน & ข่าวสาร\n\n" + parts.join("\n\n") }];
    }
    case "CONTACT": {
      const [phone, addr, maps, lineId, web] = await Promise.all([
        config("PHONE"), config("ADDRESS"), config("GOOGLE_MAPS"), config("LINE_ID"), config("WEBSITE"),
      ]);
      const lines = ["📞 ติดต่อบ้านเด็กคลินิก", ""];
      if (phone) lines.push(`โทร: ${phone}`);
      if (lineId) lines.push(`LINE: ${lineId}`);
      if (addr) lines.push(`ที่อยู่: ${addr}`);
      if (maps) lines.push(`แผนที่: ${maps}`);
      if (web) lines.push(`เว็บไซต์: ${web}`);
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
    default:
      return [{ type: "text", text: "สวัสดีค่ะ บ้านเด็กคลินิก พิมพ์ชื่อวัคซีนหรือ 'เวลาทำการ' ได้เลยค่ะ" }];
  }
}
