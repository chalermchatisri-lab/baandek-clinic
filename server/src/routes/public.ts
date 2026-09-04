import { Hono } from "hono";
import { cors } from "hono/cors";
import { admin } from "../lib/supabase";
import { getClinicStatus } from "../services/clinicStatus";

export const publicApi = new Hono();

// This router serves public, non-sensitive read-only content to the
// Landing page's browser-side fetch() (a different origin: the Cloudflare
// Worker domain). Without CORS headers, the browser silently blocks the
// response even though the request succeeds — Apps Script sent these
// headers automatically, Hono does not by default. No cookies/auth are
// involved, so a wildcard origin is safe here.
publicApi.use("*", cors({ origin: "*", allowMethods: ["GET"] }));

// ---- GET /public/content-data ----
// Matches the Apps Script `mode=content-data` JSON contract exactly, so the
// Landing page Worker can be repointed here with zero client-side changes.
publicApi.get("/public/content-data", async (c) => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const [team, services, articles, reviews, promotions, vaccineNews, links] =
    await Promise.all([
      admin
        .from("team")
        .select("name,role,photo_url,credentials,display_order,active")
        .eq("active", true)
        .order("display_order", { ascending: true }),
      admin
        .from("services")
        .select("title,description,icon,display_order,active")
        .eq("active", true)
        .order("display_order", { ascending: true }),
      admin
        .from("articles")
        .select(
          "title,category,cover_image_url,content_type,panel_images_folder,published,body_content,display_order,start_date,end_date"
        )
        .eq("published", true)
        .or(`start_date.is.null,start_date.lte.${today}`)
        .or(`end_date.is.null,end_date.gte.${today}`)
        .order("display_order", { ascending: true }),
      admin
        .from("reviews")
        .select(
          "source,reviewer_name,text,rating,screenshot_url,permission_confirmed,review_count"
        ),
      admin
        .from("promotions")
        .select(
          "title,description,image_url,start_date,end_date,active,kind"
        )
        .in("kind", ["landing", "both"])
        .eq("active", true)
        .or(`end_date.is.null,end_date.gte.${today}`),
      admin
        .from("vaccine_news")
        .select("vaccine_name,start_date,end_date,status,description,channel,expire_date")
        .in("channel", ["landing", "both"])
        .eq("status", true)
        .or(`expire_date.is.null,expire_date.gte.${today}`),
      admin
        .from("clinic_config")
        .select("key,value")
        .in("key", [
          "PHONE",
          "FACEBOOK_PAGE",
          "LINE_OA",
          "GOOGLE_MAPS",
          "ADDRESS",
          "VACCINE_ADVISOR",
          "WEBSITE",
        ]),
    ]);

  const firstError =
    team.error ||
    services.error ||
    articles.error ||
    reviews.error ||
    promotions.error ||
    vaccineNews.error ||
    links.error;
  if (firstError) {
    return c.json({ ok: false, error: firstError.message }, 500);
  }

  // ---- Reshape to the exact Apps Script field names/casing ----
  const teamOut = (team.data ?? []).map((r) => ({
    Name: r.name,
    Role: r.role ?? "",
    Photo_URL: r.photo_url ?? "",
    Credentials: r.credentials ?? "",
    Order: r.display_order,
    Active: r.active,
  }));

  const servicesOut = (services.data ?? []).map((r) => ({
    Title: r.title,
    Description: r.description,
    Icon: r.icon,
    Order: r.display_order,
    Active: r.active,
  }));

  const articlesOut = (articles.data ?? []).map((r) => ({
    Title: r.title,
    Category: r.category ?? "",
    Cover_Image_URL: r.cover_image_url ?? "",
    Content_Type: r.content_type,
    Panel_Images_Folder: r.panel_images_folder ?? "",
    Published: r.published,
    Body_Content: r.body_content ?? "",
  }));

  const reviewsOut = (reviews.data ?? []).map((r) => ({
    Source: r.source,
    Reviewer_Name: r.reviewer_name ?? "",
    Text: r.text,
    Rating: r.rating,
    Screenshot_URL: r.screenshot_url ?? "",
    Permission_Confirmed: r.permission_confirmed,
    ReviewCount: r.review_count,
  }));

  const promotionsOut = (promotions.data ?? []).map((r) => ({
    Title: r.title,
    Description: r.description,
    Image_URL: r.image_url ?? "",
    Start_Date: r.start_date ?? "",
    End_Date: r.end_date ?? "",
    Active: r.active,
  }));

  const vaccineNewsOut = (vaccineNews.data ?? []).map((r) => ({
    VaccineName: r.vaccine_name,
    StartDate: r.start_date ?? "",
    EndDate: r.end_date ?? "",
    Status: r.status,
    Description: r.description,
  }));

  const linksOut: Record<string, string> = {};
  for (const row of links.data ?? []) {
    linksOut[row.key] = row.value;
  }

  return c.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    team: teamOut,
    services: servicesOut,
    articles: articlesOut,
    reviews: reviewsOut,
    promotions: promotionsOut,
    vaccineNews: vaccineNewsOut,
    links: linksOut,
  });
});

