import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { markHumanHandling, isHumanHandling } from "./humanHandoff";

describe("humanHandoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is false for a conversation that was never marked", () => {
    expect(isHumanHandling("messenger", "psid-never-marked")).toBe(false);
  });

  it("is true right after marking", () => {
    markHumanHandling("messenger", "psid-1");
    expect(isHumanHandling("messenger", "psid-1")).toBe(true);
  });

  it("expires after the TTL (30 minutes)", () => {
    markHumanHandling("messenger", "psid-2");
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(isHumanHandling("messenger", "psid-2")).toBe(false);
  });

  it("is still true just before the TTL elapses", () => {
    markHumanHandling("messenger", "psid-3");
    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(isHumanHandling("messenger", "psid-3")).toBe(true);
  });

  it("re-marking resets the TTL (a later staff message extends the mute)", () => {
    markHumanHandling("messenger", "psid-4");
    vi.advanceTimersByTime(25 * 60 * 1000);
    markHumanHandling("messenger", "psid-4"); // staff typed again
    vi.advanceTimersByTime(25 * 60 * 1000); // 50 min total, but only 25 since the re-mark
    expect(isHumanHandling("messenger", "psid-4")).toBe(true);
  });

  it("does not leak across different PSIDs", () => {
    markHumanHandling("messenger", "psid-5");
    expect(isHumanHandling("messenger", "psid-other")).toBe(false);
  });

  it("does not leak across different channels for the same userId", () => {
    markHumanHandling("messenger", "same-id");
    expect(isHumanHandling("line", "same-id")).toBe(false);
  });
});
