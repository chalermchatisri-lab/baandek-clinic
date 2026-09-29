import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/env", () => ({
  env: { fbVerifyToken: "verify-token", fbPageToken: "page-token" },
}));
vi.mock("../services/reply", () => ({
  buildReplyMessages: vi.fn().mockResolvedValue([{ type: "text", text: "MOCK_REPLY" }]),
  buildMedicalQuestionAttachmentMessage: vi.fn().mockResolvedValue("MOCK_ATTACHMENT_REPLY"),
}));

const { buildReplyMessages } = await import("../services/reply");
const { messenger } = await import("./messenger");

function webhookEvent(entryMessaging: unknown[]) {
  return { object: "page", entry: [{ messaging: entryMessaging }] };
}

async function post(body: unknown) {
  return messenger.request("/webhook/messenger", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("messenger webhook — human-handoff mute (round 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") }) as unknown as typeof fetch;
  });

  it("does not call buildReplyMessages or the Send API for an echo with no app_id (staff typed via Page Inbox)", async () => {
    await post(webhookEvent([{
      sender: { id: "PAGE_ID" },
      recipient: { id: "customer-A" },
      message: { is_echo: true, text: "ขอเบอร์ติดต่อกลับด้วยค่ะ" },
    }]));
    expect(buildReplyMessages).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not call buildReplyMessages or the Send API for an echo WITH app_id (the bot's own Send API message)", async () => {
    await post(webhookEvent([{
      sender: { id: "PAGE_ID" },
      recipient: { id: "customer-B" },
      message: { is_echo: true, app_id: 123456, text: "MOCK_REPLY" },
    }]));
    expect(buildReplyMessages).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("suppresses the bot entirely for a customer message that arrives after a staff echo (muted)", async () => {
    await post(webhookEvent([{
      sender: { id: "PAGE_ID" },
      recipient: { id: "customer-C" },
      message: { is_echo: true, text: "ขอเบอร์ติดต่อกลับด้วยค่ะ" },
    }]));
    await post(webhookEvent([{
      sender: { id: "customer-C" },
      recipient: { id: "PAGE_ID" },
      message: { text: "0918239450" },
    }]));
    expect(buildReplyMessages).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still auto-replies normally to a customer message with no prior staff echo", async () => {
    await post(webhookEvent([{
      sender: { id: "customer-D" },
      recipient: { id: "PAGE_ID" },
      message: { text: "สวัสดีค่ะ" },
    }]));
    expect(buildReplyMessages).toHaveBeenCalledWith("สวัสดีค่ะ", "messenger", "customer-D");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not mute an unrelated customer (PSID) just because a different conversation had a staff echo", async () => {
    await post(webhookEvent([{
      sender: { id: "PAGE_ID" },
      recipient: { id: "customer-E" },
      message: { is_echo: true, text: "..." },
    }]));
    await post(webhookEvent([{
      sender: { id: "customer-F" },
      recipient: { id: "PAGE_ID" },
      message: { text: "สวัสดีค่ะ" },
    }]));
    expect(buildReplyMessages).toHaveBeenCalledWith("สวัสดีค่ะ", "messenger", "customer-F");
  });
});
