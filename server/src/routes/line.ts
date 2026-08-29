import { Hono } from "hono";
import { env } from "../lib/env";
import { buildReplyMessages, MEDICAL_QUESTION_ATTACHMENT_MESSAGE } from "../services/reply";

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

async function reply(replyToken: string, messages: unknown[]) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.lineToken}`,
    },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
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
        // Non-text message events (image/sticker/video/audio/file/location) used
        // to be filtered out above and get zero reply — worst case: a parent
        // sends a photo of their sick child and hears nothing back at all.
        if (e.message?.type !== "text") {
          return reply(e.replyToken, [{ type: "text", text: MEDICAL_QUESTION_ATTACHMENT_MESSAGE }]);
        }
        return reply(e.replyToken, await buildReplyMessages(String(e.message.text), "line"));
      }),
  );
  return c.text("OK");
});
