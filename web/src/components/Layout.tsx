import { useState } from "react";
import { TABLES, GROUP_ORDER } from "../lib/tables";
import { supabase } from "../lib/supabase";
import type { View } from "../App";

const VACCINE_ADVISOR_CACHE_CLEAR_URL =
  "https://baandek-line-worker.baandek-clinic.workers.dev/vaccine-advisor/api/cache-clear";

export function Layout({ active, onSelect, email, restrictToStock, children }: {
  active: View; onSelect: (v: View) => void; email: string; restrictToStock?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [cacheState, setCacheState] = useState<"idle" | "loading" | "ok" | "error">("idle");

  async function clearVaccineAdvisorCache() {
    setCacheState("loading");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("ไม่พบ session — กรุณาล็อกอินใหม่");
      const res = await fetch(VACCINE_ADVISOR_CACHE_CLEAR_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setCacheState("ok");
    } catch {
      setCacheState("error");
    } finally {
      setTimeout(() => setCacheState("idle"), 2500);
    }
  }

  const stockButton = (
    <button onClick={() => { onSelect({ kind: "stock" }); setOpen(false); }}
      className={`rounded-lg px-3 py-2 text-left text-sm transition ${
        active.kind === "stock"
          ? "bg-clinic-primary050 font-medium text-clinic-primary"
          : "text-clinic-ink hover:bg-clinic-bg"
      }`}>
      สต็อกสินค้า
    </button>
  );

  const nav = (
    <nav className="flex flex-col gap-6 p-4">
      {restrictToStock ? (
        <div>
          <div className="flex flex-col gap-0.5">{stockButton}</div>
        </div>
      ) : (
        <>
          <div>
            <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-clinic-muted">สต็อก</div>
            <div className="flex flex-col gap-0.5">{stockButton}</div>
          </div>
          {GROUP_ORDER.map((g) => (
            <div key={g}>
              <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-clinic-muted">{g}</div>
              <div className="flex flex-col gap-0.5">
                {TABLES.filter((t) => t.group === g).map((t) => (
                  <button key={t.name} onClick={() => { onSelect({ kind: "table", cfg: t }); setOpen(false); }}
                    className={`rounded-lg px-3 py-2 text-left text-sm transition ${
                      active.kind === "table" && active.cfg.name === t.name
                        ? "bg-clinic-primary050 font-medium text-clinic-primary"
                        : "text-clinic-ink hover:bg-clinic-bg"
                    }`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </nav>
  );

  return (
    <div className="flex h-full">
      {/* Sidebar — desktop */}
      <aside className="hidden w-64 shrink-0 border-r border-clinic-border bg-white lg:block">
        <Brand />
        {nav}
      </aside>

      {/* Sidebar — mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <aside className="absolute left-0 top-0 h-full w-72 bg-white" onClick={(e) => e.stopPropagation()}>
            <Brand />
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-clinic-border bg-white/80 px-4 py-3 backdrop-blur">
          <button className="rounded-lg p-2 hover:bg-clinic-bg lg:hidden" onClick={() => setOpen(true)} aria-label="เมนู">☰</button>
          <div className="hidden text-sm text-clinic-muted lg:block">ระบบจัดการบ้านเด็กคลินิก</div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-clinic-muted sm:block">{email}</span>
            <button onClick={clearVaccineAdvisorCache} disabled={cacheState === "loading"}
              title="ล้าง cache หน้า Vaccine Advisor (baandek-line-worker) ให้เห็นข้อมูลล่าสุดทันที ไม่ต้องรอ 15 นาที"
              className="rounded-lg border border-clinic-border px-3 py-1.5 text-sm hover:bg-clinic-bg disabled:opacity-50">
              {cacheState === "loading" ? "กำลังล้าง…" : cacheState === "ok" ? "ล้างแล้ว ✓" : cacheState === "error" ? "ล้างไม่สำเร็จ ✗" : "ล้าง Cache หน้าวัคซีน"}
            </button>
            <button onClick={() => supabase.auth.signOut()}
              className="rounded-lg border border-clinic-border px-3 py-1.5 text-sm hover:bg-clinic-bg">ออกจากระบบ</button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto scroll-thin p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 border-b border-clinic-border px-4 py-4">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-clinic-primary text-lg text-white">🦕</span>
      <div className="leading-tight">
        <div className="text-sm font-semibold text-clinic-ink">บ้านเด็กคลินิก</div>
        <div className="text-xs text-clinic-muted">ระบบจัดการ</div>
      </div>
    </div>
  );
}
