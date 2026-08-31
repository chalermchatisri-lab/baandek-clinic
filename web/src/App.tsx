import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { TABLES, type TableConfig } from "./lib/tables";
import { Login } from "./auth/Login";
import { Layout } from "./components/Layout";
import { CrudTable } from "./components/CrudTable";
import { StockPage } from "./components/StockPage";

export type View = { kind: "table"; cfg: TableConfig } | { kind: "stock" };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState<View>({ kind: "table", cfg: TABLES[0] });
  // null while loading, "" for full access (no staff_roles row), else the role string.
  const [role, setRole] = useState<string | null | "">(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setRole(null); return; }
    supabase
      .from("staff_roles")
      .select("role")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => setRole(data?.role ?? ""));
  }, [session]);

  if (!ready || (session && role === null)) {
    return <div className="grid min-h-full place-items-center text-clinic-muted">กำลังโหลด…</div>;
  }
  if (!session) return <Login />;

  const restrictToStock = role === "stock_only";
  const view: View = restrictToStock ? { kind: "stock" } : active;

  return (
    <Layout active={view} onSelect={setActive} email={session.user.email ?? ""} restrictToStock={restrictToStock}>
      {view.kind === "stock" ? <StockPage /> : <CrudTable cfg={view.cfg} />}
    </Layout>
  );
}
