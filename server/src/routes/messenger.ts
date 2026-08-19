import { Hono } from "hono";
import { env } from "../lib/env";
import { buildReplyMessages, type TextMessage } from "../services/reply";

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

async function send(recipientId: string, msg: TextMessage) {
  const message: Record<string, unknown> = { text: msg.text };
  const quickReplies = toMessengerQuickReplies(
    (msg.quickReply as { items?: QuickReplyItem[] } | undefined)?.items,
  );
  if (quickReplies) message.quick_replies = quickReplies;

  await fetch(
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
}

messenger.post("/webhook/messenger", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.object !== "page") return c.text("EVENT_RECEIVED");

  const events = (body.entry ?? []).flatMap((e: any) => e.messaging ?? []);
  await Promise.all(
    events
      .filter((m: any) => m.message?.text && m.sender?.id)
      .map(async (m: any) => {
        const msgs = await buildReplyMessages(String(m.message.text));
        for (const msg of msgs) await send(m.sender.id, msg);
      }),
  );
  return c.text("EVENT_RECEIVED");
});
