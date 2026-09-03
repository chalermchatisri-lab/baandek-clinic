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
  age_group: string;
  vaccine_id: string;
  name_th_override: string | null;
  status: string | null;
  vaccines: { name_th: string | null; priority: string | null; status: string | null; group_code: string | null };
};

// "Recommended" (เช่น RSV, ไข้หวัดใหญ่) จัดเป็น "พิจารณาตามเงื่อนไข" โดย default เหมือนข้อความ
// hardcode เดิม — ยกเว้นไข้หวัดใหญ่ที่มีกฎอายุพิเศษของตัวเอง ดู INFLUENZA ใน buildAgeGroupBuckets()
const CONDITIONAL_PRIORITIES = new Set(["Optional", "Risk-based", "Recommended"]);

// *** เพิ่ม 2026-09-03 (รอบบ่าย) ***: กลุ่มวัคซีนที่มีหลายชนิด/ยี่ห้อให้เลือกได้ ณ อายุเดียวกัน
// (ไม่ต้องรับครบทุกตัว) — ถ้าอายุนั้นมีมากกว่า 1 ชนิดในกลุ่มเดียวกันจริง ให้ยุบรวมเป็นบรรทัดเดียว
// "ชื่อกลุ่ม (มี N ชนิด สอบถามแพทย์ก่อนรับ)" กันผู้ปกครองเข้าใจผิดว่าต้องรับทุกชนิด — ไม่รวม
// DTP_POLIO_COMBO เพราะ 4-in-1/5-in-1/6-in-1 ป้องกันโรคไม่เท่ากันจริง (คนละสูตร ไม่ใช่ยี่ห้อทางเลือก)
// ยืนยันกับ Yai แล้ว
const GROUP_DISPLAY_NAME: Record<string, string> = {
  ROTAVIRUS: "วัคซีนโรต้า",
  PCV: "วัคซีนปอดบวม",
  RSV: "ภูมิสำเร็จรูปป้องกัน RSV",
  INFLUENZA: "วัคซีนไข้หวัดใหญ่",
  HPV: "วัคซีนป้องกันเอชพีวี",
};
const groupSuffix = (groupCode: string, n: number): string =>
  groupCode === "INFLUENZA"
    ? " (มี 2 ชนิด: แบบฉีด และแบบพ่นจมูก สอบถามแพทย์ก่อนรับ)"
    : ` (มี ${n} ชนิด สอบถามแพทย์ก่อนรับ)`;

// ข้อความ override เฉพาะแถว (vaccine_id + age_group) ที่ยืนยันคำต่อคำกับ Yai แล้ว — ใช้แทนชื่อเดี่ยวๆ
// ปกติ เมื่อเหตุผลเป็นเรื่องคลินิก (รับต่อจากเดิม / เตือนถ้ายังไม่เคยรับ) ไม่ใช่แค่ "มีกี่ชนิดให้เลือก"
const ROW_TEXT_OVERRIDE: Record<string, string> = {
  "ROTATEQ|6M": "วัคซีนโรต้า (ชนิด 5 สายพันธุ์ กรณีเคยรับชนิดนี้มาก่อน)",
  "FLU im|9M": "วัคซีนไข้หวัดใหญ่ (ถ้าไม่เคยรับ)",
  "FLU im|12M": "วัคซีนไข้หวัดใหญ่ (ถ้าไม่เคยรับ)",
};

async function fetchAgeGroupDoses(ageCodes: string[]): Promise<DoseRow[]> {
  const { data } = await admin
    .from("vaccine_doses")
    .select("age_group,vaccine_id,name_th_override,status,vaccines!inner(name_th,priority,status,group_code)")
    .in("age_group", ageCodes)
    .eq("status", "ACTIVE");
  return (data ?? []) as unknown as DoseRow[];
}

type AgeGroupBuckets = { routine: string[]; conditional: string[] };

/** ageMonths: อายุเดียว (2/4/6/.../48) ใช้ตัดสิน routine/conditional ของ "ไข้หวัดใหญ่" เท่านั้น —
 *  น้อยกว่า 2 ปี = ตามเกณฑ์อายุ (รัฐสนับสนุนฟรี/เทียบเท่าจำเป็นสำหรับกลุ่มเสี่ยงรุนแรง), 2 ปีขึ้นไป =
 *  พิจารณาตามเงื่อนไข (แล้วแต่ผู้ปกครองเลือก) — null สำหรับก้อนอายุกว้าง (เช่น "4-12 ปี") ถือเป็น
 *  เงื่อนไขเสมอ ยืนยันกับ Yai แล้ว (3 ก.ย. 2569) */
