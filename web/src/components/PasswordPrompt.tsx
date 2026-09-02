import { useState } from "react";
import { verifyAdminPassword, adminPasswordErrorMessage } from "../lib/adminAuth";

export function PasswordPrompt({ actionLabel, onConfirm, onCancel }: {
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);

  async function confirm() {
    if (!pw || busy) return;
    setBusy(true); setErr(null);
    const res = await verifyAdminPassword(pw);
    setBusy(false);
    if (!res.ok) { setErr(adminPasswordErrorMessage(res.error)); return; }
    onConfirm();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-clinic-ink">ยืนยันรหัสผ่าน Admin</h3>
        <p className="mt-1 text-sm text-clinic-muted">ต้องกรอกรหัสผ่านก่อน{actionLabel}</p>
        <div className="relative mt-4">
          <input
            type={showPw ? "text" : "password"}
            autoFocus
            autoComplete="current-password"
            value={pw}
            onChange={(e) => { setPw(e.target.value); setErr(null); }}
            onKeyDown={(e) => e.key === "Enter" && confirm()}
            placeholder="รหัสผ่าน Admin"
            className="w-full rounded-lg border border-clinic-border px-3 py-2 pr-10 text-sm focus:border-clinic-primary600"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            tabIndex={-1}
            aria-label={showPw ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
            title={showPw ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-clinic-muted hover:text-clinic-ink"
          >
            {showPw ? "🙈" : "👁️"}
          </button>
        </div>
        {err && <p className="mt-2 text-sm text-clinic-danger">{err}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
            className="rounded-lg border border-clinic-border px-4 py-2 text-sm">ยกเลิก</button>
          <button onClick={confirm} disabled={busy || !pw}
            className="rounded-lg bg-clinic-primary px-4 py-2 text-sm font-medium text-white hover:bg-clinic-primary600 disabled:opacity-60">
            {busy ? "กำลังตรวจสอบ…" : "ยืนยัน"}
          </button>
        </div>
      </div>
    </div>
  );
}
