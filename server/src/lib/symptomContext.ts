// *** เพิ่ม 2026-09-06 (round 2, issue 1) ***: state สั้นๆ ต่อผู้ใช้ (in-memory, ไม่ persist)
// เพื่อจำว่าเพิ่งถามเรื่องอาการ/การรักษาไปเมื่อครู่ — ระบบเดิม "ไม่มี" session state จริงจัง
// สำหรับ conversation context เลย (ดูคอมเมนต์ที่ looksLikePhoneAttempt() ใน reply.ts —
// "เช็คนัดหมาย" เป็น stateless design ตั้งใจ ไม่ใช่ pattern ที่เอามาต่อยอดตรงๆ ได้)
//
// ปัญหา: ลูกค้าถาม/ส่งรูปอาการ (MEDICAL_QUESTION) แล้วถามต่อด้วยประโยค follow-up ที่ไม่มี
// keyword อาการเหลืออยู่เลย (เช่น "สอบถามการรักษาเบื้องต้นหน่อยค่ะ" — คำว่า "สอบถาม" โดน
// intent เมนูทั่วไปจับไปก่อนคำว่า "การรักษา") detectIntent() ตีความทีละข้อความ ไม่มีทาง
// รู้ว่าอยู่ในบริบทอาการต่อเนื่องมาก่อนถ้าไม่มี state คั่นกลาง
//
// ทางเลือกออกแบบที่พิจารณา: (1) เก็บใน Supabase table ใหม่ — ถูกต้องกว่าถ้า deploy หลาย
// instance/restart บ่อย แต่เกินความจำเป็นสำหรับ MVP (Render เดียว, TTL สั้นแค่ไม่กี่นาที
// ข้อมูลหายตอน redeploy ไม่กระทบอะไรมาก) (2) in-memory Map ต่อ process — เลือกอันนี้ ตรงกับ
// Iron Rule "MVP first" ถ้าพบว่า TTL หายบ่อยเกินไปจาก redeploy ค่อยย้ายไป Supabase/Redis ทีหลัง
const SYMPTOM_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 นาที — พอสำหรับ follow-up ทันทีหลังคำถามอาการ

const store = new Map<string, number>(); // key -> expiresAt (epoch ms)

function keyOf(channel: string, userId: string): string {
  return `${channel}:${userId}`;
}

/** เรียกทุกครั้งที่ intent ปัจจุบันคือ MEDICAL_QUESTION — รีเซ็ต TTL ให้ยาวออกไปอีก 5 นาที */
export function markSymptomContext(channel: string, userId: string): void {
  store.set(keyOf(channel, userId), Date.now() + SYMPTOM_CONTEXT_TTL_MS);
}

/** true ถ้าผู้ใช้คนนี้เพิ่งอยู่ในบริบทอาการ/การรักษาเมื่อครู่ (ยังไม่หมดอายุ) */
export function hasSymptomContext(channel: string, userId: string): boolean {
  const k = keyOf(channel, userId);
  const expiresAt = store.get(k);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    store.delete(k);
    return false;
  }
  return true;
}

/** เรียกเมื่อ intent อื่นที่ชัดเจน (ไม่ใช่ MEDICAL_QUESTION/UNKNOWN) ถูกจับได้ — ถือว่าลูกค้า
 *  เปลี่ยนเรื่องคุยแล้ว เคลียร์ context ทิ้งกันไม่ให้ค้างไปปนกับคำถามคนละเรื่องในอนาคต */
export function clearSymptomContext(channel: string, userId: string): void {
  store.delete(keyOf(channel, userId));
}
