// Declarative config — every editor form/table is generated from this.
// To expose a new table or column, add it here (no new components needed).

export type FieldType = "text" | "textarea" | "number" | "boolean" | "date" | "select";

export interface Column {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];       // for select
  required?: boolean;
  help?: string;            // shown under the field
  min?: number;             // for number
  step?: number;
  listShow?: boolean;       // show in the list table (keep lists scannable)
}

export interface TableConfig {
  name: string;             // db table
  label: string;            // menu label (Thai)
  group: string;            // sidebar group
  pk: string;               // primary key column
  pkGenerated?: boolean;    // true = uuid auto (hide on create); false = user enters
  orderBy?: { col: string; asc: boolean };
  intro?: string;           // one-line description at top of the page
  columns: Column[];
}

const STATUS = ["ACTIVE", "INACTIVE"];
const GROUPS = [
  "PCV", "RSV", "INFLUENZA", "MENINGOCOCCAL", "ENTEROVAC", "HEPATITIS_B", "RABIES",
  "ROTAVIRUS", "MMR", "HPV", "DTP_POLIO_COMBO", "JE", "DENGUE", "HEPATITIS_A", "VARICELLA",
];

export const TABLES: TableConfig[] = [
  // ============================ บอทวัคซีน ============================
  {
    name: "vaccine_rules",
    label: "กฎการแนะนำวัคซีน",
    group: "บอทวัคซีน",
    pk: "rule_id",
    pkGenerated: false,
    orderBy: { col: "sort_order", asc: true },
    intro: "บอทตอบตามกฎมาตรฐานในตารางนี้เท่านั้น — อายุที่ไม่มีกฎครอบคลุมจะส่งต่อให้ปรึกษาแพทย์",
    columns: [
      { key: "rule_id", label: "รหัสกฎ (Rule ID)", type: "text", required: true, help: "รหัสไม่ซ้ำ เช่น PCV_2M_PRIMARY", listShow: true },
      { key: "vaccine_group", label: "กลุ่มวัคซีน", type: "select", options: GROUPS, required: true, listShow: true },
      { key: "product_code", label: "รหัสสินค้า (ถ้าเจาะจง)", type: "text", help: "เว้นว่างได้ถ้าใช้ราคาระดับกลุ่ม เช่น PCV13/15/20" },
      { key: "min_age_months", label: "อายุต่ำสุด (เดือน)", type: "number", min: 0, step: 0.5, required: true, help: "เข็มแรกมาตรฐาน เช่น 2 = 2 เดือน", listShow: true },
      { key: "max_age_months", label: "อายุสูงสุด (เดือน)", type: "number", min: 0, step: 0.5, help: "เว้นว่าง = ไม่จำกัดปลายทาง", listShow: true },
      { key: "primary_doses", label: "จำนวนเข็มหลัก", type: "number", min: 1, step: 1, required: true, help: "เช่น 2 เข็ม (2 เดือน / 4 เดือน)" },
      { key: "interval_days", label: "ระยะห่างระหว่างเข็ม (วัน)", type: "number", min: 0, step: 1, help: "เช่น 60 = ห่างกัน 2 เดือน" },
      { key: "booster_rule", label: "กฎเข็มกระตุ้น", type: "text" },
      { key: "eligibility", label: "เงื่อนไขผู้รับ", type: "text" },
      { key: "requires_history", label: "ต้องดูประวัติก่อน", type: "boolean", help: "ถ้าเปิด บอทจะเน้นให้ปรึกษาแพทย์" },
      { key: "doctor_review", label: "หมายเหตุถึงแพทย์", type: "textarea" },
      { key: "display_message", label: "ข้อความที่บอทตอบ", type: "textarea", required: true, help: "ข้อความที่ลูกค้าเห็นเมื่อกฎนี้ถูกเลือก" },
      { key: "scenario_code", label: "รหัสสถานการณ์", type: "text" },
      { key: "sort_order", label: "ลำดับ", type: "number", min: 0, step: 1 },
      { key: "status", label: "สถานะ", type: "select", options: STATUS, required: true, listShow: true },
    ],
  },
  {
    name: "vaccines",
    label: "รายการวัคซีน & ราคา",
    group: "บอทวัคซีน",
    pk: "vaccine_id",
    pkGenerated: false,
    orderBy: { col: "display_order", asc: true },
    intro: "แคตตาล็อกวัคซีนและราคา — ใช้ตอบราคาและแสดงบนหน้าเว็บ",
    columns: [
      { key: "vaccine_id", label: "รหัสวัคซีน", type: "text", required: true, listShow: true },
      { key: "name_th", label: "ชื่อ (ไทย)", type: "text", listShow: true },
      { key: "name", label: "ชื่อ (อังกฤษ)", type: "text" },
      { key: "group_code", label: "กลุ่ม", type: "select", options: GROUPS, listShow: true },
      { key: "product_code", label: "รหัสสินค้า", type: "text" },
      { key: "price", label: "ราคา (บาท)", type: "number", min: 0, step: 1, listShow: true },
      { key: "category", label: "หมวด", type: "text" },
      { key: "age_group", label: "ช่วงอายุ", type: "text" },
      { key: "description", label: "รายละเอียด", type: "textarea" },
      { key: "display_order", label: "ลำดับ", type: "number", min: 0, step: 1 },
      { key: "status", label: "สถานะ", type: "select", options: STATUS, listShow: true },
    ],
  },

  // ============================ หน้าเว็บคลินิก ============================
  {
    name: "team",
    label: "ทีมแพทย์",
    group: "หน้าเว็บคลินิก",
    pk: "id",
    pkGenerated: true,
    orderBy: { col: "display_order", asc: true },
    intro: "แสดงบนหน้า landing page ส่วนทีมแพทย์",
    columns: [
      { key: "name", label: "ชื่อ", type: "text", required: true, listShow: true },
      { key: "role", label: "ตำแหน่ง", type: "text", listShow: true },
      { key: "credentials", label: "วุฒิ/ความเชี่ยวชาญ", type: "textarea" },
      { key: "photo_url", label: "ลิงก์รูป", type: "text" },
      { key: "display_order", label: "ลำดับ", type: "number", min: 0, step: 1 },
      { key: "active", label: "แสดงผล", type: "boolean", listShow: true },
    ],
  },
  {
    name: "services",
    label: "บริการ",
    group: "หน้าเว็บคลินิก",
    pk: "id",
    pkGenerated: true,
    orderBy: { col: "display_order", asc: true },
    columns: [
      { key: "title", label: "หัวข้อ", type: "text", required: true, listShow: true },
      { key: "description", label: "รายละเอียด", type: "textarea" },
      { key: "icon", label: "ไอคอน (emoji)", type: "text", listShow: true },
      { key: "display_order", label: "ลำดับ", type: "number", min: 0, step: 1 },
      { key: "active", label: "แสดงผล", type: "boolean", listShow: true },
    ],
  },
  {
    name: "promotions",
    label: "โปรโมชัน",
    group: "หน้าเว็บคลินิก",
    pk: "id",
    pkGenerated: true,
    orderBy: { col: "start_date", asc: false },
    columns: [
      { key: "title", label: "ชื่อโปร", type: "text", required: true, listShow: true },
      { key: "description", label: "รายละเอียด", type: "textarea" },
      { key: "vaccine_group", label: "กลุ่มวัคซีน", type: "select", options: GROUPS },
      { key: "discount", label: "ส่วนลด", type: "text", listShow: true },
      { key: "condition", label: "เงื่อนไข", type: "text" },
      { key: "image_url", label: "ลิงก์รูป", type: "text" },
      { key: "start_date", label: "เริ่ม", type: "date", listShow: true },
      { key: "end_date", label: "สิ้นสุด", type: "date", listShow: true },
      { key: "display_period", label: "ช่วงแสดง", type: "text" },
      { key: "active", label: "เปิดใช้", type: "boolean", listShow: true },
    ],
  },
  {
    name: "reviews",
    label: "รีวิว",
    group: "หน้าเว็บคลินิก",
    pk: "id",
    pkGenerated: true,
    columns: [
      { key: "reviewer_name", label: "ชื่อผู้รีวิว", type: "text", listShow: true },
      { key: "source", label: "แหล่ง", type: "text", listShow: true },
      { key: "rating", label: "ดาว (1-5)", type: "number", min: 1, step: 1, listShow: true },
      { key: "text", label: "ข้อความ", type: "textarea" },
      { key: "screenshot_url", label: "ลิงก์ภาพ", type: "text" },
      { key: "permission_confirmed", label: "ได้รับอนุญาตแล้ว", type: "boolean", help: "ยืนยันว่าได้ขออนุญาตเจ้าของรีวิวก่อนเผยแพร่", listShow: true },
    ],
  },
  {
    name: "articles",
    label: "บทความ",
    group: "หน้าเว็บคลินิก",
    pk: "id",
    pkGenerated: true,
    orderBy: { col: "display_order", asc: true },
    columns: [
      { key: "title", label: "หัวข้อ", type: "text", required: true, listShow: true },
      { key: "category", label: "หมวด", type: "text", listShow: true },
      { key: "cover_image_url", label: "ภาพปก", type: "text" },
      { key: "body_content", label: "เนื้อหา", type: "textarea" },
      { key: "display_order", label: "ลำดับ", type: "number", min: 0, step: 1 },
      { key: "published", label: "เผยแพร่", type: "boolean", listShow: true },
    ],
  },

  // ============================ เวลา & ตั้งค่า ============================
  {
    name: "clinic_hours",
    label: "เวลาทำการ",
    group: "เวลา & ตั้งค่า",
    pk: "id",
    pkGenerated: true,
    orderBy: { col: "session", asc: true },
    columns: [
      { key: "day", label: "วัน", type: "select", options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"], required: true, listShow: true },
      { key: "session", label: "ช่วง (1=เช้า 2=บ่าย)", type: "number", min: 1, step: 1, listShow: true },
      { key: "open_time", label: "เปิด", type: "text", help: "เช่น 9:00", listShow: true },
      { key: "close_time", label: "ปิด", type: "text", help: "เช่น 12:00", listShow: true },
      { key: "status", label: "สถานะ", type: "select", options: ["OPEN", "CLOSED"], listShow: true },
    ],
  },
  {
    name: "closures",
    label: "วันหยุด/ปิดพิเศษ",
    group: "เวลา & ตั้งค่า",
    pk: "id",
    pkGenerated: true,
    orderBy: { col: "start_date", asc: false },
    columns: [
      { key: "start_date", label: "เริ่มปิด", type: "date", required: true, listShow: true },
      { key: "end_date", label: "ถึงวันที่", type: "date", required: true, listShow: true },
      { key: "reason", label: "เหตุผล", type: "text", listShow: true },
      { key: "message", label: "ข้อความแจ้งลูกค้า", type: "textarea" },
      { key: "closure_type", label: "ประเภท", type: "select", options: ["CLOSE_ALL", "CLOSE_PERIOD"], help: "CLOSE_ALL=ปิดทั้งวัน, CLOSE_PERIOD=ปิดบางช่วง" },
      { key: "period_code", label: "ช่วงที่ปิด", type: "select", options: ["ALL", "WD_AM", "WD_PM"], help: "WD_AM=ปิดเช้า, WD_PM=ปิดบ่าย" },
      { key: "priority", label: "ลำดับความสำคัญ", type: "number", min: 1, step: 1 },
      { key: "active", label: "เปิดใช้", type: "boolean", listShow: true },
    ],
  },
  {
    name: "clinic_config",
    label: "ข้อมูลคลินิก/ตั้งค่า",
    group: "เวลา & ตั้งค่า",
    pk: "key",
    pkGenerated: false,
    intro: "ที่อยู่ เบอร์ ลิงก์ ชื่อบอท ฯลฯ ที่บอทและหน้าเว็บดึงไปใช้",
    columns: [
      { key: "key", label: "คีย์", type: "text", required: true, listShow: true },
      { key: "value", label: "ค่า", type: "textarea", required: true, listShow: true },
      { key: "category", label: "หมวด", type: "text", listShow: true },
    ],
  },
  {
    name: "faq",
    label: "คำถามที่พบบ่อย",
    group: "เวลา & ตั้งค่า",
    pk: "id",
    pkGenerated: true,
    columns: [
      { key: "keyword", label: "คีย์เวิร์ด", type: "text", required: true, listShow: true },
      { key: "answer", label: "คำตอบ", type: "textarea", required: true, listShow: true },
      { key: "category", label: "หมวด", type: "text", listShow: true },
    ],
  },
  {
    name: "vaccine_news",
    label: "ข่าววัคซีน",
    group: "เวลา & ตั้งค่า",
    pk: "id",
    pkGenerated: true,
    columns: [
      { key: "vaccine_name", label: "ชื่อวัคซีน/หัวข้อ", type: "text", required: true, listShow: true },
      { key: "description", label: "รายละเอียด", type: "textarea" },
      { key: "start_date", label: "เริ่ม", type: "text", listShow: true },
      { key: "end_date", label: "สิ้นสุด", type: "text" },
      { key: "status", label: "แสดงผล", type: "boolean", listShow: true },
    ],
  },
];

export const GROUP_ORDER = ["บอทวัคซีน", "หน้าเว็บคลินิก", "เวลา & ตั้งค่า"];
