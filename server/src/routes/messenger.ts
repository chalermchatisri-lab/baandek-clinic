import { Hono } from "hono";
import { env } from "../lib/env";
import { buildReplyMessages, buildMedicalQuestionAttachmentMessage, type ReplyMessage } from "../services/reply";

export const messenger = new Hono();

// FB webhook verification handshake
messenger.get("/webhook/messenger", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === env.fbVerifyToken) return c.text(challenge ?? "");
  return c.text("Invalid verify token", 403);
});

type QuickReplyItem = { type: string; action: { type: string; label: string; text?: string; uri?: string } };

// Converts our shared LINE-style quickReply into Messenger's quick_replies format.
// Only "message" actions translate cleanly (tap -> sends that text back, same as LINE).
// "uri" actions here point at the LIFF booking page, which only authenticates
// inside the LINE app — opened from Messenger it just shows "เปิดหน้านี้ผ่านแอป LINE ค่ะ".
// So uri buttons are intentionally dropped until a channel-agnostic Landing Page
// exists for booking. This fixes "เช็คนัดหมาย" etc. now; booking on Messenger is
// a separate follow-up (Landing Page), not something this patch can shortcut.
function toMessengerQuickReplies(items?: QuickReplyItem[]) {
  const usable = (items ?? []).filter((it) => it.action?.type === "message" && it.action.text);
  if (!usable.length) return undefined;
  return usable.map((it) => ({
    content_type: "text" as const,
    title: it.action.label.slice(0, 20),
    payload: it.action.text,
  }));
}

// *** แก้ 2026-08-30 ***: เดิมไม่เช็ค response.ok เลย — ถ้า Graph API ปฏิเสธ request
// (page token หมดอายุ, ผู้ใช้ปิดกั้นบอท, เกิน 24h messaging window ฯลฯ) โค้ดจะไม่รู้เลย
// และไม่มี log ใดๆ ทั้งสิ้น เพิ่ม log เพื่อให้ debug เคส "เงียบ" แบบนี้ย้อนหลังได้
// *** เพิ่ม 2026-09-03 ***: buildReplyMessages() คืนค่าเป็น ReplyMessage (text | flex)
// ตั้งแต่เพิ่มการ์ดวัคซีนแบบ Flex ให้ LINE — reply.ts การันตีว่า Messenger (channel ===
// "messenger") จะไม่ได้ flex กลับมาเลย (Flex เป็นฟอร์แมต LINE เท่านั้น) แต่กันไว้อีกชั้น
// เผื่อพลาด: ถ้าเจอ flex หลุดมาจริงๆ ส่ง altText แทนข้อความเปล่า ดีกว่าเงียบสนิท
async function send(recipientId: string, msg: ReplyMessage) {
  const text = msg.type === "flex" ? msg.altText : msg.text;
  const message: Record<string, unknown> = { text };
  const quickReplies = toMessengerQuickReplies(
    (msg.quickReply as { items?: QuickReplyItem[] } | undefined)?.items,
  );
  if (quickReplies) message.quick_replies = quickReplies;

  const res = await fetch(
    `https://graph.facebook.com/v20.0/me/messages?access_token=${env.fbPageToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message,
      }),
    },
  );
  if (!res.ok) {
    console.error(`Messenger send API failed: HTTP ${res.status}`, await res.text().catch(() => ""));
  }
}

messenger.post("/webhook/messenger", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.object !== "page") return c.text("EVENT_RECEIVED");

  const events = (body.entry ?? []).flatMap((e: any) => e.messaging ?? []);
  await Promise.all(
    events
      .filter((m: any) => m.sender?.id && (m.message?.text || m.message?.attachments))
      .map(async (m: any) => {
        try {
          // *** เพิ่ม 2026-09-01 (bug 4, ยืนยันแล้ว 1 ก.ย.) ***: Messenger ไม่มี attachment
          // type "sticker" แยกจริงๆ เหมือน LINE — sticker (รวมปุ่ม thumbs-up มาตรฐาน) ส่งมา
          // เป็น type "image" ที่มี payload.sticker_id แนบมาด้วยเสมอ ต่างจากรูปถ่ายจริงที่ไม่มี
          // ฟิลด์นี้ — เช็คก่อนเพื่อตอบ emoji สั้นแทน attachment message เต็ม (เหมือนฝั่ง LINE)
          const isSticker = (m.message?.attachments ?? []).some((a: any) => a?.payload?.sticker_id);
          if (isSticker) {
            return await send(m.sender.id, { type: "text", text: "🙏" });
          }
          // Attachments (image/video/etc., e.g. a parent sending a photo of their
          // sick child) used to be silently dropped here — no reply at all.
          if (!m.message?.text) {
            return await send(m.sender.id, { type: "text", text: await buildMedicalQuestionAttachmentMessage() });
          }
          // A quick-reply tap echoes back message.text = the button's *title* (the
          // visible label, e.g. "6 เดือน") — Messenger's actual payload is a separate
          // message.quick_reply.payload field the webhook has to read explicitly, unlike
          // LINE where the message action's "text" IS what gets sent on tap. Every quick
          // reply built in reply.ts sets title=label, payload=the real intended text
          // (toMessengerQuickReplies in this file), so read payload first when present.
          const inputText = m.message.quick_reply?.payload ?? m.message.text;
          const msgs = await buildReplyMessages(String(inputText), "messenger");
          for (const msg of msgs) await send(m.sender.id, msg);
        } catch (err) {
          // *** แก้ 2026-08-30 ***: ชั้นสุดท้ายจริงๆ — buildReplyMessages() มี try/catch
          // ของตัวเองแล้ว (ไม่ควร throw มาถึงตรงนี้ได้) แต่ครอบอีกชั้นด้วยข้อความ hardcode
          // ล้วนๆ (ไม่พึ่ง config()/Supabase เลยแม้แต่น้อย) — สาเหตุเดิมของเคส "ลูกไข้ 38
          // องศาทำให้ดี" ที่เงียบสนิทบน Messenger คือ resolveVaccineGroup() ใน intent.ts
          // ไม่มี try/catch ล้อม Supabase call มาก่อน (แก้แล้ว) แต่ชั้นนี้กันไว้เผื่อจุดอื่น
          // ที่ยังไม่รู้ตัวในอนาคตด้วย ยืนยันว่า "ห้ามเงียบเด็ดขาด" เป็นจริงเสมอ
          console.error("Messenger webhook: unexpected error building/sending reply", err);
          await send(m.sender.id, {
            type: "text",
            text: "ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาโทรติดต่อคลินิกโดยตรงค่ะ ☎️ 085-065-9715",
          });
        }
      }),
  );
  return c.text("EVENT_RECEIVED");
});
