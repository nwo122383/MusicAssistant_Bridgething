import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeBridgeThingBluetooth } from "./bridgething";

const bridge = vi.hoisted(() => ({
  get: vi.fn(), close: vi.fn(), off: vi.fn(),
  status: (_status: { connected: boolean }) => {}, device: () => {},
}));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  bluetooth = {
    onStatus: (handler: typeof bridge.status) => { bridge.status = handler; return bridge.off; },
    onConnectedDevice: (handler: () => void) => { bridge.device = handler; return bridge.off; },
  };
  capabilities = { get: bridge.get };
  close = bridge.close;
} }));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  bridge.get.mockResolvedValue({ ok: true, response: { capabilities: { gateway: { name: "Phone" } } } });
});
afterEach(() => { vi.useRealTimers(); });

describe("BridgeThing gateway liveness", () => {
  it("checks at startup and periodically even when Bluetooth events are missed", async () => {
    const handler = vi.fn();
    const stop = await subscribeBridgeThingBluetooth(handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenLastCalledWith(true);
    bridge.get.mockResolvedValue({ ok: true, response: { capabilities: {} } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handler).toHaveBeenLastCalledWith(false);
    bridge.get.mockResolvedValue({ ok: true, response: { capabilities: { gateway: {} } } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handler).toHaveBeenLastCalledWith(true);
    stop();
    const calls = handler.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(handler).toHaveBeenCalledTimes(calls);
    expect(bridge.off).toHaveBeenCalledTimes(2);
    expect(bridge.close).toHaveBeenCalledTimes(4);
  });

  it("probes quickly while disconnected without speeding up an established gateway", async () => {
    bridge.get.mockResolvedValueOnce({ ok: true, response: { capabilities: {} } });
    const handler = vi.fn();
    const stop = await subscribeBridgeThingBluetooth(handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(bridge.get).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenLastCalledWith(true);
    expect(bridge.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(bridge.get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.get).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not treat a failed local RPC as a phone disconnect", async () => {
    bridge.get.mockRejectedValue(new Error("RPC unavailable"));
    const handler = vi.fn();
    const stop = await subscribeBridgeThingBluetooth(handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    bridge.status({ connected: false });
    bridge.device();
    expect(handler.mock.calls).toEqual([[false], [true]]);
    stop();
  });

  it("does not overlap probes or let stale results override a newer event", async () => {
    let resolve!: (result: unknown) => void;
    bridge.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const handler = vi.fn();
    const stop = await subscribeBridgeThingBluetooth(handler);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(bridge.get).toHaveBeenCalledOnce();
    bridge.status({ connected: false });
    resolve({ ok: true, response: { capabilities: { gateway: {} } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.mock.calls).toEqual([[false]]);
    stop();
  });

  it("ignores an in-flight probe after disposal", async () => {
    let resolve!: (result: unknown) => void;
    bridge.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const handler = vi.fn();
    const stop = await subscribeBridgeThingBluetooth(handler);
    stop();
    resolve({ ok: true, response: { capabilities: { gateway: {} } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    expect(bridge.close).toHaveBeenCalledTimes(2);
  });
});