// ---- GET /public/clinic-status ----
// Matches the Apps Script `mode=clinic-status` JSON contract (the fields the
// Landing page actually reads: clinic.status/reason/message/sessions[]).
//
// getClinicStatus() (shared with the LINE/Messenger bot's "วันหยุด" reply)
// already resolves today's sessions correctly, including full/partial
// closures — that part is reused as-is, untouched. But that function
// answers "does today have any session at all", not "is it open RIGHT NOW";
// Apps Script's contract is real-time (e.g. Sat 17:59, past the 15:00
// close, correctly reports CLOSED even though Saturday is a normal open
// day) — so a same-day time-of-day check is layered on top here, without
// touching the shared service.
//
// NOTE: clinic_hours.open_time/close_time are stored without zero-padding
// (e.g. "9:00", not "09:00"). Apps Script's contract always zero-pads
// (e.g. "09:00"). Times are normalized here for correct string comparison
// AND to keep the sessions the Landing page displays visually identical
// to what it showed before this migration.
function padHM(t: string): string {
  const [h, m] = t.split(":");
  return `${(h ?? "0").padStart(2, "0")}:${(m ?? "0").padStart(2, "0")}`;
}

function nowBangkokHM(): string {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  return `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
}

publicApi.get("/public/clinic-status", async (c) => {
  const status = await getClinicStatus();
  const sessions = status.sessions.map((s) => ({
    open: padHM(s.open),
    close: padHM(s.close),
  }));

  // Fully/partially closed today (closure or a day with zero sessions) —
  // getClinicStatus() already decided this; trust it as-is.
  if (!status.isOpen) {
    return c.json({
      ok: true,
      date: status.date,
      generatedAt: new Date().toISOString(),
      clinic: {
        status: "CLOSED",
        reason: "",
        message: status.closureMessage ?? "",
        sessions,
      },
    });
  }

  // Today has sessions — check whether the current time falls inside one.
  const nowHM = nowBangkokHM();
  const withinSession = sessions.some((s) => nowHM >= s.open && nowHM < s.close);

  return c.json({
    ok: true,
    date: status.date,
    generatedAt: new Date().toISOString(),
    clinic: {
      status: withinSession ? "OPEN" : "CLOSED",
      reason: "",
      message: withinSession ? "" : "ขณะนี้อยู่นอกเวลาทำการ",
      sessions,
    },
  });
});

// ---- GET /public/clinic-hours ----
// The Landing page's "เวลาตรวจปกติ" (regular hours) widget used to have this
// weekly schedule hardcoded directly in JSX, so it went stale whenever
// clinic_hours changed (e.g. weekend open time moved 09:00 -> 10:00) even
// though the "today/tomorrow" status widget right next to it — built on
// /public/clinic-status above — read the live table correctly. This route
// gives that widget the same live source: the full week, OPEN days only,
// in weekday order, with the same zero-padding as /public/clinic-status.
const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

publicApi.get("/public/clinic-hours", async (c) => {
  const { data, error } = await admin
    .from("clinic_hours")
    .select("day,session,open_time,close_time,status")
    .order("session", { ascending: true });
  if (error) return c.json({ ok: false, error: error.message }, 500);

  const byDay = new Map<string, { open: string; close: string }[]>();
  for (const row of data ?? []) {
    if (row.status !== "OPEN") continue;
    const list = byDay.get(row.day) ?? [];
    list.push({ open: padHM(row.open_time!), close: padHM(row.close_time!) });
    byDay.set(row.day, list);
  }

  const hours = DAY_ORDER.filter((d) => byDay.has(d)).map((day) => ({
    day,
    sessions: byDay.get(day)!,
  }));

  return c.json({ ok: true, generatedAt: new Date().toISOString(), hours });
});

// ============================================================================
// Vaccine Advisor endpoints (item 13) — replace Apps Script vaccine-advisor-*
// ============================================================================

// ---- GET /public/vaccine-advisor-data ----
// Reconstructs the Apps Script `mode=vaccine-advisor-data` contract:
//   { ages: [{AgeCode, DisplayName, SortOrder}],
//     vaccines: [{VaccineID, VaccineName, VaccineNameT, AgeGroup, Category,
//                 Price, Status, GROUP, DisplayOrder, DoseName, Description,
//                 CatchUp, Recommendation, Warning, Priority, ProductCode}],
//     promos: [{PromoID, PromoName, VaccineGroup, Discount, Condition,
//               Status, StartDate, EndDate, DisplayPeriod}] }
//
// The flat per-dose `vaccines[]` array is rebuilt by joining the vaccines
// table (identity/price/category/group/priority — shared with the bot) to
// vaccine_doses (the per-dose age schedule — Advisor-only). This keeps price
// editing single-source in the vaccines table while giving the Advisor its
// full dose-by-dose view.
publicApi.get("/public/vaccine-advisor-data", async (c) => {
  const today = new Date().toISOString().slice(0, 10);

  const [ages, doses, promos] = await Promise.all([
    admin
      .from("age_guide")
      .select("age_code,display_name,sort_order")
      .order("sort_order", { ascending: true }),
    admin
      .from("vaccine_doses")
      .select(
        "vaccine_id,dose_name,age_group,display_order,description,catch_up,recommendation,warning,name_th_override,status," +
          "vaccines!inner(vaccine_id,name,name_th,price,category,group_code,priority,product_code,status)"
      )
      .eq("status", "ACTIVE")
      .order("display_order", { ascending: true }),
    admin
      .from("promotions")
      .select(
        "code,title,vaccine_group,discount,condition,start_date,end_date,display_period,active,kind"
      )
      .in("kind", ["bot", "both"])
      .eq("active", true)
      .or(`end_date.is.null,end_date.gte.${today}`),
  ]);

  const firstError = ages.error || doses.error || promos.error;
  if (firstError) {
    return c.json({ ok: false, error: firstError.message }, 500);
  }

  const agesOut = (ages.data ?? []).map((r) => ({
    AgeCode: r.age_code,
    DisplayName: r.display_name,
    SortOrder: r.sort_order,
  }));

  // Each vaccine_doses row + its parent vaccines row = one flat catalog entry,
  // exactly matching the old Sheet's 1-row-per-dose model.
  type DoseRow = {
    vaccine_id: string; dose_name: string; age_group: string;
    display_order: number | null; description: string | null;
    catch_up: string | null; recommendation: string | null;
    warning: string | null; name_th_override: string | null; status: string | null;
    vaccines: {
      vaccine_id: string; name: string | null; name_th: string | null;
      price: number | null; category: string | null; group_code: string | null;
      priority: string | null; product_code: string | null; status: string | null;
    };
  };
  const doseRows = (doses.data ?? []) as unknown as DoseRow[];
  const vaccinesOut = doseRows.map((d) => {
    const v = d.vaccines;
    return {
      VaccineID: v.vaccine_id,
      VaccineName: v.name ?? "",
      // Per-dose Thai label override (e.g. booster "...กระตุ้น") wins over the base name.
      VaccineNameT: d.name_th_override ?? v.name_th ?? "",
      AgeGroup: d.age_group,
      Category: v.category ?? "",
      Price: v.price == null ? null : Number(v.price),
      Status: v.status,
      GROUP: v.group_code ?? "",
      DisplayOrder: d.display_order,
      DoseName: d.dose_name,
      Description: d.description ?? "",
      CatchUp: d.catch_up ?? "",
      Recommendation: d.recommendation ?? "",
      Warning: d.warning ?? "",
      Priority: v.priority ?? "",
      ProductCode: v.product_code ?? "",
    };
  });

  const promosOut = (promos.data ?? []).map((r) => ({
    PromoID: r.code,
    PromoName: r.title,
    VaccineGroup: r.vaccine_group ?? "",
    Discount: r.discount == null || r.discount === "" ? r.discount : Number(r.discount),
    Condition: r.condition ?? "",
    Status: r.active ? "ACTIVE" : "INACTIVE",
    StartDate: r.start_date ?? "",
    EndDate: r.end_date ?? "",
    DisplayPeriod: r.display_period ?? "",
  }));

  return c.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    ages: agesOut,
    vaccines: vaccinesOut,
    promos: promosOut,
  });
});

// ---- GET /public/vaccine-advisor-status ----
// Reconstructs the Apps Script `mode=vaccine-advisor-status` preformatted Thai
// message: today's open/closed line + service hours + upcoming continuous
// closure block. Supports ?testDate=YYYY-MM-DD (Apps Script parity).
//
// getClinicStatus() gives today's status/sessions (reused as-is). The
// "upcoming closures" block is NOT part of getClinicStatus(), so this route
// runs its own query for the next future-dated active CLOSE_ALL closure.
const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

function thaiFullDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${THAI_MONTHS[(m ?? 1) - 1]} ${(y ?? 0) + 543}`;
}

