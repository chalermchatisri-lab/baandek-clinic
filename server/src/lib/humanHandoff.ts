// *** เพิ่ม 2026-09-29 (round 4, human-handoff backlog — 2nd real incident, escalated) ***:
// state สั้นๆ ต่อ conversation (in-memory, ไม่ persist) เพื่อจำว่าเจ้าหน้าที่กำลัง manual-reply
// อยู่ผ่าน Facebook Page Inbox/Business Suite ตอนนี้ — เมื่อเป็นจริง บอทต้อง "เงียบสนิท" ทั้งหมด
// ไม่ใช่แค่เปลี่ยนคำตอบ (เคสจริง round 3 ภาพ 1: เจ้าหน้าที่ขอเบอร์ติดต่อกลับเอง ลูกค้าตอบเบอร์มา
// บอท auto-fire ทับ / round 4 ภาพ 10: เจ้าหน้าที่พิมพ์ "รับทราบแล้ว ไม่ต้องตอบอีก" บอทก็ยังตอบอยู่ดี)
//
// วิธีตรวจจับ: Facebook message_echoes webhook field (ต้องเปิดใน Meta App Dashboard เอง — นอก
// เหนือ repo นี้) ส่ง event รูปแบบเดียวกับข้อความลูกค้าทุกครั้งที่ "เพจ" ส่งข้อความออกไป ไม่ว่าจะ
// ส่งผ่าน Send API (บอทเราเอง) หรือเจ้าหน้าที่พิมพ์เองใน Page Inbox — message.is_echo === true
// ในทั้งสองกรณี แต่ message.app_id จะมีค่าเฉพาะตอนส่งผ่าน Send API เท่านั้น (เอกสาร Meta) —
// เจ้าหน้าที่พิมพ์เองผ่าน Inbox จะไม่มี app_id เลย ใช้จุดนี้แยกว่า "บอทเราส่งเอง" (ไม่ต้องทำอะไร)
// vs "เจ้าหน้าที่พิมพ์เอง" (ต้อง mute)
//
// ทางเลือกออกแบบที่พิจารณา (เหมือน symptomContext.ts): Supabase table ถูกต้องกว่าถ้า deploy
// หลาย instance/restart บ่อย แต่เกินความจำเป็นสำหรับ MVP (Render เดียว) — เลือก in-memory Map
// ต่อ process เหมือนเดิม ถ้าพบว่า TTL หายบ่อยเกินไปจาก redeploy ค่อยย้ายไป Supabase ทีหลัง
const HUMAN_HANDOFF_TTL_MS = 30 * 60 * 1000; // 30 นาที — นานพอสำหรับบทสนทนาที่เจ้าหน้าที่คุยเอง
// แต่ยังกู้คืนอัตโนมัติได้ถ้าเจ้าหน้าที่ลืมส่งคืนบอท (ไม่มีปุ่ม "คืนควบคุมให้บอท" ใน MVP นี้)

const store = new Map<string, number>(); // key -> expiresAt (epoch ms)

function keyOf(channel: string, userId: string): string {
  return `${channel}:${userId}`;
}

/** เรียกทุกครั้งที่เจอ echo event ที่ไม่มี app_id (เจ้าหน้าที่พิมพ์เองผ่าน Page Inbox) —
 *  รีเซ็ต TTL ให้ยาวออกไปอีก 30 นาทีเสมอ (ข้อความไหนก็ได้จากเจ้าหน้าที่ นับเป็นสัญญาณ "ยังคุยอยู่") */
export function markHumanHandling(channel: string, userId: string): void {
  store.set(keyOf(channel, userId), Date.now() + HUMAN_HANDOFF_TTL_MS);
}

/** true ถ้าเจ้าหน้าที่เพิ่งคุยกับ conversation นี้เองเมื่อครู่ (ยังไม่หมดอายุ) — เรียกก่อนเรียก
 *  buildReplyMessages() เสมอ ถ้า true ต้องไม่ส่งอะไรกลับเลย (เงียบสนิท ไม่ใช่แค่เปลี่ยนคำตอบ) */
export function isHumanHandling(channel: string, userId: string): boolean {
  const k = keyOf(channel, userId);
  const expiresAt = store.get(k);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    store.delete(k);
    return false;
  }
  return true;
}
