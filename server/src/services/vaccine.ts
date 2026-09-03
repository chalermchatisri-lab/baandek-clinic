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
 * เดือน" quick-reply button).
 *
 * *** แก้ 2026-09-03 ***: เดิมอายุ 2/4/6/9/12/18 เดือน ตอบจากข้อความ hardcode
 * (AGE_CARD_TEXT) ไม่เคย query Supabase เลย ทั้งที่ query เดียวกันนี้ทำงานถูกอยู่แล้ว
 * สำหรับ 24/36/48 เดือน + 4-12 ปี (ตรวจสอบแล้วว่า DB มีข้อมูลครบ/แม่นกว่า hardcode เดิม
 * ด้วยซ้ำ — บั๊กเดิมคือยังไม่เคยต่อสายมาใช้ ไม่ใช่ข้อมูลขาด) ลบ AGE_CARD_TEXT +
 * buildAgeCardByMonths ทิ้งทั้งหมด ใช้ query เดียวกันนี้กับทุกอายุแทน (2 เดือน–4-12 ปี)
 */

const AGE_GROUP_FOOTER_NOTE =
  "ชนิดวัคซีนและจำนวนเข็มอาจแตกต่างกันตามประวัติวัคซีนเดิม กรุณานำสมุดวัคซีนให้แพทย์ตรวจและพิจารณาก่อนรับวัคซีนค่ะ";

type DoseRow = {
  vaccine_id: string;
  name_th_override: string | null;
  status: string | null;
  vaccines: { name_th: string | null; priority: string | null; status: string | null };
};

// "Recommended" (เช่น RSV ตอน 2 เดือน, ไข้หวัดใหญ่ตอน 6 เดือน) จัดเป็น "พิจารณาตามเงื่อนไข"
// เหมือนข้อความ hardcode เดิม ไม่ใช่ "ตามเกณฑ์อายุ" ตามที่ Yai ยืนยัน (3 ก.ย. 2569)
const CONDITIONAL_PRIORITIES = new Set(["Optional", "Risk-based", "Recommended"]);

async function fetchAgeGroupDoses(ageCodes: string[]): Promise<DoseRow[]> {
  const { data } = await admin
    .from("vaccine_doses")
    .select("vaccine_id,name_th_override,status,vaccines!inner(name_th,priority,status)")
    .in("age_group", ageCodes)
    .eq("status", "ACTIVE");
  return (data ?? []) as unknown as DoseRow[];
}

/** จำนวนครั้งทั้งหมดที่ต้องรับต่อ vaccine_id ทั้งตาราง (นับจากจำนวนแถว vaccine_doses ที่ ACTIVE
 *  ของ vaccine_id นั้น ไม่ผูกกับ ageCodes ที่ query อยู่ตอนนี้) — ใช้แสดง "(รับทั้งหมด N ครั้ง)"
 *  แบบคำนวณจาก DB สด ไม่ hardcode จำนวนเข็ม เช่น Rotarix query ออกมา 2 แถว (2, 4 เดือน) → 2 ครั้ง,
 *  RotaTeq query ออกมา 3 แถว (2, 4, 6 เดือน) → 3 ครั้ง โดยอัตโนมัติ */
async function fetchDoseCounts(): Promise<Map<string, number>> {
  const { data } = await admin.from("vaccine_doses").select("vaccine_id").eq("status", "ACTIVE");
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { vaccine_id: string }[]) {
    counts.set(row.vaccine_id, (counts.get(row.vaccine_id) ?? 0) + 1);
  }
  return counts;
}

type AgeGroupBuckets = { routine: { name: string; doseCount: number }[]; conditional: { name: string; doseCount: number }[] };

async function buildAgeGroupBuckets(ageCodes: string[]): Promise<AgeGroupBuckets> {
  const [rows, doseCounts] = await Promise.all([fetchAgeGroupDoses(ageCodes), fetchDoseCounts()]);
  const seen = new Set<string>();
  const routine: { name: string; doseCount: number }[] = [];
  const conditional: { name: string; doseCount: number }[] = [];
  for (const row of rows) {
    if (row.vaccines.status !== "ACTIVE") continue;
    const name = row.name_th_override ?? row.vaccines.name_th;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const item = { name, doseCount: doseCounts.get(row.vaccine_id) ?? 1 };
    (CONDITIONAL_PRIORITIES.has(row.vaccines.priority ?? "") ? conditional : routine).push(item);
  }
  return { routine, conditional };
}

const doseSuffix = (n: number) => (n > 1 ? ` (รับทั้งหมด ${n} ครั้ง)` : "");

/** ageCodes match age_guide.age_code / vaccine_doses.age_group, e.g. ["24M"]
 *  for a single age or ["48M","51M","132M","138M"] for a broad "4-12 ปี" summary.
 *  Plain-text version — used for Messenger (Flex Message is LINE-only) and as the
 *  LINE altText for buildAgeCardFlex() below. */
