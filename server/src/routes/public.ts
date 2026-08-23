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
          "title,category,cover_image_url,content_type,panel_images_folder,published,body_content,display_order"
        )
        .eq("published", true)
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
