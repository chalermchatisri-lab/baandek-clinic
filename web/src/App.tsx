import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { TABLES, type TableConfig } from "./lib/tables";
import { Login } from "./auth/Login";
import { Layout } from "./components/Layout";
import { CrudTable } from "./components/CrudTable";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState<TableConfig>(TABLES[0]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="grid min-h-full place-items-center text-clinic-muted">กำลังโหลด…</div>;
  if (!session) return <Login />;

  return (
    <Layout active={active} onSelect={setActive} email={session.user.email ?? ""}>
      <CrudTable cfg={active} />
    </Layout>
  );
}
