import { admin } from "../lib/supabase";

export type AlertLevel = "green" | "yellow" | "red";

export interface StockItem {
  id: string;
  name: string;
  category: string;
  unit: string | null;
  qtyOnHand: number;
  minThreshold: number;
  level: AlertLevel;
}

// 🔴 out of stock or at/below half the reorder point; 🟡 at/below the reorder
// point (but above half); 🟢 otherwise. Computed on read, never stored, so it
// can never go stale relative to qty_on_hand/min_threshold.
export function computeAlertLevel(qty: number, threshold: number): AlertLevel {
  if (qty <= 0 || qty <= threshold * 0.5) return "red";
  if (qty <= threshold) return "yellow";
  return "green";
}

export async function getActiveStockItems(): Promise<StockItem[]> {
  const { data, error } = await admin
    .from("stock_items")
    .select("id,name,category,unit,qty_on_hand,min_threshold")
    .eq("active", true)
    .order("category", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    unit: r.unit,
    qtyOnHand: r.qty_on_hand,
    minThreshold: r.min_threshold,
    level: computeAlertLevel(r.qty_on_hand, r.min_threshold),
  }));
}

const MAX_LISTED_PER_LEVEL = 25;

function formatLine(item: StockItem): string {
  const unit = item.unit ?? "";
  return `• ${item.name} — เหลือ ${item.qtyOnHand} ${unit} (ขั้นต่ำ ${item.minThreshold})`.trim();
}

function formatSection(title: string, items: StockItem[]): string {
  const shown = items.slice(0, MAX_LISTED_PER_LEVEL).map(formatLine);
  const extra = items.length - shown.length;
  if (extra > 0) shown.push(`… และอีก ${extra} รายการ`);
  return `${title}\n${shown.join("\n")}`;
}

/** Red items first, then yellow — per spec. Returns null when there's nothing
 *  to alert on (all green), so the caller knows not to send anything. */
export function buildStockAlertMessage(items: StockItem[]): string | null {
  const red = items.filter((i) => i.level === "red");
  const yellow = items.filter((i) => i.level === "yellow");
  if (red.length === 0 && yellow.length === 0) return null;

  const sections = ["📦 แจ้งเตือนสต็อกสินค้า — บ้านเด็กคลินิก"];
  if (red.length) sections.push(formatSection("🔴 หมด/ใกล้หมดมาก (สั่งด่วน)", red));
  if (yellow.length) sections.push(formatSection("🟡 ใกล้ถึงจุดสั่งซื้อ", yellow));
  sections.push("ดูรายละเอียด/แก้ไขได้ที่ Dashboard: https://vaccine-cbc-web.vercel.app");
  return sections.join("\n\n");
}

// ============================================================================
// Customer-facing PRODUCT_STOCK_INQUIRY matching (chunk 2)
// ============================================================================
// Priority order per spec: milk first (asked most often), then these 7 named
// vaccines (asked most often via FB Messenger). "hints" are plain search terms
// against the REAL product names already in stock_items (checked against live
// data 2026-08-31 — see e.g. "INFLUENZA VACCINE  -Vaccine", "Qdenga",
// "Clesrovimab (Enflonsia)", "speeda -Vaccine") — not a new taxonomy, just
// substrings to find the right real rows. Every group is handled by the exact
// same lookup+format code below; no group gets special-cased.
const PRIORITY_VACCINE_GROUPS: { label: string; hints: string[] }[] = [
  { label: "ไข้หวัดใหญ่", hints: ["influenza", "flu", "flumist", "ไข้หวัดใหญ่"] },
  { label: "ไอพีดี (ปอดบวม)", hints: ["pcv", "prevnar", "synflorix", "weuphoria", "ไอพีดี", "ปอดบวม"] },
  { label: "RSV", hints: ["rsv", "enflonsia", "nirsevimab", "clesrovimab", "beyfortus"] },
  { label: "พิษสุนัขบ้า", hints: ["speeda", "rabies", "verorab", "พิษสุนัขบ้า"] },
  { label: "EV71 (มือเท้าปาก)", hints: ["entrovac", "ev71", "มือเท้าปาก"] },
  { label: "HPV", hints: ["gardasil", "hpv"] },
  { label: "ไข้เลือดออก", hints: ["qdenga", "dengue", "ไข้เลือดออก"] },
];

