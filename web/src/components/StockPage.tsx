import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { PasswordPrompt } from "./PasswordPrompt";

type AlertLevel = "green" | "yellow" | "red";

interface StockItem {
  id: string;
  mdb_item_id: number | null;
  name: string;
  category: string;
  unit: string | null;
  qty_on_hand: number;
  min_threshold: number;
  active: boolean;
  last_synced_at: string | null;
}

const ALL_CATEGORY = "ทั้งหมด";

// Mirrors server/src/services/stock.ts computeAlertLevel() exactly — kept in
// sync manually since this is a small pure function, not worth sharing a
// package over for two call sites.
function alertLevel(qty: number, threshold: number): AlertLevel {
  if (qty <= 0 || qty <= threshold * 0.5) return "red";
  if (qty <= threshold) return "yellow";
  return "green";
}

const DOT: Record<AlertLevel, string> = { green: "bg-clinic-primary600", yellow: "bg-amber-500", red: "bg-clinic-danger" };
const BADGE: Record<AlertLevel, string> = {
  green: "bg-clinic-primary050 text-clinic-primary",
  yellow: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-clinic-danger",
};
const LABEL: Record<AlertLevel, string> = { green: "ปกติ", yellow: "ใกล้หมด", red: "หมด/ใกล้หมดมาก" };

