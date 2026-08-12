import { useState } from "react";
import { supabase } from "../lib/supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    setBusy(false);
    if (error) setErr("เข้าสู่ระบบไม่สำเร็จ — ตรวจอีเมลและรหัสผ่านอีกครั้ง");
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-clinic-primary text-2xl text-white">🦕</div>
          <h1 className="text-xl font-semibold text-clinic-ink">บ้านเด็กคลินิก</h1>
          <p className="text-sm text-clinic-muted">ระบบจัดการข้อมูลวัคซีนและหน้าเว็บ</p>
        </div>

        <div className="rounded-2xl border border-clinic-border bg-white p-5">
          <div className="flex flex-col gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-clinic-ink">อีเมล</span>
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-clinic-border px-3 py-2 text-sm focus:border-clinic-primary600" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-clinic-ink">รหัสผ่าน</span>
              <input type="password" autoComplete="current-password" value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && signIn()}
                className="w-full rounded-lg border border-clinic-border px-3 py-2 text-sm focus:border-clinic-primary600" />
            </label>
            {err && <p className="text-sm text-clinic-danger">{err}</p>}
            <button onClick={signIn} disabled={busy || !email || !pw}
              className="mt-1 rounded-lg bg-clinic-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-clinic-primary600 disabled:opacity-60">
              {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
            </button>
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-clinic-muted">
          บัญชีสร้างโดยผู้ดูแลระบบใน Supabase → Authentication
        </p>
      </div>
    </div>
  );
}
