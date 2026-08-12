import { admin } from "../lib/supabase";
import { detectIntent } from "./intent";
import { buildVaccineAdvice } from "./vaccine";
import { getClinicStatus } from "./clinicStatus";
import { buildAppointmentResultByPhone, normalizePhone } from "./appointmentCheck";

export type TextMessage = { type: "text"; text: string };

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
      const cards = await buildVaccineAdvice(r.vaccineGroup, r.ageMonths ?? null);
      if (!cards.length)
        return [{ type: "text", text: "ยังไม่พบข้อมูลสำหรับอายุที่ระบุ กรุณาติดต่อคลินิกค่ะ" }];
      const lines = cards.map((c) => {
        const opts = c.priceOptions?.length
          ? "\n  " + c.priceOptions.map((p) => `${p.name} ${p.price.toLocaleString()} บาท`).join("\n  ")
          : c.price ? ` — ${c.price.toLocaleString()} บาท` : "";
        return `• ${c.title} (${c.ageRange})` + opts + (c.message ? `\n  ${c.message}` : "");
      });
      return [{ type: "text", text: lines.join("\n\n") }];
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
    default:
      return [{ type: "text", text: "สวัสดีค่ะ บ้านเด็กคลินิก พิมพ์ชื่อวัคซีนหรือ 'เวลาทำการ' ได้เลยค่ะ" }];
  }
}
