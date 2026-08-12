import { Hono } from "hono";
import { env } from "../lib/env";
import { detectIntent } from "../services/intent";
import { buildVaccineAdvice } from "../services/vaccine";

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

async function buildReply(text: string): Promise<unknown[]> {
  const r = await detectIntent(text);
  switch (r.intent) {
    case "VACCINE_INFO":
    case "VACCINE_PRICE":
    case "VACCINE_AVAILABILITY": {
      if (!r.vaccineGroup)
        return [{ type: "text", text: "ระบุชื่อวัคซีนและอายุได้เลยค่ะ เช่น PCV 2 เดือน" }];
      const cards = await buildVaccineAdvice(r.vaccineGroup, r.ageMonths ?? null);
      if (!cards.length)
        return [{ type: "text", text: "ยังไม่พบข้อมูลสำหรับอายุที่ระบุ กรุณาติดต่อคลินิกค่ะ" }];
      const lines = cards.map((c) =>
        `• ${c.title} (${c.ageRange})` +
        (c.price ? ` — ${c.price.toLocaleString()} บาท` : "") +
        (c.message ? `\n  ${c.message}` : ""),
      );
      return [{ type: "text", text: lines.join("\n\n") }];
    }
    case "CLINIC_STATUS":
    case "CLINIC_TIME":
      return [{ type: "text", text: "ดูเวลาทำการ/สถานะล่าสุดได้ที่นี่ค่ะ (TODO: clinic status service)" }];
    case "LOCATION":
      return [{ type: "text", text: "แผนที่คลินิกค่ะ (TODO: pull from clinic_config)" }];
    case "APPOINTMENT_CHANGE":
      return [{ type: "text", text: "เรื่องเลื่อน/เปลี่ยนนัด กรุณาติดต่อเจ้าหน้าที่ค่ะ" }];
    default:
      return [{ type: "text", text: "สวัสดีค่ะ บ้านเด็กคลินิก พิมพ์ชื่อวัคซีนหรือ 'เวลาทำการ' ได้เลยค่ะ" }];
  }
}

line.post("/webhook/line", async (c) => {
  const raw = await c.req.text();
  if (!(await verify(raw, c.req.header("x-line-signature")))) {
    return c.text("Bad signature", 401);
  }
  const body = JSON.parse(raw) as { events?: any[] };
  // Ack fast; process each text event.
  await Promise.all(
    (body.events ?? [])
      .filter((e) => e.type === "message" && e.message?.type === "text" && e.replyToken)
      .map(async (e) => reply(e.replyToken, await buildReply(String(e.message.text)))),
  );
  return c.text("OK");
});
