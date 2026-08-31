import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { TableConfig, Column } from "../lib/tables";
import { Field } from "./Field";
import { PasswordPrompt } from "./PasswordPrompt";

type Row = Record<string, unknown>;

export function CrudTable({ cfg }: { cfg: TableConfig }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [isNew, setIsNew] = useState(false);

  const listCols = useMemo(() => cfg.columns.filter((c) => c.listShow), [cfg]);

  async function load() {
    setLoading(true); setErr(null);
    let q = supabase.from(cfg.name).select("*");
    if (cfg.orderBy) q = q.order(cfg.orderBy.col, { ascending: cfg.orderBy.asc });
    const { data, error } = await q;
    if (error) setErr(error.message);
    else setRows(data ?? []);
    setLoading(false);
  }
  useEffect(() => { load(); /* reload when table changes */ }, [cfg.name]);

  function openNew() {
    const blank: Row = {};
    cfg.columns.forEach((c) => (blank[c.key] = c.type === "boolean" ? false : null));
    setEditing(blank); setIsNew(true);
  }

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-clinic-ink">{cfg.label}</h1>
          {cfg.intro && <p className="mt-1 max-w-2xl text-sm text-clinic-muted">{cfg.intro}</p>}
        </div>
        <button onClick={openNew}
          className="shrink-0 rounded-lg bg-clinic-primary px-4 py-2 text-sm font-medium text-white hover:bg-clinic-primary600">
          + เพิ่มรายการ
        </button>
      </div>

      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-clinic-danger">โหลดไม่สำเร็จ: {err}</div>}

      <div className="overflow-x-auto rounded-xl border border-clinic-border bg-white scroll-thin">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-clinic-border bg-clinic-bg text-xs uppercase tracking-wide text-clinic-muted">
            <tr>
              {listCols.map((c) => <th key={c.key} className="px-4 py-3 font-medium">{c.label}</th>)}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={listCols.length + 1} className="px-4 py-10 text-center text-clinic-muted">กำลังโหลด…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={listCols.length + 1} className="px-4 py-10 text-center text-clinic-muted">
                ยังไม่มีรายการ — กด “เพิ่มรายการ” เพื่อสร้างรายการแรก
              </td></tr>
            ) : rows.map((r) => (
              <tr key={String(r[cfg.pk])} className="border-b border-clinic-border/60 last:border-0 hover:bg-clinic-primary050/40">
                {listCols.map((c) => (
                  <td key={c.key} className="px-4 py-3 align-top text-clinic-ink">{renderCell(c, r[c.key])}</td>
                ))}
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEditing({ ...r }); setIsNew(false); }}
                    className="text-sm font-medium text-clinic-primary600 hover:underline">แก้ไข</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditModal cfg={cfg} row={editing} isNew={isNew}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function renderCell(c: Column, v: unknown) {
  if (c.type === "boolean")
    return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${v ? "bg-clinic-primary050 text-clinic-primary" : "bg-clinic-bg text-clinic-muted"}`}>{v ? "ใช่" : "—"}</span>;
  if (v === null || v === undefined || v === "") return <span className="text-clinic-muted">—</span>;
  if (c.type === "select" && (c.key === "status"))
    return <span className={`rounded-full px-2 py-0.5 text-xs ${v === "ACTIVE" || v === "OPEN" ? "bg-clinic-primary050 text-clinic-primary" : "bg-clinic-bg text-clinic-muted"}`}>{String(v)}</span>;
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

function EditModal({ cfg, row, isNew, onClose, onSaved }:
  { cfg: TableConfig; row: Row; isNew: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Row>(row);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [pwPromptFor, setPwPromptFor] = useState<"save" | "delete" | null>(null);

  // On edit, the PK is fixed; on create with a user-entered PK it's editable.
  const pkLocked = !isNew || cfg.pkGenerated === true;

  function validate(): boolean {
    const e: Record<string, string> = {};
    for (const c of cfg.columns) {
      if (cfg.pkGenerated && c.key === cfg.pk) continue;
      const v = form[c.key];
      if (c.required && (v === null || v === undefined || v === "")) e[c.key] = "จำเป็นต้องกรอก";
      if (c.type === "number" && v !== null && v !== undefined && v !== "" && isNaN(Number(v))) e[c.key] = "ต้องเป็นตัวเลข";
      if (c.min != null && typeof v === "number" && v < c.min) e[c.key] = `ต้องไม่น้อยกว่า ${c.min}`;
    }
    // Domain rule: max age must be >= min age when both present.
    const mn = form["min_age_months"], mx = form["max_age_months"];
    if (typeof mn === "number" && typeof mx === "number" && mx < mn)
      e["max_age_months"] = "อายุสูงสุดต้องไม่น้อยกว่าอายุต่ำสุด";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Password confirmation gates the actual write — validate/confirm happen
  // first, the Supabase insert/update/delete only fires after the admin
  // password is verified server-side (doSave/doRemove below).
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
    const payload: Row = {};
    cfg.columns.forEach((c) => {
      if (cfg.pkGenerated && c.key === cfg.pk) return;
      payload[c.key] = form[c.key];
    });
    const res = isNew
      ? await supabase.from(cfg.name).insert(payload)
      : await supabase.from(cfg.name).update(payload).eq(cfg.pk, row[cfg.pk]);
    setSaving(false);
    if (res.error) setSaveErr(res.error.message);
    else onSaved();
  }

  async function doRemove() {
    setSaving(true);
    const { error } = await supabase.from(cfg.name).delete().eq(cfg.pk, row[cfg.pk]);
    setSaving(false);
    if (error) setSaveErr(error.message); else onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4"
      onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl scroll-thin sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-clinic-ink">
            {isNew ? `เพิ่ม${cfg.label}` : `แก้ไข${cfg.label}`}
          </h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-clinic-muted hover:bg-clinic-bg">✕</button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {cfg.columns.map((c) => {
            const full = c.type === "textarea";
            return (
              <div key={c.key} className={full ? "sm:col-span-2" : ""}>
                <Field col={c} value={form[c.key]} error={errors[c.key]}
                  disabled={c.key === cfg.pk && pkLocked}
                  onChange={(v) => setForm((f) => ({ ...f, [c.key]: v }))} />
              </div>
            );
          })}
        </div>

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
