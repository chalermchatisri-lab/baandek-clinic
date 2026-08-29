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

/**
 * Age-only vaccine list (no specific vaccine named — e.g. tapping a bare "2
 * เดือน" quick-reply button). Two data sources, both ported from the old
 * Apps Script system (BAANDEK_VaccineEngine/MessengerWebhook.js, "Age
 * Intelligence Engine" section) rather than invented:
 *
 * - AGE_CARD_TEXT (2/4/6/9/12/18 months): the old system had real, detailed
 *   itemized cards for exactly these ages — ported near-verbatim below.
 * - buildAgeGroupVaccineList() (2/3/4 years, 4-12 years): the old system had
 *   NO itemized content for these ages at all, just a generic "check the
 *   Vaccine Advisor" blurb. Per instruction, this queries the same
 *   age_guide/vaccine_doses tables the live Vaccine Advisor web page
 *   already uses, instead of carrying that generic blurb forward.
 */

const AGE_GROUP_FOOTER_NOTE =
  "📌 ชนิดวัคซีนและจำนวนเข็มอาจแตกต่างกันตามประวัติวัคซีนเดิม กรุณานำสมุดวัคซีนให้แพทย์ตรวจและพิจารณาก่อนรับวัคซีนค่ะ";

const AGE_CARD_TEXT: Record<number, { label: string; routine: string[]; conditional: string[] }> = {
  2: {
    label: "2 เดือน",
    routine: ["วัคซีนรวม 6 โรค", "วัคซีนโรต้า", "วัคซีนป้องกันโรคไอพีดี (PCV)"],
    conditional: ["RSV", "วัคซีนไข้กาฬหลังแอ่น"],
  },
  4: {
    label: "4 เดือน",
    routine: ["วัคซีนรวม 5 โรค", "วัคซีนโรต้า", "วัคซีนป้องกันโรคไอพีดี (PCV)"],
    conditional: ["RSV", "วัคซีนไข้กาฬหลังแอ่น"],
  },
  6: {
    label: "6 เดือน",
    routine: [
      "วัคซีนรวม 6 โรค",
      "วัคซีนโรต้า (ครั้งที่ 3 กรณีได้รับวัคซีนชนิด 5 สายพันธุ์)",
      "วัคซีนป้องกันโรคไอพีดี (PCV)",
      "วัคซีนไข้หวัดใหญ่",
    ],
    conditional: ["RSV", "วัคซีนไข้กาฬหลังแอ่น"],
  },
  9: {
    label: "9 เดือน",
    routine: ["วัคซีนหัด หัดเยอรมัน คางทูม (MMR)", "วัคซีนไข้หวัดใหญ่ (กรณียังไม่เคยได้รับ)"],
    conditional: ["วัคซีนไข้กาฬหลังแอ่น"],
  },
  12: {
    label: "1 ปี",
    routine: [
      "วัคซีนป้องกันโรคไอพีดี (PCV) กระตุ้น",
      "วัคซีนไข้สมองอักเสบเจอี (JE)",
      "วัคซีนตับอักเสบเอ (วัคซีนเสริม ครั้งที่ 1)",
      "วัคซีนอีสุกอีใส (วัคซีนเสริม ครั้งที่ 1)",
      "วัคซีนไข้หวัดใหญ่ (กรณียังไม่เคยได้รับ)",
    ],
    conditional: ["วัคซีนไข้กาฬหลังแอ่น"],
  },
  18: {
    label: "1 ปีครึ่ง",
    routine: [
      "วัคซีนรวมคอตีบ ไอกรน บาดทะยัก และโปลิโอ",
      "วัคซีนหัด หัดเยอรมัน คางทูม (MMR) กระตุ้น",
      "วัคซีนไข้หวัดใหญ่ (กรณียังไม่เคยได้รับหรือยังได้รับไม่ครบ)",
    ],
    conditional: ["วัคซีนไข้กาฬหลังแอ่น (หากยังไม่เคยได้รับวัคซีน)"],
  },
};

export function buildAgeCardByMonths(ageMonths: number, link: string): string | null {
  const content = AGE_CARD_TEXT[ageMonths];
  if (!content) return null;
  const sections = [
    `👶 วัคซีนสำหรับเด็กอายุ ${content.label}`,
    "💉 วัคซีนตามเกณฑ์อายุ\n" + content.routine.map((n) => `• ${n}`).join("\n"),
  ];
  if (content.conditional.length) {
    sections.push("🩺 วัคซีนที่พิจารณาตามเงื่อนไข\n" + content.conditional.map((n) => `• ${n}`).join("\n"));
  }
  sections.push(AGE_GROUP_FOOTER_NOTE);
  sections.push(`👉 ดูรายละเอียดและราคา\n${link}`);
  return sections.join("\n\n");
}

type DoseRow = {
  name_th_override: string | null;
  status: string | null;
  vaccines: { name_th: string | null; priority: string | null; status: string | null };
};

const CONDITIONAL_PRIORITIES = new Set(["Optional", "Risk-based"]);

/** ageCodes match age_guide.age_code / vaccine_doses.age_group, e.g. ["24M"]
 *  for a single age or ["48M","51M","132M","138M"] for a broad "4-12 ปี" summary. */
export async function buildAgeGroupVaccineList(
  ageCodes: string[],
  label: string,
  link: string,
): Promise<string> {
  const { data } = await admin
    .from("vaccine_doses")
    .select("name_th_override,status,vaccines!inner(name_th,priority,status)")
    .in("age_group", ageCodes)
    .eq("status", "ACTIVE");

  const rows = (data ?? []) as unknown as DoseRow[];
  const routine = new Set<string>();
  const conditional = new Set<string>();
  for (const row of rows) {
    if (row.vaccines.status !== "ACTIVE") continue;
    const name = row.name_th_override ?? row.vaccines.name_th;
    if (!name) continue;
    (CONDITIONAL_PRIORITIES.has(row.vaccines.priority ?? "") ? conditional : routine).add(name);
  }

  if (routine.size === 0 && conditional.size === 0) {
    return `👶 วัคซีนสำหรับเด็กอายุ ${label}\n\n` +
      `ยังไม่มีข้อมูลวัคซีนสำหรับช่วงอายุนี้ในระบบค่ะ กรุณาสอบถามเจ้าหน้าที่ หรือดูรายละเอียดเพิ่มเติมที่\n${link}`;
  }

  const sections = [`👶 วัคซีนสำหรับเด็กอายุ ${label}`];
  if (routine.size) sections.push("💉 วัคซีนตามเกณฑ์อายุ\n" + [...routine].map((n) => `• ${n}`).join("\n"));
  if (conditional.size) sections.push("🩺 วัคซีนที่พิจารณาตามเงื่อนไข\n" + [...conditional].map((n) => `• ${n}`).join("\n"));
  sections.push(AGE_GROUP_FOOTER_NOTE);
  sections.push(`👉 ดูรายละเอียดและราคา\n${link}`);
  return sections.join("\n\n");
}

