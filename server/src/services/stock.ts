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
