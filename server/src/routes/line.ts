import { Hono } from "hono";
import { env } from "../lib/env";
import { buildReplyMessages, buildMedicalQuestionAttachmentMessage } from "../services/reply";

export const line = new Hono();

// Verify LINE signature (x-line-signature = base64 HMAC-SHA256 of raw body).
async function verify(raw: string, sig: string | undefined): Promise<boolean> {
  if (!sig || !env.lineSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.lineSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === sig;
}

// *** แก้ 2026-08-30 ***: เดิมไม่เช็ค response.ok เลย — ถ้า LINE Reply API ปฏิเสธ request
// (เช่น replyToken หมดอายุ, token ผิด, rate limit) โค้ดจะไม่รู้เลยและไม่มี log ใดๆ ทั้งสิ้น
// ผู้ปกครองก็ไม่ได้คำตอบ แต่ log ก็ไม่มีร่องรอยให้ debug ย้อนหลังได้ — เพิ่ม log อย่างเดียว
// (ไม่ได้เพิ่ม retry เพราะ replyToken ใช้ได้ครั้งเดียวอยู่แล้ว ยิงซ้ำไม่ช่วยอะไร)
async function reply(replyToken: string, messages: unknown[]) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.lineToken}`,
    },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!res.ok) {
    console.error(`LINE reply API failed: HTTP ${res.status}`, await res.text().catch(() => ""));
  }
}

// Push-to-userId (as opposed to reply(), which only works within a webhook's
// reply-token window) — used by the stock alert job to message a specific
// staff LINE userId outside any incoming webhook event.
export async function pushMessage(userId: string, messages: unknown[]): Promise<boolean> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.lineToken}`,
    },
    body: JSON.stringify({ to: userId, messages: messages.slice(0, 5) }),
  });
  if (!res.ok) {
    console.error(`LINE push API failed: HTTP ${res.status}`, await res.text().catch(() => ""));
  }
  return res.ok;
}

line.post("/webhook/line", async (c) => {
  const raw = await c.req.text();
  if (!(await verify(raw, c.req.header("x-line-signature")))) {
    return c.text("Bad signature", 401);
  }
  const body = JSON.parse(raw) as { events?: any[] };
  await Promise.all(
    (body.events ?? [])
      .filter((e) => e.type === "message" && e.replyToken)
      .map(async (e) => {
        try {
          // *** เพิ่ม 2026-09-01 (bug 4, ยืนยันแล้ว 1 ก.ย.) ***: sticker เป็นคนละ message
          // type จาก image/video/ฯลฯ ใน LINE โดยตรง (e.message.type === "sticker") — มัก
          // ใช้ปิดท้ายสนทนา ("ขอบคุณ"/OK) ไม่ใช่ถามเรื่องสินค้า/อาการเหมือนรูปจริง จึงตอบ
          // emoji สั้นแทน (เหมือน END_CONVERSATION ใน reply.ts) ไม่ใช่ attachment message เต็ม
          if (e.message?.type === "sticker") {
            return await reply(e.replyToken, [{ type: "text", text: "🙏" }]);
          }
          // Non-text message events (image/video/audio/file/location) used to be
          // filtered out above and get zero reply — worst case: a parent sends a
          // photo of their sick child and hears nothing back at all.
          if (e.message?.type !== "text") {
            return await reply(e.replyToken, [{ type: "text", text: await buildMedicalQuestionAttachmentMessage() }]);
          }
          return await reply(e.replyToken, await buildReplyMessages(String(e.message.text), "line"));
        } catch (err) {
          // *** แก้ 2026-08-30 ***: ชั้นสุดท้ายจริงๆ — buildReplyMessages() มี try/catch
          // ของตัวเองแล้ว (ไม่ควร throw มาถึงตรงนี้ได้) แต่ครอบอีกชั้นด้วยข้อความ hardcode
          // ล้วนๆ (ไม่พึ่ง config()/Supabase เลยแม้แต่น้อย) เพื่อยืนยันว่า "ห้ามเงียบเด็ดขาด"
          // เป็นจริงไม่ว่าอะไรจะพังก่อนหน้านี้
          console.error("LINE webhook: unexpected error building/sending reply", err);
          await reply(e.replyToken, [
            { type: "text", text: "ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาโทรติดต่อคลินิกโดยตรงค่ะ ☎️ 085-065-9715" },
          ]);
        }
      }),
  );
  return c.text("OK");
});
