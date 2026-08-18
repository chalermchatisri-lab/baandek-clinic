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
      const today = new Date().toISOString().slice(0, 10);
      const [{ data: closures }, { data: hours }] = await Promise.all([
        admin.from("closures").select("start_date, end_date, reason, message, closure_type")
          .eq("active", true).gte("end_date", today).order("start_date").limit(10),
        admin.from("clinic_hours").select("day").eq("status", "CLOSED"),
      ]);
      const TH_DAY: Record<string, string> = {
        Monday: "วันจันทร์", Tuesday: "วันอังคาร", Wednesday: "วันพุธ",
        Thursday: "วันพฤหัสบดี", Friday: "วันศุกร์", Saturday: "วันเสาร์", Sunday: "วันอาทิตย์",
      };
      const parts = ["📅 วันหยุดของคลินิกบ้านเด็ก"];
      const closedDays = [...new Set((hours ?? []).map((h) => h.day))];
      if (closedDays.length > 0)
        parts.push(closedDays.map((d) => `🔴 ปิดทุก${TH_DAY[d] ?? d}เป็นประจำ`).join("\n"));
      if (closures && closures.length > 0) {
        const lines = closures.map((c) => {
          const range = c.start_date === c.end_date
            ? thaiDate(c.start_date)
            : `${thaiDate(c.start_date)} – ${thaiDate(c.end_date)}`;
          return `🗓️ ${range}\n${c.message ?? c.reason ?? ""}`;
        });
        parts.push("เดือนนี้มีวันหยุดต่อเนื่อง\n\n" + lines.join("\n\n"));
      }
      parts.push("กรุณาวางแผนก่อนเข้ารับบริการนะคะ");
      return [{ type: "text", text: parts.join("\n\n") }];
    }
    case "NEWS": {
      const items = [
        { type: "action", action: { type: "message", label: "โปรโมชั่น", text: "โปรโมชั่น" } },
        { type: "action", action: { type: "message", label: "วัคซีนใหม่", text: "วัคซีนใหม่" } },
        { type: "action", action: { type: "message", label: "ประกาศปิดคลินิก", text: "ประกาศปิดคลินิก" } },
      ];
      return [{ type: "text", text: "สนใจข้อมูลเรื่องไหนดีคะ เลือกได้เลยค่ะ 👇", quickReply: { items } }];
    }
    case "PROMOTIONS": {
      const { data } = await admin
        .from("promotions").select("title, vaccine_group, discount, condition").eq("active", true);
      if (!data || data.length === 0)
        return [{ type: "text", text: "ช่วงนี้ยังไม่มีโปรโมชันค่ะ 😊" }];
      const lines = data.map((p) =>
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
    case "VACCINE_NEWS": {
      const { data } = await admin
        .from("vaccine_news").select("vaccine_name, description").eq("status", true);
      if (!data || data.length === 0)
        return [{ type: "text", text: "ไม่มีวัคซีนใหม่ช่วงนี้ค่ะ" }];
      const lines = data.map((n) => `📰 ${n.vaccine_name}` + (n.description ? `\n${n.description}` : ""));
      return [{ type: "text", text: "💉 วัคซีนใหม่\n\n" + lines.join("\n\n") }];
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
    default:
      return [{ type: "text", text: "สวัสดีค่ะ บ้านเด็กคลินิก พิมพ์ชื่อวัคซีนหรือ 'เวลาทำการ' ได้เลยค่ะ" }];
  }
}
