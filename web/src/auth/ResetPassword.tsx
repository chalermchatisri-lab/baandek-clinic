import { useState } from "react";
import { supabase } from "../lib/supabase";

// Shown instead of the dashboard when the user arrived via a Supabase
// password-recovery link. Without this, supabase-js's detectSessionInUrl
// silently turns the recovery token into a normal session and App.tsx would
// otherwise drop the user straight into the dashboard, never asking for a
// new password.
export function ResetPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(null);
    if (pw.length < 6) { setErr("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"); return; }
    if (pw !== pw2) { setErr("รหัสผ่านทั้งสองช่องไม่ตรงกัน"); return; }

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setErr("ตั้งรหัสผ่านไม่สำเร็จ — ลิงก์อาจหมดอายุ กรุณาขอลิงก์ใหม่"); return; }
    onDone();
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-clinic-primary text-2xl text-white">🦕</div>
          <h1 className="text-xl font-semibold text-clinic-ink">ตั้งรหัสผ่านใหม่</h1>
          <p className="text-sm text-clinic-muted">กรอกรหัสผ่านใหม่ 2 ครั้งเพื่อยืนยัน</p>
        </div>

        <div className="rounded-2xl border border-clinic-border bg-white p-5">
          <div className="flex flex-col gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-clinic-ink">รหัสผ่านใหม่</span>
              <input type="password" autoComplete="new-password" value={pw}
                onChange={(e) => setPw(e.target.value)}
                className="w-full rounded-lg border border-clinic-border px-3 py-2 text-sm focus:border-clinic-primary600" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-clinic-ink">ยืนยันรหัสผ่านใหม่</span>
              <input type="password" autoComplete="new-password" value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                className="w-full rounded-lg border border-clinic-border px-3 py-2 text-sm focus:border-clinic-primary600" />
            </label>
            {err && <p className="text-sm text-clinic-danger">{err}</p>}
            <button onClick={submit} disabled={busy || !pw || !pw2}
              className="mt-1 rounded-lg bg-clinic-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-clinic-primary600 disabled:opacity-60">
              {busy ? "กำลังบันทึก…" : "บันทึกรหัสผ่านใหม่"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
