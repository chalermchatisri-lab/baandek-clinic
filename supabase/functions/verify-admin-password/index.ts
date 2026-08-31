// Server-side check for the CRUD dashboard's "confirm password before save" gate.
// The dashboard (web/) never reads CRUD_ADMIN_PASSWORD itself — this function
// does, using the service-role key, and returns only ok:true/false.
//
// verify_jwt (set on deploy) only requires SOME valid Supabase JWT — the
// public anon key itself satisfies that, and it's embedded in the frontend
// bundle. So this function separately resolves the caller's identity with
// the anon client + incoming Authorization header: only a real signed-in
// dashboard user (an authenticated-role session, not just the anon key)
// reaches the actual password check below.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://vaccine-cbc-web.vercel.app",
  "http://localhost:5173",
  "http://localhost:4173",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

// Avoids leaking a match/no-match signal via response timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, headers);

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400, headers);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return json({ ok: false, error: "missing_password" }, 400, headers);

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ ok: false, error: "not_authenticated" }, 401, headers);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await admin
    .from("clinic_config")
    .select("value")
    .eq("key", "CRUD_ADMIN_PASSWORD")
    .maybeSingle();

  if (error) return json({ ok: false, error: "server_error" }, 500, headers);

  const stored = data?.value ?? "";
  if (!stored) return json({ ok: false, error: "not_configured" }, 200, headers);

  const match = timingSafeEqual(password, stored);
  return json({ ok: match, error: match ? undefined : "wrong_password" }, 200, headers);
});
