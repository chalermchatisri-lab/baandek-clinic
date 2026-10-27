import { describe, it, expect } from "vitest";
import { parseTimeSlot, googleCalendarUrl, buildIcs, buildCalendarFlex, eventTitle } from "./calendar";

const appt = { id: "abc-123", date: "2026-12-19", timeSlot: "9.00-10.00 น.", purpose: "สุกใส", nickname: "น้องมะลิ" };

describe("calendar", () => {
  it("parses the clinic's time-slot formats with a safe fallback", () => {
    expect(parseTimeSlot("9.00-10.00 น.")).toEqual({ start: [9, 0], end: [10, 0] });
    expect(parseTimeSlot("16.00-19.00 น.")).toEqual({ start: [16, 0], end: [19, 0] });
    expect(parseTimeSlot("10:30")).toEqual({ start: [10, 30], end: [11, 30] });
    expect(parseTimeSlot("")).toEqual({ start: [9, 0], end: [10, 0] });
  });

  it("titles with nickname + purpose only", () => {
    expect(eventTitle(appt)).toBe("นัดคลินิกบ้านเด็ก – น้องมะลิ (สุกใส)");
  });

  it("builds a Google Calendar link in Bangkok time", () => {
    const u = new URL(googleCalendarUrl(appt));
    expect(u.searchParams.get("dates")).toBe("20261219T090000/20261219T100000");
    expect(u.searchParams.get("ctz")).toBe("Asia/Bangkok");
  });

  it("builds an .ics in UTC with 2-day and 1-day reminders", () => {
    const ics = buildIcs(appt, new Date("2026-10-27T00:00:00Z"));
    expect(ics).toContain("DTSTART:20261219T020000Z");
    expect(ics).toContain("DTEND:20261219T030000Z");
    expect(ics).toContain("TRIGGER:-P2D");
    expect(ics).toContain("TRIGGER:-P1D");
    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
  });

  it("uses a single bubble for one appointment, carousel for several, max 5", () => {
    const one = buildCalendarFlex([appt], (d) => d);
    expect(one.contents.type).toBe("bubble");
    const many = buildCalendarFlex(Array(7).fill(appt), (d) => d);
    expect(many.contents.type).toBe("carousel");
    expect((many.contents as { contents: unknown[] }).contents).toHaveLength(5);
    expect(JSON.stringify(one)).toContain("openExternalBrowser=1");
    for (const m of JSON.stringify(one).matchAll(/"uri":"([^"]+)"/g)) expect(m[1]!.length).toBeLessThanOrEqual(1000);
  });
});
