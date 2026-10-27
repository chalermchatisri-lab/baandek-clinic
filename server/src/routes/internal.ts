import { Hono } from "hono";
import { admin } from "../lib/supabase";
import { env } from "../lib/env";
import { pushMessage } from "./line";
import {
  getActiveStockItems,
  buildStockAlertMessage,
  getExpiringEmergencyItems,
  buildEmergencyExpiryMessage,
} from "../services/stock";
import { publishPendingPosts } from "../services/facebook";
import { getRichMenuStats, isYyyyMmDd, todayUtc9 } from "../services/lineInsight";

// Internal, non-public routes — called by scheduled infrastructure (GitHub
// Actions cron), never by a browser or LINE. Guarded by a shared secret
// (INTERNAL_CRON_SECRET), not CORS/JWT — there is no end-user session here.
export const internalApi = new Hono();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

internalApi.use("/internal/*", async (c, next) => {
  const token = c.req.header("x-internal-token") ?? "";
  if (!env.internalCronSecret || !timingSafeEqual(token, env.internalCronSecret)) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

async function config(key: string): Promise<string | null> {
  const { data } = await admin.from("clinic_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// ---- POST /internal/stock-alert-run ----
// Called once daily (~20:10 Bangkok, after the 20:00 .mdb sync) by
// .github/workflows/stock-alert-cron.yml. Sends a LINE push ONLY when there's
// at least one red/yellow item AND the dashboard toggle is on — a quiet day
// sends nothing, per spec (no noise when everything's green).
internalApi.post("/internal/stock-alert-run", async (c) => {
  const enabled = (await config("STOCK_ALERT_ENABLED")) === "true";
  if (!enabled) return c.json({ ok: true, skipped: "disabled" });

  const userId = await config("STOCK_ALERT_LINE_USERID");
  if (!userId) return c.json({ ok: true, skipped: "no_target_userid" });

  const items = await getActiveStockItems();
  const emergencyItems = await getExpiringEmergencyItems();
  const sections = [buildStockAlertMessage(items), buildEmergencyExpiryMessage(emergencyItems)].filter(
    (s): s is string => s !== null,
  );
  if (sections.length === 0) return c.json({ ok: true, skipped: "all_green" });
  const text = sections.join("\n\n");

  const sent = await pushMessage(userId, [{ type: "text", text }]);
  return c.json({ ok: sent, sent });
});

// ---- GET /internal/richmenu-insight?from=yyyyMMdd&to=yyyyMMdd ----
// Read-only: rich menu impressions + clicks per button, and this month's LINE
// push quota. Our rich menu is created via the Messaging API, so LINE OA
// Manager can't show its stats. Called manually via
// .github/workflows/richmenu-insight.yml (workflow_dispatch). Default period:
// LINE cutover to the Render backend (2026-08-30) → today. Aggregate counts
// only — no user IDs.
internalApi.get("/internal/richmenu-insight", async (c) => {
  const from = c.req.query("from") ?? "20260830";
  const to = c.req.query("to") ?? todayUtc9();
  if (!isYyyyMmDd(from) || !isYyyyMmDd(to)) {
    return c.json({ ok: false, error: "from/to must be yyyyMMdd" }, 400);
  }
  try {
    const result = await getRichMenuStats(from, to);
    return c.json(result, result.ok ? 200 : 502);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("richmenu-insight failed:", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

// ---- POST /internal/facebook-post-run ----
// Called every 15 minutes by .github/workflows/facebook-auto-post.yml.
// Picks up pending rows in `social_posts` (queued by Dino after Yai approves
// them in chat) and publishes each to the BAANDEK Facebook Page.
internalApi.post("/internal/facebook-post-run", async (c) => {
  try {
    const summary = await publishPendingPosts();

    if (summary.failed > 0) {
      console.warn(`facebook-post-run: ${summary.failed} post(s) failed`, summary.results.filter((r) => !r.ok));
    }

    return c.json(summary, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("facebook-post-run failed:", message);
    return c.json({ error: message }, 500);
  }
});
