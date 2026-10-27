import { describe, it, expect, vi } from "vitest";

// ../lib/env throws if SUPABASE_URL etc. are unset — mock it like the other tests.
vi.mock("../lib/env", () => ({ env: { lineToken: "test" } }));

import { mergeButtons, todayUtc9, isYyyyMmDd } from "./lineInsight";

const menu = {
  richMenuId: "richmenu-x",
  areas: [
    { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "message", text: "จองคิว" } },
    { bounds: { x: 833, y: 0, width: 833, height: 843 }, action: { type: "uri", uri: "https://liff.line.me/123?a=b" } },
  ],
};

describe("lineInsight", () => {
  it("matches clicks to buttons by bounds; unmatched area = 0", () => {
    const out = mergeButtons(menu, {
      richMenuId: "richmenu-x",
      clicks: [{ bounds: { x: 0, y: 0, width: 833, height: 843 }, metrics: { count: 42, uniqueUsers: 30 } }],
    });
    expect(out[0]).toEqual({ button: "จองคิว", actionType: "message", clicks: 42, uniqueUsers: 30 });
    expect(out[1]).toEqual({ button: "liff.line.me/123", actionType: "uri", clicks: 0, uniqueUsers: 0 });
  });

  it("returns null counts when LINE withholds data", () => {
    const out = mergeButtons(menu, { richMenuId: "richmenu-x" });
    expect(out.every((b) => b.clicks === null)).toBe(true);
  });

  it("formats today in UTC+9 and validates dates", () => {
    expect(todayUtc9(new Date("2026-10-27T16:00:00Z"))).toBe("20261028");
    expect(isYyyyMmDd("20261027")).toBe(true);
    expect(isYyyyMmDd("2026-10-27")).toBe(false);
  });
});
