import { admin } from "../lib/supabase";

/**
 * Clinic open/closed status — replaces ClinicStatus.gs (289 LOC of Sheets reads).
 * Reads clinic_hours + closures from Supabase. All times Asia/Bangkok.
 */
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const THAI_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export interface ClinicStatus {
  date: string;            // YYYY-MM-DD
  isOpen: boolean;
  closureMessage?: string; // if fully/partially closed
  sessions: { open: string; close: string }[];
  text: string;            // ready-to-send Thai summary
}

function bangkokToday(): Date {
  // shift now to Bangkok (UTC+7) and zero the time
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getClinicStatus(targetDate?: string): Promise<ClinicStatus> {
  const date = targetDate ? new Date(targetDate + "T00:00:00Z") : bangkokToday();
  const dateStr = ymd(date);
  const dow = date.getUTCDay();
  const dayName = DAYS[dow]!;

  // 1) closures that cover this date (highest priority wins)
  const { data: closures } = await admin
    .from("closures")
    .select("*")
    .eq("active", true)
    .lte("start_date", dateStr)
    .gte("end_date", dateStr)
    .order("priority", { ascending: true });

  const fullClose = closures?.find((c) => c.closure_type === "CLOSE_ALL");
  if (fullClose) {
    return {
      date: dateStr, isOpen: false, closureMessage: fullClose.message,
      sessions: [],
      text: `วัน${THAI_DOW[dow]}ที่ ${thaiDate(date)} คลินิกปิดค่ะ\n${fullClose.message ?? ""}`.trim(),
    };
  }

  // 2) regular hours for this weekday
  const { data: hours } = await admin
    .from("clinic_hours")
    .select("*")
    .eq("day", dayName)
    .eq("status", "OPEN")
    .order("session", { ascending: true });

  let sessions = (hours ?? []).map((h) => ({ open: h.open_time!, close: h.close_time! }));

  // 3) partial closure (e.g. morning only) trims sessions
  const partial = closures?.find((c) => c.closure_type === "CLOSE_PERIOD");
  if (partial?.period_code === "WD_AM") sessions = sessions.filter((s) => Number(s.open.split(":")[0]) >= 13);
  if (partial?.period_code === "WD_PM") sessions = sessions.filter((s) => Number(s.open.split(":")[0]) < 13);

  const isOpen = sessions.length > 0;
  const sessText = sessions.map((s) => `${s.open}–${s.close} น.`).join(" และ ");
  const text = isOpen
    ? `วัน${THAI_DOW[dow]}ที่ ${thaiDate(date)} คลินิกเปิดค่ะ 🕘\nเวลา ${sessText}` +
      (partial ? `\n(${partial.message})` : "")
    : `วัน${THAI_DOW[dow]}ที่ ${thaiDate(date)} คลินิกปิดค่ะ`;

  return { date: dateStr, isOpen, closureMessage: partial?.message, sessions, text };
}

function thaiDate(d: Date): string {
  const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`;
}