export async function buildAgeGroupVaccineList(
  ageCodes: string[],
  label: string,
  link: string,
): Promise<string> {
  const { routine, conditional } = await buildAgeGroupBuckets(ageCodes);

  if (routine.length === 0 && conditional.length === 0) {
    return `👶 วัคซีนสำหรับเด็กอายุ ${label}\n\n` +
      `ยังไม่มีข้อมูลวัคซีนสำหรับช่วงอายุนี้ในระบบค่ะ กรุณาสอบถามเจ้าหน้าที่ หรือดูรายละเอียดเพิ่มเติมที่\n${link}`;
  }

  const sections = [`👶 วัคซีนสำหรับเด็กอายุ ${label}`];
  if (routine.length) sections.push("💉 วัคซีนตามเกณฑ์อายุ\n" + routine.map((v) => `• ${v.name}${doseSuffix(v.doseCount)}`).join("\n"));
  if (conditional.length) sections.push("🩺 วัคซีนที่พิจารณาตามเงื่อนไข\n" + conditional.map((v) => `• ${v.name}${doseSuffix(v.doseCount)}`).join("\n"));
  sections.push(`📌 ${AGE_GROUP_FOOTER_NOTE}`);
  sections.push(`👉 ดูรายละเอียดและราคา\n${link}`);
  return sections.join("\n\n");
}

// ธีมแบรนด์ตาม Notion "🎨 Flex Message Spec" (31 ส.ค. 2569): เขียว #A5CE89 / ครีม #FFF6E6
const BRAND_GREEN = "#A5CE89";
const BRAND_GREEN_DARK = "#6C9652";
const BRAND_CREAM = "#FFF6E6";
const TEXT_DARK = "#3C3C3C";
const TEXT_MUTED = "#8C8C8C";

/** LINE Flex Message version of the age-group card — hero image + ธีมแบรนด์
 *  เขียว/ครีม ต่อจาก query เดียวกับ buildAgeGroupVaccineList() ด้านบน (DB สดทุกครั้ง)
 *  Flex เป็นฟอร์แมต LINE เท่านั้น — channel === "messenger" ให้ใช้
 *  buildAgeGroupVaccineList() (ข้อความล้วน) แทน อย่าส่ง object นี้ไป Messenger */
export async function buildAgeCardFlex(
  ageCodes: string[],
  label: string,
  heroImageUrl: string,
  link: string,
): Promise<{ flex: Record<string, unknown>; altText: string }> {
  const { routine, conditional } = await buildAgeGroupBuckets(ageCodes);
  const altText = await buildAgeGroupVaccineList(ageCodes, label, link);

  const bulletRow = (text: string, dotColor: string) => ({
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: "●", size: "xs", color: dotColor, flex: 0 },
      { type: "text", text, wrap: true, size: "sm", color: TEXT_DARK, flex: 1 },
    ],
  });

  const body: Record<string, unknown>[] = [];
  if (routine.length === 0 && conditional.length === 0) {
    body.push({
      type: "text",
      wrap: true,
      size: "sm",
      color: TEXT_MUTED,
      text: "ยังไม่มีข้อมูลวัคซีนสำหรับช่วงอายุนี้ในระบบค่ะ กรุณาสอบถามเจ้าหน้าที่",
    });
  } else {
    if (routine.length) {
      body.push({ type: "text", text: "💉 วัคซีนตามเกณฑ์อายุ", weight: "bold", size: "sm", color: BRAND_GREEN_DARK, margin: body.length ? "lg" : "none" });
      body.push({ type: "box", layout: "vertical", spacing: "xs", margin: "sm",
        contents: routine.map((v) => bulletRow(v.name + doseSuffix(v.doseCount), BRAND_GREEN_DARK)) });
    }
    if (conditional.length) {
      body.push({ type: "text", text: "🩺 วัคซีนที่พิจารณาตามเงื่อนไข", weight: "bold", size: "sm", color: "#C2410C", margin: body.length ? "lg" : "none" });
      body.push({ type: "box", layout: "vertical", spacing: "xs", margin: "sm",
        contents: conditional.map((v) => bulletRow(v.name + doseSuffix(v.doseCount), "#C2410C")) });
    }
  }
  body.push({ type: "separator", margin: "lg" });
  body.push({ type: "text", text: `📌 ${AGE_GROUP_FOOTER_NOTE}`, wrap: true, size: "xxs", color: TEXT_MUTED, margin: "lg" });

  const flex = {
    type: "flex",
    altText,
    contents: {
      type: "bubble",
      hero: { type: "image", url: heroImageUrl, size: "full", aspectRatio: "20:13", aspectMode: "cover" },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: BRAND_CREAM,
        paddingAll: "16px",
        contents: [
          { type: "text", text: `👶 วัคซีนสำหรับเด็กอายุ ${label}`, weight: "bold", size: "md", color: TEXT_DARK, wrap: true },
          ...body,
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: BRAND_GREEN,
            height: "sm",
            action: { type: "uri", label: "ดูรายละเอียดและราคาเต็ม", uri: link },
          },
        ],
      },
    },
  };

  return { flex, altText };
}

