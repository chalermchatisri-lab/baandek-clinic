import { createClient } from "@supabase/supabase-js";
import { env } from "./env";
// service-role client — backend only, bypasses RLS. NEVER expose to frontend.
export const admin = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: { persistSession: false },
});
