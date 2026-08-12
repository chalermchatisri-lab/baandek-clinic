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

/**
 * Policy (set by clinic): follow the standard vaccine_rules ONLY.
 * Anything outside a matching standard rule -> refer to a doctor, never guess.
 */
export interface AdviceResult {
  cards: AdviceCard[];
  status: "ok" | "no_rule_for_age" | "no_rules" | "needs_doctor";
}

const DOCTOR_NOTE =
  "ข้อมูลข้างต้นเป็นแนวทางมาตรฐานค่ะ 🩺\nกรณีนอกเหนือจากนี้ เช่น รับวัคซีนล่าช้า ประวัติไม่ครบ หรือมีข้อสงสัย " +
  "กรุณาปรึกษาแพทย์ที่คลินิกเพื่อจัดตารางเฉพาะบุคคลค่ะ";
export const DOCTOR_REFERRAL =
  "สำหรับกรณีนี้ แนะนำให้ปรึกษาแพทย์ที่บ้านเด็กคลินิกโดยตรงค่ะ 🩺\n" +
  "แพทย์จะช่วยประเมินและจัดตารางวัคซีนให้เหมาะกับน้องเป็นรายบุคคลค่ะ";

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
): Promise<AdviceResult> {
  const { data: rules } = await admin
    .from("vaccine_rules")
    .select("*")
    .eq("vaccine_group", vaccineGroup)
    .eq("status", "ACTIVE")
    .order("sort_order", { ascending: true });
  if (!rules?.length) return { cards: [], status: "no_rules" };

  const { data: vax } = await admin
    .from("vaccines")
    .select("product_code, price, name_th")
    .eq("group_code", vaccineGroup)
    .eq("status", "ACTIVE");
  const priceByCode = new Map((vax ?? []).map((v) => [v.product_code, v.price]));
  const nameByCode = new Map((vax ?? []).map((v) => [v.product_code, v.name_th]));
  const groupProducts = (vax ?? [])
    .filter((v) => v.price != null)
    .map((v) => ({ name: v.name_th ?? v.product_code, price: v.price as number }));
  const groupMinPrice = groupProducts.length
    ? Math.min(...groupProducts.map((p) => p.price))
    : null;

  // Age given: STANDARD rules only. No match in range -> refer to doctor (no guessing).
  const applicable =
    ageMonths == null
      ? rules
      : rules.filter(
          (r) =>
            (r.min_age_months == null || ageMonths >= r.min_age_months) &&
            (r.max_age_months == null || ageMonths <= r.max_age_months),
        );

  if (ageMonths != null && applicable.length === 0) {
    return { cards: [], status: "no_rule_for_age" };   // out of standard schedule -> doctor
  }

  const cards = applicable.map((r) => ({
    title: nameByCode.get(r.product_code) ?? r.product_code ?? vaccineGroup,
    ageRange: fmtAge(r.min_age_months, r.max_age_months),
    doses: r.primary_doses,
    interval: r.interval_days,
    price: priceByCode.get(r.product_code) ?? groupMinPrice ?? null,
    priceOptions: priceByCode.get(r.product_code) == null ? groupProducts : [],
    message: r.display_message,
    note: r.doctor_review,
  }));
  return { cards, status: "ok" };
}

