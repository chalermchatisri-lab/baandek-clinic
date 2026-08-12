import { Hono } from "hono";
import { env } from "../lib/env";
import { buildReplyMessages } from "../services/reply";

export const messenger = new Hono();

// FB webhook verification handshake
messenger.get("/webhook/messenger", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === env.fbVerifyToken) return c.text(challenge ?? "");
  return c.text("Invalid verify token", 403);
});

async function send(recipientId: string, text: string) {
  await fetch(
    `https://graph.facebook.com/v20.0/me/messages?access_token=${env.fbPageToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
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
        // Messenger = plain text; send each text bubble in order.
        for (const msg of msgs) await send(m.sender.id, msg.text);
      }),
  );
  return c.text("EVENT_RECEIVED");
});
