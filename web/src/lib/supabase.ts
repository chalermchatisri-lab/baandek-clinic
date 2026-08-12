import { createClient } from "@supabase/supabase-js";
// anon key only — RLS enforces read-only + no PII. Auth adds dashboard CRUD.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
