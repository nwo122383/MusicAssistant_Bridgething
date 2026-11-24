import { describe, expect, it, vi } from "vitest";
import { connectionNeedsReconnect, recoverAfterGatewayAttempt, sameConnection, ServerHealthGuard, shouldRecoverGateway, shouldReloadBridgeApp, shouldWaitForGateway } from "./connectionRecovery";

describe("gateway reconnection", () => {
  it("does not interrupt a negotiating connection on repeated phone announcements", () => {
    expect(shouldRecoverGateway("connecting", true, true, 90_000, 45_000)).toBe(false);
    expect(shouldRecoverGateway("error", false, true, 90_000, 45_000)).toBe(false);
    expect(shouldRecoverGateway("connected", true, false, 1_000, 45_000)).toBe(false);
    expect(shouldRecoverGateway("error", false, false, 90_000, 45_000)).toBe(true);
    expect(shouldRecoverGateway("connected", true, false, 90_000, 45_000)).toBe(true);
  });

  it("waits for an existing attempt before retrying after gateway recovery", async () => {
    let finish!: () => void;
    const flight = new Promise<void>(resolve => { finish = resolve; });
    const retry = vi.fn();
    recoverAfterGatewayAttempt(flight, () => true, retry);
    expect(retry).not.toHaveBeenCalled();
    finish(); await flight;
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not replace a successful handshake, a newer attempt, or a disposed subscription", async () => {
    const retry = vi.fn();
    recoverAfterGatewayAttempt(Promise.resolve(), () => false, retry);
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
  });

  it("can retry a rejected attempt without an unhandled rejection", async () => {
    const retry = vi.fn();
    recoverAfterGatewayAttempt(Promise.reject(new Error("Old gateway unavailable")), () => true, retry);
    await Promise.resolve();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("ignores settings echoes but recognizes new credentials and paths", () => {
    const config = { serverUrl: "https://example.invalid", transport: "webrtc" as const, remoteId: "abc", token: "test" };
    expect(sameConnection(config, { ...config })).toBe(true);
    expect(sameConnection(config, { ...config, token: "new" })).toBe(false);
    expect(sameConnection(config, { ...config, transport: "direct" })).toBe(false);
    expect(sameConnection({ serverUrl: "" }, { serverUrl: "", transport: "direct", token: "" })).toBe(true);
  });

  it("repairs cold-start failures across retries, with a reload cooldown", () => {
    const options = { now: 600_000, lastHealthy: 400_000, lastReload: 0, gatewayConnected: true,
      configured: true, state: "connecting" as const, editingSettings: false };
    expect(shouldReloadBridgeApp(options)).toBe(true);
    expect(shouldReloadBridgeApp({ ...options, lastHealthy: 500_000 })).toBe(false);
    expect(shouldReloadBridgeApp({ ...options, lastReload: 450_000 })).toBe(false);
    expect(shouldReloadBridgeApp({ ...options, gatewayConnected: false })).toBe(false);
    expect(shouldReloadBridgeApp({ ...options, configured: false })).toBe(false);
    expect(shouldReloadBridgeApp({ ...options, editingSettings: true })).toBe(false);
    expect(shouldReloadBridgeApp({ ...options, state: "connected" })).toBe(false);
  });
});

describe("active connection settings", () => {
  it("does not reconnect for an inactive URL or remote ID", () => {
    const webrtc = { transport: "webrtc" as const, remoteId: "AB-CD", serverUrl: "https://old.invalid" };
    expect(connectionNeedsReconnect(webrtc, { ...webrtc, serverUrl: "https://new.invalid", remoteId: "ab cd" })).toBe(false);
    expect(connectionNeedsReconnect(webrtc, { ...webrtc, remoteId: "EFGH" })).toBe(true);
    const ha = { transport: "homeassistant" as const, serverUrl: "https://ha.invalid/" };
    expect(connectionNeedsReconnect(ha, { ...ha, serverUrl: "https://ha.invalid/path", remoteId: "new" })).toBe(false);
    expect(connectionNeedsReconnect(ha, { ...ha, token: "new" })).toBe(true);
    expect(connectionNeedsReconnect(ha, { ...ha, serverUrl: "https://other.invalid" })).toBe(true);
    expect(connectionNeedsReconnect({ serverUrl: "http://ma.invalid/" }, { serverUrl: "http://ma.invalid", remoteId: "new" })).toBe(false);
  });

  it("waits only for a known missing phone on a phone-backed connection", () => {
    for (const transport of ["homeassistant", "bridgething", "webrtc"] as const) {
      const config = { transport, serverUrl: "https://example.invalid" };
      expect(shouldWaitForGateway(config, true, false)).toBe(true);
      expect(shouldWaitForGateway(config, true, undefined)).toBe(false);
      expect(shouldWaitForGateway(config, true, true)).toBe(false);
      expect(shouldWaitForGateway(config, false, false)).toBe(false);
    }
    expect(shouldWaitForGateway({ transport: "direct", serverUrl: "http://ma.invalid" }, true, false)).toBe(false);
  });
});

describe("server health recovery", () => {
  it("tolerates one failed probe, but recovers after two consecutive failures", async () => {
    const guard = new ServerHealthGuard();
    expect(await guard.verify(1, async () => false)).toBe("suspect");
    expect(await guard.verify(1, async () => false)).toBe("dead");
  });

  it("resets failures on successful snapshots, events, or probes", async () => {
    const guard = new ServerHealthGuard();
    await guard.verify(1, async () => false);
    guard.recordSuccess(1);
    expect(await guard.verify(1, async () => false)).toBe("suspect");
    expect(await guard.verify(1, async () => true)).toBe("healthy");
    expect(await guard.verify(1, async () => { throw new Error("offline"); })).toBe("suspect");
  });

  it("shares a pending probe and ignores a failure after a newer server response", async () => {
    const guard = new ServerHealthGuard();
    let finish!: (healthy: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const first = guard.verify(1, probe);
    expect(guard.verify(1, probe)).toBe(first);
    expect(probe).toHaveBeenCalledOnce();
    guard.recordSuccess(1);
    finish(false);
    expect(await first).toBe("healthy");
  });

  it("never lets a stale connection invalidate its replacement", async () => {
    const guard = new ServerHealthGuard();
    let finish!: (healthy: boolean) => void;
    const old = guard.verify(1, () => new Promise<boolean>(resolve => { finish = resolve; }));
    guard.recordSuccess(2);
    guard.recordSuccess(1);
    finish(false);
    expect(await old).toBe("superseded");
    expect(await guard.verify(1, async () => false)).toBe("superseded");
    expect(await guard.verify(2, async () => false)).toBe("suspect");
  });
});