async function buildAgeGroupBuckets(ageCodes: string[], ageMonths: number | null): Promise<AgeGroupBuckets> {
  const rows = await fetchAgeGroupDoses(ageCodes);

  // dedupe by vaccine_id ก่อน — วัคซีนตัวเดียวอาจโผล่มาหลาย age_group เมื่อ ageCodes กว้าง (เช่น
  // ก้อน "4-12 ปี" รวมหลายอายุ) ไม่ควรนับซ้ำ
  const byVaccineId = new Map<string, DoseRow>();
  for (const row of rows) {
    if (row.vaccines.status !== "ACTIVE") continue;
    if (!byVaccineId.has(row.vaccine_id)) byVaccineId.set(row.vaccine_id, row);
  }

  const groupCounts = new Map<string, number>();
  for (const row of byVaccineId.values()) {
    const gc = row.vaccines.group_code;
    if (gc && GROUP_DISPLAY_NAME[gc]) groupCounts.set(gc, (groupCounts.get(gc) ?? 0) + 1);
  }

  type Item = { text: string; bucket: "routine" | "conditional"; groupCode: string | null };
  const items: Item[] = [];
  const mergedGroups = new Set<string>();
  for (const row of byVaccineId.values()) {
    const groupCode = row.vaccines.group_code;
    const baseName = row.name_th_override ?? row.vaccines.name_th;
    if (!baseName) continue;

    let bucket: "routine" | "conditional" = CONDITIONAL_PRIORITIES.has(row.vaccines.priority ?? "")
      ? "conditional"
      : "routine";
    if (groupCode === "INFLUENZA") bucket = ageMonths != null && ageMonths < 24 ? "routine" : "conditional";

    const overrideText = ROW_TEXT_OVERRIDE[`${row.vaccine_id}|${row.age_group}`];
    if (overrideText) {
      items.push({ text: overrideText, bucket, groupCode });
      continue;
    }
    if (groupCode && GROUP_DISPLAY_NAME[groupCode] && (groupCounts.get(groupCode) ?? 0) > 1) {
      if (mergedGroups.has(groupCode)) continue; // ยุบรวมแล้ว ไม่ต้องเพิ่มซ้ำ
      mergedGroups.add(groupCode);
      items.push({ text: GROUP_DISPLAY_NAME[groupCode] + groupSuffix(groupCode, groupCounts.get(groupCode)!), bucket, groupCode });
      continue;
    }
    items.push({ text: baseName, bucket, groupCode });
  }

  const seen = new Set<string>();
  const routine: string[] = [];
  const conditional: string[] = [];
  for (const it of items) {
    if (seen.has(it.text)) continue;
    seen.add(it.text);
    (it.bucket === "routine" ? routine : conditional).push(it.text);
  }
  return { routine, conditional };
}

// *** เพิ่ม 2026-09-03 ***: 3 ปี (36M) เป็นนัดตรวจพัฒนาการ ไม่ใช่นัดวัคซีนตามเกณฑ์บังคับ — Yai
// ยืนยันว่าตั้งใจแบบนี้ (ให้เด็กได้แวะคลินิกระหว่าง 2-4 ปี ไม่หายไปนาน + พอดีเป็นช่วงแนะนำวัคซีน
// สุกใสเข็ม 2) แสดงหัวข้อ "สำหรับทางคลินิก/นัดรับ" แทน "💉 ตามเกณฑ์อายุ" ปกติ เฉพาะอายุนี้อายุเดียว
const CLINIC_VISIT_HEADER = "📋 สำหรับทางคลินิก / นัดรับ";
const VARICELLA_BOOSTER_2_TEXT =
  "วัคซีนสุกใส กระตุ้นเข็มที่ 2 กรณีได้รับเข็มแรกมาแล้ว ให้สอบถามแพทย์ก่อนการรับ";

type RenderPlan = { clinicNote?: string; routine: string[]; conditional: string[] };