// "21–23 กันยายน 2569" when same month/year; otherwise full both ends.
function thaiDateRange(startIso: string, endIso: string): string {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  if (sy === ey && sm === em) {
    return `${sd}–${ed} ${THAI_MONTHS[(sm ?? 1) - 1]} ${(sy ?? 0) + 543}`;
  }
  return `${thaiFullDate(startIso)} – ${thaiFullDate(endIso)}`;
}

function daysInclusive(startIso: string, endIso: string): number {
  const a = Date.parse(startIso + "T00:00:00Z");
  const b = Date.parse(endIso + "T00:00:00Z");
  return Math.round((b - a) / 86400000) + 1;
}

publicApi.get("/public/vaccine-advisor-status", async (c) => {
  const testDate = c.req.query("testDate");
  const status = await getClinicStatus(testDate);
  const refDate = status.date; // YYYY-MM-DD the status was computed for

  // Today line + hours
  const openDot = status.isOpen ? "🟢" : "🔴";
  const openText = status.isOpen ? "วันนี้คลินิกเปิด" : "วันนี้คลินิกปิด";
  let msg = `${openDot} ${openText}`;

  if (status.isOpen && status.sessions.length > 0) {
    const hours = status.sessions
      .map((s) => `${padHM(s.open)}–${padHM(s.close)} น.`)
      .join("\n");
    msg += `\n\n🕘 เวลาให้บริการ\n${hours}`;
  } else if (!status.isOpen && status.closureMessage) {
    msg += `\n${status.closureMessage}`;
  }

  // Upcoming continuous closure (next future-dated active CLOSE_ALL after today)
  const { data: upcoming } = await admin
    .from("closures")
    .select("start_date,end_date,reason,message,closure_type")
    .eq("active", true)
    .eq("closure_type", "CLOSE_ALL")
    .gt("start_date", refDate)
    .order("start_date", { ascending: true })
    .limit(1);

  const next = upcoming?.[0];
  if (next) {
    const range = thaiDateRange(next.start_date, next.end_date);
    const total = daysInclusive(next.start_date, next.end_date);
    // ไม่แสดง closures.reason ต่อสาธารณะ — เป็นช่องอิสระที่เจ้าหน้าที่กรอก
    // (อาจเป็นเหตุผลส่วนตัว เช่น "แพทย์ติดภารกิจส่วนตัว") ไม่เหมาะเผยแพร่บนหน้าเว็บ
    msg += `\n\n📅 วันหยุดต่อเนื่องที่กำลังจะมาถึง\n${range}\nรวม ${total} วัน`;
  }

  return c.json({ ok: true, generatedAt: new Date().toISOString(), message: msg });
});
