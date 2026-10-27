import { describe, it, expect, vi } from "vitest";

// ../lib/env and ../lib/supabase throw/connect at import — mock like the other tests.
vi.mock("../lib/env", () => ({ env: { fbPageId: "page", fbPageToken: "token" } }));
vi.mock("../lib/supabase", () => ({ admin: {} }));

import { buildMultiPhotoFeedParams } from "./facebook";

describe("buildMultiPhotoFeedParams", () => {
  it("attaches every uploaded photo id, in order, to one feed post", () => {
    const p = buildMultiPhotoFeedParams("tok", "สวัสดีค่ะ", ["111", "222", "333"]);
    expect(p.get("message")).toBe("สวัสดีค่ะ");
    expect(p.get("access_token")).toBe("tok");
    expect(p.get("attached_media[0]")).toBe('{"media_fbid":"111"}');
    expect(p.get("attached_media[2]")).toBe('{"media_fbid":"333"}');
    expect(p.has("attached_media[3]")).toBe(false);
  });
});