function cleanName(name: string): string {
  return name.toLowerCase().replace(/\s*-\s*vaccine\s*$/i, "").trim();
}

/** A customer naming a specific product ("มีนม Enfalac ไหม") — matched against
 *  real stock_items names (data-driven, not a hardcoded product list): either
 *  the item's cleaned name appears in the message, or the item's first
 *  word/brand token (≥4 chars, to avoid noisy short-word false positives) does. */
export async function findSpecificStockMatches(text: string): Promise<StockItem[]> {
  const t = text.toLowerCase();
  const items = await getActiveStockItems();
  return items
    .filter((i) => {
      const key = cleanName(i.name);
      if (!key) return false;
      if (t.includes(key)) return true;
      const firstWord = key.split(/\s+/)[0] ?? "";
      return firstWord.length >= 4 && t.includes(firstWord);
    })
    .slice(0, 5);
}

export interface StockSection { label: string; items: StockItem[] }

/** No specific product named — the generic "มีนมไหม"/"มียาไหม" phrasing that
 *  KW.productStock actually catches. Milk first, then the 7 priority vaccine
 *  groups above (only sections that have at least one matching row are kept). */
export async function getPriorityStockOverview(): Promise<StockSection[]> {
  const items = await getActiveStockItems();
  const sections: StockSection[] = [{ label: "นม", items: items.filter((i) => i.category === "นม") }];
  for (const group of PRIORITY_VACCINE_GROUPS) {
    const matched = items.filter(
      (i) => i.category === "วัคซีน" && group.hints.some((h) => cleanName(i.name).includes(h)),
    );
    if (matched.length) sections.push({ label: group.label, items: matched });
  }
  return sections.filter((s) => s.items.length > 0);
}

// Customer-facing status wording deliberately omits raw quantities (an
// internal restocking detail, not something to tell a parent) — unlike
// buildStockAlertMessage() above, which is for Kallaya/admin use only.
const CUSTOMER_STATUS: Record<AlertLevel, string> = {
  green: "🟢 มีพร้อมให้บริการค่ะ",
  yellow: "🟡 เหลือจำนวนจำกัด แนะนำติดต่อล่วงหน้าค่ะ",
  red: "🔴 หมดชั่วคราวค่ะ ขออภัยนะคะ",
};

function customerLine(item: StockItem): string {
  return `• ${item.name}: ${CUSTOMER_STATUS[item.level]}`;
}

const MAX_ITEMS_PER_SECTION = 8;

function formatCustomerSection(section: StockSection): string {
  const shown = section.items.slice(0, MAX_ITEMS_PER_SECTION).map(customerLine);
  const extra = section.items.length - shown.length;
  if (extra > 0) shown.push(`… และอีก ${extra} รายการ`);
  return `${section.label}\n${shown.join("\n")}`;
}

/** Specific product(s) named and matched. */
export function buildSpecificStockReply(matches: StockItem[]): string {
  const lines = matches.map(customerLine).join("\n");
  return `สอบถามเรื่องสต็อกสินค้านะคะ 🙏\n\n${lines}`;
}

/** No specific product matched — the priority overview (milk, then the 7
 *  named vaccines). Never empty in practice (stock_items always has milk/
 *  vaccine rows), but guards the edge case anyway. */
export function buildOverviewStockReply(sections: StockSection[]): string {
  if (sections.length === 0) {
    return "ขอบคุณที่สอบถามนะคะ 🙏 ตอนนี้ยังไม่มีข้อมูลสต็อกในระบบค่ะ กรุณาสอบถามเจ้าหน้าที่โดยตรงนะคะ";
  }
  const body = sections.map(formatCustomerSection).join("\n\n");
  return `สอบถามเรื่องสต็อกสินค้า (นม/วัคซีน) ที่ลูกค้าถามบ่อยค่ะ 🙏\n\n${body}`;
}
