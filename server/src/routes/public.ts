import { Hono } from "hono";
import { admin } from "../lib/supabase";

export const publicApi = new Hono();

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
    Role: r.role,
    Photo_URL: r.photo_url,
    Credentials: r.credentials,
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
