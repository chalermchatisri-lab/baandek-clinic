import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anon) console.error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");

// Authenticated users get full CRUD via the *_auth_all RLS policies;
// the anon key alone can only read public tables.
export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});