export function StockPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORY);
  const [editing, setEditing] = useState<Partial<StockItem> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [alertEnabled, setAlertEnabled] = useState<boolean | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  async function load() {
    setLoading(true); setErr(null);
    const [itemsRes, configRes] = await Promise.all([
      supabase.from("stock_items").select("*").order("category").order("name"),
      supabase.from("clinic_config").select("value").eq("key", "STOCK_ALERT_ENABLED").maybeSingle(),
    ]);
    if (itemsRes.error) setErr(itemsRes.error.message);
    else setItems(itemsRes.data ?? []);
    setAlertEnabled(configRes.data?.value === "true");
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const categories = useMemo(
    () => [ALL_CATEGORY, ...Array.from(new Set(items.map((i) => i.category))).sort()],
    [items],
  );
  const visible = useMemo(
    () => (categoryFilter === ALL_CATEGORY ? items : items.filter((i) => i.category === categoryFilter))
      .filter((i) => i.active),
    [items, categoryFilter],
  );

  async function toggleAlert() {
    if (alertEnabled === null || toggleBusy) return;
    setToggleBusy(true);
    const next = !alertEnabled;
    const { error } = await supabase
      .from("clinic_config")
      .update({ value: next ? "true" : "false" })
      .eq("key", "STOCK_ALERT_ENABLED");
    setToggleBusy(false);
    if (!error) setAlertEnabled(next);
  }

  function openNew() {
    setEditing({ name: "", category: "", unit: "", qty_on_hand: 0, min_threshold: 0, active: true });
    setIsNew(true);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-clinic-ink">สต็อกสินค้า</h1>
          <p className="mt-1 max-w-2xl text-sm text-clinic-muted">
            ยา/นม/วัคซีน — sync จาก KallayaClinic.mdb ทุกวัน 20:00 (จำนวนคงเหลือ) ส่วนชื่อ/หมวด/ขั้นต่ำแก้ไขที่นี่ได้เลย ไม่ถูก sync ทับ
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleAlert}
            disabled={alertEnabled === null || toggleBusy}
            title="แจ้งเตือน LINE อัตโนมัติทุกวัน 20:10 เมื่อมีรายการใกล้หมด/หมด"
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
              alertEnabled ? "border-clinic-primary600 bg-clinic-primary050 text-clinic-primary" : "border-clinic-border text-clinic-muted"
            } disabled:opacity-50`}>
            <span className={`h-5 w-9 rounded-full transition ${alertEnabled ? "bg-clinic-primary600" : "bg-clinic-border"} relative`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${alertEnabled ? "left-4.5 translate-x-4" : "left-0.5"}`} />
            </span>
            แจ้งเตือน LINE {alertEnabled ? "เปิดอยู่" : "ปิดอยู่"}
          </button>
          <button onClick={openNew}
            className="shrink-0 rounded-lg bg-clinic-primary px-4 py-2 text-sm font-medium text-white hover:bg-clinic-primary600">
            + เพิ่มรายการ
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {categories.map((c) => (
          <button key={c} onClick={() => setCategoryFilter(c)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${
              categoryFilter === c
                ? "border-clinic-primary600 bg-clinic-primary050 text-clinic-primary"
                : "border-clinic-border text-clinic-muted hover:bg-clinic-bg"
            }`}>
            {c}
          </button>
        ))}
      </div>

      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-clinic-danger">โหลดไม่สำเร็จ: {err}</div>}

      <div className="overflow-x-auto rounded-xl border border-clinic-border bg-white scroll-thin">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-clinic-border bg-clinic-bg text-xs uppercase tracking-wide text-clinic-muted">
            <tr>
              <th className="px-4 py-3 font-medium">สถานะ</th>
              <th className="px-4 py-3 font-medium">ชื่อสินค้า</th>
              <th className="px-4 py-3 font-medium">หมวด</th>
              <th className="px-4 py-3 font-medium">คงเหลือ</th>
              <th className="px-4 py-3 font-medium">ขั้นต่ำ</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-clinic-muted">กำลังโหลด…</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-clinic-muted">ไม่มีรายการในหมวดนี้</td></tr>
            ) : visible.map((item) => {
              const level = alertLevel(item.qty_on_hand, item.min_threshold);
              return (
                <tr key={item.id} className="border-b border-clinic-border/60 last:border-0 hover:bg-clinic-primary050/40">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${BADGE[level]}`}>
                      <span className={`h-2 w-2 rounded-full ${DOT[level]}`} />
                      {LABEL[level]}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top text-clinic-ink">{item.name}</td>
                  <td className="px-4 py-3 align-top text-clinic-muted">{item.category}</td>
                  <td className="px-4 py-3 align-top text-clinic-ink">{item.qty_on_hand} {item.unit ?? ""}</td>
                  <td className="px-4 py-3 align-top text-clinic-muted">{item.min_threshold}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => { setEditing(item); setIsNew(false); }}
                      className="text-sm font-medium text-clinic-primary600 hover:underline">แก้ไข</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <StockEditModal
          row={editing}
          isNew={isNew}
          categories={categories.filter((c) => c !== ALL_CATEGORY)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function StockEditModal({ row, isNew, categories, onClose, onSaved }: {
  row: Partial<StockItem>; isNew: boolean; categories: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<Partial<StockItem>>(row);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [pwPromptFor, setPwPromptFor] = useState<"save" | "delete" | null>(null);

  function validate(): boolean {
    if (!form.name?.trim()) { setError("กรอกชื่อสินค้า"); return false; }
    if (!form.category?.trim()) { setError("กรอกหมวดหมู่"); return false; }
    if (form.qty_on_hand == null || form.qty_on_hand < 0) { setError("จำนวนคงเหลือต้องไม่ติดลบ"); return false; }
    if (form.min_threshold == null || form.min_threshold < 0) { setError("ขั้นต่ำต้องไม่ติดลบ"); return false; }
    setError(null);
    return true;
  }

  function handleSaveClick() {
    if (!validate()) return;
    setPwPromptFor("save");
  }

  function handleDeleteClick() {
    if (!confirm("ลบรายการนี้? การลบไม่สามารถย้อนกลับได้")) return;
    setPwPromptFor("delete");
  }

  async function doSave() {
    setSaving(true); setSaveErr(null);
    const payload = {
      name: form.name!.trim(),
      category: form.category!.trim(),
      unit: form.unit?.trim() || null,
      qty_on_hand: form.qty_on_hand,
      min_threshold: form.min_threshold,
      active: form.active ?? true,
    };
    const res = isNew
      ? await supabase.from("stock_items").insert(payload)
      : await supabase.from("stock_items").update(payload).eq("id", row.id);
    setSaving(false);
    if (res.error) setSaveErr(res.error.message);
    else onSaved();
  }

  async function doRemove() {
    setSaving(true);
    const { error: delErr } = await supabase.from("stock_items").delete().eq("id", row.id);
    setSaving(false);
    if (delErr) setSaveErr(delErr.message); else onSaved();
  }

  const inputCls = "w-full rounded-lg border border-clinic-border bg-white px-3 py-2 text-sm focus:border-clinic-primary600 focus:ring-0";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl scroll-thin sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-clinic-ink">{isNew ? "เพิ่มรายการสต็อก" : "แก้ไขรายการสต็อก"}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-clinic-muted hover:bg-clinic-bg">✕</button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-clinic-ink">ชื่อสินค้า <span className="text-clinic-accent">*</span></span>
            <input className={inputCls} value={form.name ?? ""} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-clinic-ink">หมวดหมู่ <span className="text-clinic-accent">*</span></span>
            <input className={inputCls} list="stock-categories" value={form.category ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
            <datalist id="stock-categories">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-clinic-ink">หน่วย</span>
            <input className={inputCls} value={form.unit ?? ""} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-clinic-ink">จำนวนคงเหลือ <span className="text-clinic-accent">*</span></span>
            <input type="number" min={0} className={inputCls} value={form.qty_on_hand ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, qty_on_hand: Number(e.target.value) }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-clinic-ink">ขั้นต่ำก่อนแจ้งเตือน <span className="text-clinic-accent">*</span></span>
            <input type="number" min={0} className={inputCls} value={form.min_threshold ?? 0}
              onChange={(e) => setForm((f) => ({ ...f, min_threshold: Number(e.target.value) }))} />
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <button type="button" onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
              className={`flex h-8 w-14 items-center rounded-full px-1 transition ${form.active ?? true ? "bg-clinic-primary600" : "bg-clinic-border"}`}>
              <span className={`h-6 w-6 rounded-full bg-white shadow transition ${(form.active ?? true) ? "translate-x-6" : ""}`} />
            </button>
            <span className="text-sm text-clinic-ink">แสดงในรายการ/แจ้งเตือน</span>
          </label>
        </div>

        {error && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-clinic-danger">{error}</div>}
        {saveErr && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-clinic-danger">บันทึกไม่สำเร็จ: {saveErr}</div>}

        <div className="mt-6 flex items-center justify-between">
          {!isNew ? (
            <button onClick={handleDeleteClick} disabled={saving}
              className="rounded-lg px-3 py-2 text-sm font-medium text-clinic-danger hover:bg-red-50">ลบ</button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-clinic-border px-4 py-2 text-sm">ยกเลิก</button>
            <button onClick={handleSaveClick} disabled={saving}
              className="rounded-lg bg-clinic-primary px-5 py-2 text-sm font-medium text-white hover:bg-clinic-primary600 disabled:opacity-60">
              {saving ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
        </div>
      </div>

      {pwPromptFor && (
        <PasswordPrompt
          actionLabel={pwPromptFor === "delete" ? "ลบข้อมูล" : "บันทึกข้อมูล"}
          onCancel={() => setPwPromptFor(null)}
          onConfirm={() => {
            const action = pwPromptFor;
            setPwPromptFor(null);
            if (action === "save") void doSave();
            else void doRemove();
          }}
        />
      )}
    </div>
  );
}
