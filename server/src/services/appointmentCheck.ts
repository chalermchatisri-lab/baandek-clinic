import { admin } from "../lib/supabase";

/**
 * Look up a patient's upcoming appointments by phone number.
 * Replaces AppointmentCheck.gs — same phone-normalize + Thai-date logic,
 * but a single indexed query instead of scanning a Sheet.
 */

/** Normalize a TH phone: digits only, restore the leading 0 Sheets used to strip. */
export function normalizePhone(raw: string): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10 && d.startsWith("0")) return d;
  if (d.length === 9) return "0" + d;          // leading zero eaten historically
  if (d.length === 11 && d.startsWith("66")) return "0" + d.slice(2);
  return d.length >= 9 ? d : null;
}

export interface ApptResult {
  found: boolean;
  text: string;
}

export async function buildAppointmentResultByPhone(rawPhone: string): Promise<ApptResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return { found: false, text: "กรุณาพิมพ์เบอร์โทรที่ลงทะเบียนไว้ (10 หลัก) อีกครั้งค่ะ" };
  }

  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  // patient(s) with this phone -> their future appointments
  const { data, error } = await admin
    .from("appointments")
    .select("appt_date, time_slot, purpose_raw, patients!inner(full_name, nickname, phone)")
    .eq("patients.phone", phone)
    .gte("appt_date", today)
    .order("appt_date", { ascending: true })
    .limit(5);

  if (error || !data || data.length === 0) {
    return {
      found: false,
      text:
        "ไม่พบนัดหมายที่กำลังจะถึงสำหรับเบอร์นี้ค่ะ\n" +
        "หากต้องการความช่วยเหลือ กรุณาติดต่อคลินิกโดยตรงนะคะ",
    };
  }

  const name = (data[0] as any).patients?.nickname || (data[0] as any).patients?.full_name || "";
  const lines = data.map((a: any) => `📅 ${thaiDate(a.appt_date)} เวลา ${a.time_slot}\n   ${a.purpose_raw}`);
  return {
    found: true,
    text: `นัดหมายที่กำลังจะถึงของคุณ ${name} ค่ะ\n\n${lines.join("\n\n")}`,
  };
}

function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${d} ${months[(m ?? 1) - 1]} ${(y ?? 0) + 543}`;
}
