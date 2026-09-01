import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { TABLES, type TableConfig } from "./lib/tables";
import { Login } from "./auth/Login";
import { ResetPassword } from "./auth/ResetPassword";
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
  // A password-recovery link logs the user in via the URL's access_token
  // (supabase-js's detectSessionInUrl) — without tracking this separately,
  // that login would look identical to a normal one and drop the user
  // straight into the dashboard instead of asking for a new password.
  const [isRecovery, setIsRecovery] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") {
        setIsRecovery(true);
        // Scrub the raw access_token out of the URL bar now that supabase-js
        // has consumed it — no reason for it to sit in address bar/history.
        window.history.replaceState(null, "", window.location.pathname);
      }
      setSession(s);
    });
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
  if (isRecovery) return <ResetPassword onDone={() => setIsRecovery(false)} />;
  if (!session) return <Login />;

  const restrictToStock = role === "stock_only";
  const view: View = restrictToStock ? { kind: "stock" } : active;

  return (
    <Layout active={view} onSelect={setActive} email={session.user.email ?? ""} restrictToStock={restrictToStock}>
      {view.kind === "stock" ? <StockPage /> : <CrudTable cfg={view.cfg} />}
    </Layout>
  );
}
