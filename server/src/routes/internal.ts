import { Hono } from "hono";
import { admin } from "../lib/supabase";
import { env } from "../lib/env";
import { pushMessage } from "./line";
import { getActiveStockItems, buildStockAlertMessage } from "../services/stock";

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
  const text = buildStockAlertMessage(items);
  if (!text) return c.json({ ok: true, skipped: "all_green" });

  const sent = await pushMessage(userId, [{ type: "text", text }]);
  return c.json({ ok: sent, sent });
});
