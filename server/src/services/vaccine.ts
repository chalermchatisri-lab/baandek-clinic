import { admin } from "../lib/supabase";

/**
 * ONE data-driven advice builder — replaces the 14 near-identical
 * vrBuildXxxLineMessagesDemo_ functions (~1000 LOC) in the old Apps Script.
 * Everything reads from vaccine_rules + vaccines. Add a vaccine = add a row,
 * not a function.
 */
export interface AdviceCard {
  title: string;
  ageRange: string;
  doses?: number | null;
  interval?: number | null;
  price?: number | null;
  priceOptions?: { name: string; price: number }[];
  message?: string | null;
  note?: string | null;
}

const fmtAge = (min?: number | null, max?: number | null) => {
  const a = (m?: number | null) =>
    m == null ? "" : m < 12 ? `${m} เดือน` : `${Math.floor(m / 12)} ปี${m % 12 ? ` ${m % 12} เดือน` : ""}`;
  if (min != null && max != null) return `${a(min)} – ${a(max)}`;
  if (min != null) return `ตั้งแต่ ${a(min)}`;
  if (max != null) return `ไม่เกิน ${a(max)}`;
  return "ทุกช่วงอายุ";
};

export async function buildVaccineAdvice(
  vaccineGroup: string,
  ageMonths: number | null,
): Promise<AdviceCard[]> {
  // rules for the group, optionally filtered to the queried age
  let q = admin
    .from("vaccine_rules")
    .select("*")
    .eq("vaccine_group", vaccineGroup)
    .eq("status", "ACTIVE")
    .order("sort_order", { ascending: true });
  const { data: rules } = await q;
  if (!rules?.length) return [];

  // price map from vaccines in the same group
  const { data: vax } = await admin
    .from("vaccines")
    .select("product_code, price, name_th")
    .eq("group_code", vaccineGroup)
    .eq("status", "ACTIVE");
  const priceByCode = new Map((vax ?? []).map((v) => [v.product_code, v.price]));
  const nameByCode = new Map((vax ?? []).map((v) => [v.product_code, v.name_th]));
  // Group-level fallback: rules may key on the group (e.g. 'PCV') while the
  // catalog lists concrete products ('PCV13/15/20'). Offer those as options.
  const groupProducts = (vax ?? [])
    .filter((v) => v.price != null)
    .map((v) => ({ name: v.name_th ?? v.product_code, price: v.price as number }));
  const groupMinPrice = groupProducts.length
    ? Math.min(...groupProducts.map((p) => p.price))
    : null;

  const applicable =
    ageMonths == null
      ? rules
      : rules.filter(
          (r) =>
            (r.min_age_months == null || ageMonths >= r.min_age_months) &&
            (r.max_age_months == null || ageMonths <= r.max_age_months),
        );

  return (applicable.length ? applicable : rules).map((r) => ({
    title: nameByCode.get(r.product_code) ?? r.product_code ?? vaccineGroup,
    ageRange: fmtAge(r.min_age_months, r.max_age_months),
    doses: r.primary_doses,
    interval: r.interval_days,
    price: priceByCode.get(r.product_code) ?? groupMinPrice ?? null,
    priceOptions: priceByCode.get(r.product_code) == null ? groupProducts : [],
    message: r.display_message,
    note: r.doctor_review,
  }));
}
