import { describe, expect, it, vi } from "vitest";
import { StartupTrace } from "./startupDiagnostics";

describe("local startup timing diagnostics", () => {
  it("records app-relative timing and attempts without connection or account data", () => {
    let now = 1_000;
    const write = vi.fn();
    const trace = new StartupTrace(() => now, write);
    now = 1_250;
    expect(trace.startAttempt()).toBe(1);
    now = 1_900;
    trace.mark("screen_ready");
    expect(write.mock.lastCall?.[0]).toEqual([
      { phase: "app_started", elapsedMs: 0, attempt: 0 },
      { phase: "connection_started", elapsedMs: 250, attempt: 1 },
      { phase: "screen_ready", elapsedMs: 900, attempt: 1 },
    ]);
    expect(Object.keys(write.mock.lastCall?.[0][0]).sort()).toEqual(["attempt", "elapsedMs", "phase"]);
  });

  it("bounds retained diagnostics and does not fail playback when storage is unavailable", () => {
    const write = vi.fn();
    const trace = new StartupTrace(() => 0, write);
    for (let i = 0; i < 100; i++) trace.mark("connection_failed");
    expect(write.mock.lastCall?.[0]).toHaveLength(48);
    expect(() => new StartupTrace(() => 0, () => { throw new Error("Storage blocked"); }).mark("screen_ready")).not.toThrow();
  });
});
