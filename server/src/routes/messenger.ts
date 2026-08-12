import { Hono } from "hono";
import { env } from "../lib/env";
export const messenger = new Hono();

// FB webhook verification handshake
messenger.get("/webhook/messenger", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === env.fbVerifyToken) return c.text(challenge ?? "");
  return c.text("Invalid verify token", 403);
});

// TODO: parity with LINE — reuse detectIntent + buildReply, send via Send API
messenger.post("/webhook/messenger", async (c) => {
  await c.req.json().catch(() => ({}));
  return c.text("EVENT_RECEIVED");
});