async function buildRenderPlan(ageCodes: string[], ageMonths: number | null): Promise<RenderPlan> {
  const { routine, conditional } = await buildAgeGroupBuckets(ageCodes, ageMonths);
  if (ageCodes.length === 1 && ageCodes[0] === "36M") {
    const idx = conditional.indexOf("วัคซีนสุกใส กระตุ้น");
    const rest = idx >= 0 ? [...conditional.slice(0, idx), ...conditional.slice(idx + 1)] : conditional;
    return { clinicNote: VARICELLA_BOOSTER_2_TEXT, routine: [], conditional: rest };
  }
  return { routine, conditional };
}

/** ageCodes match age_guide.age_code / vaccine_doses.age_group, e.g. ["24M"]
 *  for a single age or ["48M","51M","132M","138M"] for a broad "4-12 ปี" summary.
 *  ageMonths: single numeric age for the INFLUENZA age-rule above, or null for a
 *  wide bucket like "4-12 ปี". Plain-text version — used for Messenger (Flex
 *  Message is LINE-only) and as the LINE altText for buildAgeCardFlex() below. */
export async function buildAgeGroupVaccineList(
  ageCodes: string[],
  label: string,
  link: string,
  ageMonths: number | null = null,
): Promise<string> {
  const { clinicNote, routine, conditional } = await buildRenderPlan(ageCodes, ageMonths);

  if (!clinicNote && routine.length === 0 && conditional.length === 0) {
    return `👶 วัคซีนสำหรับเด็กอายุ ${label}\n\n` +
      `ยังไม่มีข้อมูลวัคซีนสำหรับช่วงอายุนี้ในระบบค่ะ กรุณาสอบถามเจ้าหน้าที่ หรือดูรายละเอียดเพิ่มเติมที่\n${link}`;
  }

  const sections = [`👶 วัคซีนสำหรับเด็กอายุ ${label}`];
  if (clinicNote) sections.push(`${CLINIC_VISIT_HEADER}\n• ${clinicNote}`);
  if (routine.length) sections.push("💉 วัคซีนตามเกณฑ์อายุ\n" + routine.map((t) => `• ${t}`).join("\n"));
  if (conditional.length) sections.push("🩺 วัคซีนที่พิจารณาตามเงื่อนไข\n" + conditional.map((t) => `• ${t}`).join("\n"));
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
  ageMonths: number | null = null,
): Promise<{ flex: Record<string, unknown>; altText: string }> {
  const { clinicNote, routine, conditional } = await buildRenderPlan(ageCodes, ageMonths);
  const altText = await buildAgeGroupVaccineList(ageCodes, label, link, ageMonths);

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
  if (!clinicNote && routine.length === 0 && conditional.length === 0) {
    body.push({
      type: "text",
      wrap: true,
      size: "sm",
      color: TEXT_MUTED,
      text: "ยังไม่มีข้อมูลวัคซีนสำหรับช่วงอายุนี้ในระบบค่ะ กรุณาสอบถามเจ้าหน้าที่",
    });
  } else {
    if (clinicNote) {
      body.push({ type: "text", text: CLINIC_VISIT_HEADER, weight: "bold", size: "sm", color: BRAND_GREEN_DARK, margin: body.length ? "lg" : "none" });
      body.push({ type: "box", layout: "vertical", spacing: "xs", margin: "sm", contents: [bulletRow(clinicNote, BRAND_GREEN_DARK)] });
    }
    if (routine.length) {
      body.push({ type: "text", text: "💉 วัคซีนตามเกณฑ์อายุ", weight: "bold", size: "sm", color: BRAND_GREEN_DARK, margin: body.length ? "lg" : "none" });
      body.push({ type: "box", layout: "vertical", spacing: "xs", margin: "sm",
        contents: routine.map((t) => bulletRow(t, BRAND_GREEN_DARK)) });
    }
    if (conditional.length) {
      body.push({ type: "text", text: "🩺 วัคซีนที่พิจารณาตามเงื่อนไข", weight: "bold", size: "sm", color: "#C2410C", margin: body.length ? "lg" : "none" });
      body.push({ type: "box", layout: "vertical", spacing: "xs", margin: "sm",
        contents: conditional.map((t) => bulletRow(t, "#C2410C")) });
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

