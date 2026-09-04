import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { PasswordPrompt } from "./PasswordPrompt";

type AlertLevel = "green" | "yellow" | "red";
type Status = AlertLevel | "pending";

interface StockItem {
  id: string;
  mdb_item_id: number | null;
  name: string;
  category: string;
  unit: string | null;
  qty_on_hand: number;
  min_threshold: number | null;
  active: boolean;
  note: string | null;
  expiry_date: string | null;
  is_emergency: boolean;
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

// A row with no threshold yet (min_threshold IS NULL) is a brand-new item the
// sync job just discovered — no color can be computed until staff reviews it.
function statusOf(item: StockItem): Status {
  return item.min_threshold === null ? "pending" : alertLevel(item.qty_on_hand, item.min_threshold);
}

const DOT: Record<Status, string> = {
  green: "bg-clinic-primary600", yellow: "bg-amber-500", red: "bg-clinic-danger", pending: "bg-clinic-muted",
};
const BADGE: Record<Status, string> = {
  green: "bg-clinic-primary050 text-clinic-primary",
  yellow: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-clinic-danger",
  pending: "bg-clinic-bg text-clinic-muted",
};
const LABEL: Record<Status, string> = {
  green: "ปกติ", yellow: "ใกล้หมด", red: "หมด/ใกล้หมดมาก", pending: "รอตั้งค่า",
};

export function StockPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORY);
  const [tab, setTab] = useState<"active" | "inactive">("active");
  const [editing, setEditing] = useState<Partial<StockItem> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [alertEnabled, setAlertEnabled] = useState<boolean | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [deactivating, setDeactivating] = useState<StockItem | null>(null);
  const [activating, setActivating] = useState<StockItem | null>(null);

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
  const activeItems = useMemo(() => items.filter((i) => i.active), [items]);
  const inactiveItems = useMemo(() => items.filter((i) => !i.active), [items]);
  const pendingCount = useMemo(() => activeItems.filter((i) => i.min_threshold === null).length, [activeItems]);
  const visibleActive = useMemo(
    () => (categoryFilter === ALL_CATEGORY ? activeItems : activeItems.filter((i) => i.category === categoryFilter)),
    [activeItems, categoryFilter],
  );

  // *** แก้บั๊ก 2026-09-02 ***: เดิมใช้ .update().eq("key", ...) — ถ้าแถว
  // STOCK_ALERT_ENABLED ไม่มีอยู่ใน clinic_config เลย (แบบที่เจอจริง — ไม่เคย insert
  // ไว้ตั้งแต่แรก) update() จะจับคู่ 0 แถวและไม่ error เลย ทำให้ state ในหน้าเว็บดู
  // เหมือนกดติด (optimistic update) แต่ไม่มีอะไรถูกบันทึกจริง พอโหลดหน้าใหม่เลยเห็นปิด
  // เสมอ — เปลี่ยนเป็น upsert (มี key='STOCK_ALERT_ENABLED' เป็น primary key อยู่แล้ว)
  // เพื่อกันบั๊กคลาสเดียวกันไม่ให้เกิดซ้ำได้อีกไม่ว่าแถวจะมีอยู่ก่อนหรือไม่
  async function toggleAlert() {
    if (alertEnabled === null || toggleBusy) return;
    setToggleBusy(true);
    const next = !alertEnabled;
    const { error } = await supabase
      .from("clinic_config")
      .upsert({ key: "STOCK_ALERT_ENABLED", value: next ? "true" : "false", category: "BOT" });
    setToggleBusy(false);
    if (!error) setAlertEnabled(next);
    else console.error("toggleAlert: upsert failed", error.message);
  }

  function openNew() {
    setEditing({ name: "", category: "", unit: "", qty_on_hand: 0, min_threshold: 0, active: true, note: null, is_emergency: false });
    setIsNew(true);
  }

  async function confirmActivate() {
    if (!activating) return;
    const { error } = await supabase.from("stock_items").update({ active: true }).eq("id", activating.id);
    setActivating(null);
    if (!error) load();
  }

  async function confirmDeactivate(note: string) {
    if (!deactivating) return;
    const { error } = await supabase
      .from("stock_items")
      .update({ active: false, note: note.trim() || null })
      .eq("id", deactivating.id);
    setDeactivating(null);
    if (!error) load();
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

      <div className="mb-4 flex gap-1 border-b border-clinic-border">
        <button onClick={() => setTab("active")}
          className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition ${
            tab === "active" ? "border-clinic-primary600 text-clinic-primary" : "border-transparent text-clinic-muted hover:text-clinic-ink"
          }`}>
          รายการที่ใช้งาน
          {pendingCount > 0 && (
            <span className="rounded-full bg-clinic-bg px-1.5 py-0.5 text-xs text-clinic-muted">รอตั้งค่า {pendingCount}</span>
          )}
        </button>
        <button onClick={() => setTab("inactive")}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
            tab === "inactive" ? "border-clinic-primary600 text-clinic-primary" : "border-transparent text-clinic-muted hover:text-clinic-ink"
          }`}>
          รายการที่หยุดใช้ ({inactiveItems.length})
        </button>
      </div>

      {tab === "active" && (
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
      )}

      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-clinic-danger">โหลดไม่สำเร็จ: {err}</div>}

      {tab === "active" ? (
        <div className="overflow-x-auto rounded-xl border border-clinic-border bg-white scroll-thin">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-clinic-border bg-clinic-bg text-xs uppercase tracking-wide text-clinic-muted">
              <tr>
                <th className="px-4 py-3 font-medium">สถานะ</th>
                <th className="px-4 py-3 font-medium">ชื่อสินค้า</th>
                <th className="px-4 py-3 font-medium">หมวด</th>
                <th className="px-4 py-3 font-medium">คงเหลือ</th>
                <th className="px-4 py-3 font-medium">ขั้นต่ำ</th>
                <th className="px-4 py-3 font-medium">Emergency</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-clinic-muted">กำลังโหลด…</td></tr>
              ) : visibleActive.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-clinic-muted">ไม่มีรายการในหมวดนี้</td></tr>
              ) : visibleActive.map((item) => {
                const status = statusOf(item);
                return (
                  <tr key={item.id} className="border-b border-clinic-border/60 last:border-0 hover:bg-clinic-primary050/40">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${BADGE[status]}`}>
                        <span className={`h-2 w-2 rounded-full ${DOT[status]}`} />
                        {LABEL[status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top text-clinic-ink">{item.name}</td>
                    <td className="px-4 py-3 align-top text-clinic-muted">{item.category}</td>
                    <td className="px-4 py-3 align-top text-clinic-ink">{item.qty_on_hand} {item.unit ?? ""}</td>
                    <td className="px-4 py-3 align-top text-clinic-muted">{item.min_threshold ?? "—"}</td>
                    <td className="px-4 py-3 align-top">
                      {item.is_emergency ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                          ⚠️ {item.expiry_date ? `หมดอายุ ${item.expiry_date}` : "ยังไม่มีวันหมดอายุ"}
                        </span>
                      ) : (
                        <span className="text-clinic-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button onClick={() => setDeactivating(item)}
                        className="mr-3 text-sm font-medium text-clinic-muted hover:underline">หยุดใช้</button>
                      <button onClick={() => { setEditing(item); setIsNew(false); }}
                        className="text-sm font-medium text-clinic-primary600 hover:underline">แก้ไข</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-clinic-border bg-white scroll-thin">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-clinic-border bg-clinic-bg text-xs uppercase tracking-wide text-clinic-muted">
              <tr>
                <th className="px-4 py-3 font-medium">ชื่อสินค้า</th>
                <th className="px-4 py-3 font-medium">หมวด</th>
                <th className="px-4 py-3 font-medium">หมายเหตุ</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-clinic-muted">กำลังโหลด…</td></tr>
              ) : inactiveItems.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-clinic-muted">ไม่มีรายการที่หยุดใช้</td></tr>
              ) : inactiveItems.map((item) => (
                <tr key={item.id} className="border-b border-clinic-border/60 last:border-0 hover:bg-clinic-primary050/40">
                  <td className="px-4 py-3 align-top text-clinic-ink">{item.name}</td>
                  <td className="px-4 py-3 align-top text-clinic-muted">{item.category}</td>
                  <td className="px-4 py-3 align-top text-clinic-muted">{item.note || "—"}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => setActivating(item)}
                      className="mr-3 text-sm font-medium text-clinic-primary600 hover:underline">เปิดใช้</button>
                    <button onClick={() => { setEditing(item); setIsNew(false); }}
                      className="text-sm font-medium text-clinic-muted hover:underline">แก้ไข</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <StockEditModal
          row={editing}
          isNew={isNew}
          categories={categories.filter((c) => c !== ALL_CATEGORY)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      {deactivating && (
        <DeactivateModal
          itemName={deactivating.name}
          onCancel={() => setDeactivating(null)}
          onConfirm={confirmDeactivate}
        />
      )}

      {activating && (
        <PasswordPrompt
          actionLabel="เปิดใช้รายการนี้"
          onCancel={() => setActivating(null)}
          onConfirm={confirmActivate}
        />
      )}
    </div>
  );
}

// Collects an optional note, then hands off to the same admin-password gate
// as every other write in this page, before actually deactivating.
function DeactivateModal({ itemName, onCancel, onConfirm }: {
  itemName: string; onCancel: () => void; onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <PasswordPrompt
        actionLabel="หยุดใช้รายการนี้"
        onCancel={() => setConfirming(false)}
        onConfirm={() => onConfirm(note)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-clinic-ink">หยุดใช้ "{itemName}"</h3>
        <p className="mt-1 text-sm text-clinic-muted">
          รายการนี้จะถูกซ่อนจากรายการหลักและไม่รวมในแจ้งเตือน LINE — ใส่หมายเหตุไว้ได้ (ไม่บังคับ)
        </p>
        <textarea
          autoFocus
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder='เช่น "เลิกใช้ถาวร" หรือ "รอดูอาจใช้ใหม่"'
          className="mt-3 w-full rounded-lg border border-clinic-border px-3 py-2 text-sm focus:border-clinic-primary600 focus:ring-0"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-clinic-border px-4 py-2 text-sm">ยกเลิก</button>
          <button onClick={() => setConfirming(true)}
            className="rounded-lg bg-clinic-primary px-4 py-2 text-sm font-medium text-white hover:bg-clinic-primary600">
            หยุดใช้
          </button>
        </div>
      </div>
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
    if (form.min_threshold != null && form.min_threshold < 0) { setError("ขั้นต่ำต้องไม่ติดลบ"); return false; }
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
    const active = form.active ?? true;
    const payload = {
      name: form.name!.trim(),
      category: form.category!.trim(),
      unit: form.unit?.trim() || null,
      qty_on_hand: form.qty_on_hand,
      min_threshold: form.min_threshold ?? null,
      active,
      note: active ? null : (form.note?.trim() || null),
      is_emergency: form.is_emergency ?? false,
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
  const isPending = form.min_threshold == null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl scroll-thin sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-clinic-ink">{isNew ? "เพิ่มรายการสต็อก" : "แก้ไขรายการสต็อก"}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-clinic-muted hover:bg-clinic-bg">✕</button>
        </div>

        {isPending && !isNew && (
          <div className="mb-4 rounded-lg bg-clinic-bg px-3 py-2 text-sm text-clinic-muted">
            รายการนี้ยังไม่มีการตั้งค่าขั้นต่ำ (รอตั้งค่า) — กรอกขั้นต่ำด้านล่างเพื่อให้เริ่มคำนวณสถานะและรวมในแจ้งเตือนได้
          </div>
        )}

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
            <span className="mb-1 block text-sm font-medium text-clinic-ink">
              ขั้นต่ำก่อนแจ้งเตือน {isPending && <span className="font-normal text-clinic-muted">(ยังไม่ตั้งค่า)</span>}
            </span>
            <input type="number" min={0} className={inputCls} value={form.min_threshold ?? ""}
              placeholder="รอตั้งค่า"
              onChange={(e) => setForm((f) => ({ ...f, min_threshold: e.target.value === "" ? null : Number(e.target.value) }))} />
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <button type="button" onClick={() => setForm((f) => ({ ...f, active: !(f.active ?? true) }))}
              className={`flex h-8 w-14 items-center rounded-full px-1 transition ${form.active ?? true ? "bg-clinic-primary600" : "bg-clinic-border"}`}>
              <span className={`h-6 w-6 rounded-full bg-white shadow transition ${(form.active ?? true) ? "translate-x-6" : ""}`} />
            </button>
            <span className="text-sm text-clinic-ink">แสดงในรายการ/แจ้งเตือน</span>
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <button type="button" onClick={() => setForm((f) => ({ ...f, is_emergency: !(f.is_emergency ?? false) }))}
              className={`flex h-8 w-14 items-center rounded-full px-1 transition ${form.is_emergency ? "bg-amber-500" : "bg-clinic-border"}`}>
              <span className={`h-6 w-6 rounded-full bg-white shadow transition ${form.is_emergency ? "translate-x-6" : ""}`} />
            </button>
            <span className="text-sm text-clinic-ink">
              ยา Emergency <span className="font-normal text-clinic-muted">(เฝ้าวันหมดอายุแทนจำนวนคงเหลือ)</span>
            </span>
          </label>
          {form.is_emergency && (
            <div className="rounded-lg bg-clinic-bg px-3 py-2 text-sm text-clinic-muted sm:col-span-2">
              วันหมดอายุ: {form.expiry_date ?? "ยังไม่มีข้อมูล"} — sync มาจากโปรแกรม Doctor อัตโนมัติ แก้ที่นี่ไม่ได้
            </div>
          )}
          {!(form.active ?? true) && (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-clinic-ink">หมายเหตุ (หยุดใช้)</span>
              <textarea rows={2} className={inputCls} value={form.note ?? ""}
                placeholder='เช่น "เลิกใช้ถาวร" หรือ "รอดูอาจใช้ใหม่"'
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </label>
          )}
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
