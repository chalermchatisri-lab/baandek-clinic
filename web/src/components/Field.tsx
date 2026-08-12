import type { Column } from "../lib/tables";

interface Props {
  col: Column;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  error?: string;
}

const base =
  "w-full rounded-lg border border-clinic-border bg-white px-3 py-2 text-sm " +
  "focus:border-clinic-primary600 focus:ring-0 disabled:bg-clinic-bg disabled:text-clinic-muted";

export function Field({ col, value, onChange, disabled, error }: Props) {
  const id = `f-${col.key}`;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 flex items-center gap-1 text-sm font-medium text-clinic-ink">
        {col.label}
        {col.required && <span className="text-clinic-accent">*</span>}
      </span>

      {col.type === "textarea" ? (
        <textarea id={id} className={base} rows={3} disabled={disabled}
          value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      ) : col.type === "select" ? (
        <select id={id} className={base} disabled={disabled}
          value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— เลือก —</option>
          {col.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : col.type === "boolean" ? (
        <button type="button" disabled={disabled} onClick={() => onChange(!value)}
          className={`flex h-8 w-14 items-center rounded-full px-1 transition ${
            value ? "bg-clinic-primary600" : "bg-clinic-border"
          } ${disabled ? "opacity-50" : ""}`} aria-pressed={!!value}>
          <span className={`h-6 w-6 rounded-full bg-white shadow transition ${value ? "translate-x-6" : ""}`} />
        </button>
      ) : col.type === "number" ? (
        <input id={id} type="number" className={base} disabled={disabled}
          min={col.min} step={col.step ?? 1}
          value={value === null || value === undefined ? "" : (value as number)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      ) : col.type === "date" ? (
        <input id={id} type="date" className={base} disabled={disabled}
          value={(value as string)?.slice(0, 10) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
      ) : (
        <input id={id} type="text" className={base} disabled={disabled}
          value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
      )}

      {col.help && !error && <span className="mt-1 block text-xs text-clinic-muted">{col.help}</span>}
      {error && <span className="mt-1 block text-xs text-clinic-danger">{error}</span>}
    </label>
  );
}
