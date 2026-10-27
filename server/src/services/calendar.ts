// "📅 Add to my phone's calendar" for appointment-check results.
//
// Zero LINE quota: the parent's own phone calendar does the reminding, so the
// clinic never needs a Push message for it. Two buttons per appointment:
//  - Google Calendar template link (Android / anyone using Google Calendar)
//  - .ics file served by GET /public/appointment-ics/:id (iPhone Calendar)
//
// PDPA: only the child's nickname, the appointment date/time and its purpose go
// into the event. The .ics URL carries the appointment's UUID (unguessable), not
// the nickname/phone/HN, so nothing identifying lands in server access logs.

export const PUBLIC_BASE_URL = "https://baandek-clinic.onrender.com";

export type CalendarAppt = {
  id: string;
  date: string; // YYYY-MM-DD (Bangkok)
  timeSlot: string; // e.g. "9.00-10.00 น."
  purpose: string;
  nickname: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "9.00-10.00 น." -> {start:[9,0], end:[10,0]}; falls back to 09:00-10:00. */
export function parseTimeSlot(slot: string): { start: [number, number]; end: [number, number] } {
  const m = slot.match(/(\d{1,2})[.:](\d{2})\s*-\s*(\d{1,2})[.:](\d{2})/);
  if (m) {
    const [sh, sm, eh, em] = m.slice(1).map(Number) as [number, number, number, number];
    if (sh < 24 && eh < 24 && sm < 60 && em < 60) return { start: [sh, sm], end: [eh, em] };
  }
  const one = slot.match(/(\d{1,2})[.:](\d{2})/);
  if (one) {
    const h = Number(one[1]);
    const mi = Number(one[2]);
    if (h < 23 && mi < 60) return { start: [h, mi], end: [h + 1, mi] };
  }
  return { start: [9, 0], end: [10, 0] };
}

export function eventTitle(a: Pick<CalendarAppt, "nickname" | "purpose">): string {
  const who = a.nickname ? ` – ${a.nickname}` : "";
  const why = a.purpose ? ` (${a.purpose})` : "";
  return `นัดคลินิกบ้านเด็ก${who}${why}`;
}

/** Local Bangkok wall-clock as YYYYMMDDTHHMMSS. */
function localStamp(date: string, [h, m]: [number, number]): string {
  return `${date.replaceAll("-", "")}T${pad(h)}${pad(m)}00`;
}

/** Bangkok wall-clock -> UTC stamp YYYYMMDDTHHMMSSZ (Bangkok is fixed UTC+7, no DST). */
function utcStamp(date: string, [h, m]: [number, number]): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h - 7, m));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00Z`;
}

/** Tell LINE to open the link in the phone's real browser (needed for .ics / Calendar app hand-off). */
export function withExternalBrowser(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "openExternalBrowser=1";
}

export function googleCalendarUrl(a: CalendarAppt): string {
  const { start, end } = parseTimeSlot(a.timeSlot);
  const qs = new URLSearchParams({
    action: "TEMPLATE",
    text: eventTitle(a),
    dates: `${localStamp(a.date, start)}/${localStamp(a.date, end)}`,
    ctz: "Asia/Bangkok",
    details: `นัดหมายที่คลินิกบ้านเด็ก เวลา ${a.timeSlot}`,
    location: "คลินิกบ้านเด็ก",
  });
  return `https://calendar.google.com/calendar/render?${qs.toString()}`;
}

/** Short link (LINE caps URIs at 1000 chars; Thai text makes the Google URL ~1.2k) — 302s to googleCalendarUrl. */
export function gcalRedirectUrl(id: string): string {
  return `${PUBLIC_BASE_URL}/public/appointment-gcal/${encodeURIComponent(id)}`;
}

export function icsUrl(id: string): string {
  return `${PUBLIC_BASE_URL}/public/appointment-ics/${encodeURIComponent(id)}`;
}

const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** iCalendar file with reminders 2 days and 1 day before the appointment. */
export function buildIcs(a: CalendarAppt, now: Date = new Date()): string {
  const { start, end } = parseTimeSlot(a.timeSlot);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const alarm = (trigger: string) => [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(eventTitle(a))}`,
    `TRIGGER:${trigger}`,
    "END:VALARM",
  ];
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BAANDEK Clinic//Appointment//TH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${a.id}@baandek-clinic`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${utcStamp(a.date, start)}`,
    `DTEND:${utcStamp(a.date, end)}`,
    `SUMMARY:${icsEscape(eventTitle(a))}`,
    `DESCRIPTION:${icsEscape(`นัดหมายที่คลินิกบ้านเด็ก เวลา ${a.timeSlot}`)}`,
    "LOCATION:คลินิกบ้านเด็ก",
    ...alarm("-P2D"),
    ...alarm("-P1D"),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** One Flex bubble per appointment (max 5), each with Google + iPhone buttons. */
export function buildCalendarFlex(appts: CalendarAppt[], thaiDateFn: (iso: string) => string) {
  const bubbles = appts.slice(0, 5).map((a) => ({
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "📅 เพิ่มลงปฏิทินมือถือ", weight: "bold", size: "md", color: "#1E7F5C" },
        { type: "text", text: `${thaiDateFn(a.date)} · ${a.timeSlot}`, size: "sm", wrap: true },
        { type: "text", text: a.purpose || "นัดหมาย", size: "sm", color: "#666666", wrap: true },
        { type: "text", text: "มือถือจะเตือนให้อัตโนมัติ ไม่พลาดนัดค่ะ", size: "xs", color: "#999999", wrap: true },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          color: "#1E7F5C",
          action: { type: "uri", label: "iPhone (ปฏิทิน)", uri: withExternalBrowser(icsUrl(a.id)) },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "uri", label: "Android / Google", uri: withExternalBrowser(gcalRedirectUrl(a.id)) },
        },
      ],
    },
  }));
  return {
    type: "flex" as const,
    altText: "📅 เพิ่มนัดหมายลงปฏิทินมือถือ",
    contents: bubbles.length === 1 ? bubbles[0]! : { type: "carousel", contents: bubbles },
  };
}
