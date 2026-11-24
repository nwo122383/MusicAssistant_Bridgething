import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";

type Frame = { connectionId: string; frame: { type: string; data: string } };
const bridge = vi.hoisted(() => ({
  open: vi.fn(), send: vi.fn(), close: vi.fn(), dispose: vi.fn(),
  messages: new Set<(frame: Frame) => void>(),
  closes: new Set<(frame: { connectionId: string }) => void>(),
  errors: new Set<(frame: { connectionId: string }) => void>(),
}));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  net = {
    wsOpen: bridge.open, wsSend: bridge.send, wsClose: bridge.close,
    onWsMessage: (handler: (frame: Frame) => void) => { bridge.messages.add(handler); return () => bridge.messages.delete(handler); },
    onWsClosed: (handler: (frame: { connectionId: string }) => void) => { bridge.closes.add(handler); return () => bridge.closes.delete(handler); },
    onWsErrorEvent: (handler: (frame: { connectionId: string }) => void) => { bridge.errors.add(handler); return () => bridge.errors.delete(handler); },
  };
  close = bridge.dispose;
} }));

let client: MassClient;
const internals = () => client as unknown as {
  finishHomeAssistantConnect: () => Promise<void>;
  pending: Map<string, unknown>;
};
const connectionId = () => bridge.open.mock.calls[bridge.open.mock.calls.length - 1][0].connectionId as string;
const sentFrame = () => JSON.parse(bridge.send.mock.calls[bridge.send.mock.calls.length - 1][0].frame.data);
function message(data: Record<string, unknown>, id = connectionId()) {
  for (const handler of bridge.messages) handler({ connectionId: id, frame: { type: "text", data: JSON.stringify(data) } });
}
async function connected(ha = true) {
  const count = bridge.open.mock.calls.length;
  const flight = client.connect("https://example.invalid", ha ? "test-token" : undefined, ha ? "homeassistant" : "bridgething");
  await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(count + 1));
  await vi.waitFor(() => expect(client.isConnected()).toBe(true));
  message(ha ? { type: "auth_ok" } : { server_id: "test", server_version: "2.10.13" });
  await flight;
}
beforeEach(() => {
  vi.clearAllMocks();
  bridge.messages.clear(); bridge.closes.clear(); bridge.errors.clear();
  bridge.open.mockResolvedValue({ ok: true, response: {} });
  bridge.send.mockResolvedValue(undefined);
  bridge.close.mockResolvedValue(undefined);
  client = new MassClient();
  internals().finishHomeAssistantConnect = vi.fn(async () => {});
});
afterEach(async () => { client.disconnect(); await Promise.resolve(); vi.useRealTimers(); });

describe("connection liveness", () => {
  it("uses HA ping/pong without changing subscriptions or players", async () => {
    await connected();
    const generation = client.connectionGeneration;
    const revision = client.responseRevision;
    const probe = client.probeConnection();
    const frame = sentFrame();
    expect(frame).toEqual({ id: expect.any(Number), type: "ping" });
    message({ id: frame.id + 100, type: "pong" });
    expect(internals().pending.size).toBe(1);
    message({ id: frame.id, type: "pong" });
    expect(await probe).toBe(true);
    expect(client.responseRevision).toBeGreaterThan(revision);
    expect(client.lastResponseAt).toBeGreaterThan(0);
    expect(internals().pending.size).toBe(0);
    expect(client.connectionGeneration).toBe(generation);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it("does not count an open socket or unanswered probe as a server response", async () => {
    await connected();
    const revision = client.responseRevision;
    const receivedAt = client.lastResponseAt;
    vi.useFakeTimers();
    const probe = client.probeConnection();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await probe).toBe(false);
    expect(client.responseRevision).toBe(revision);
    expect(client.lastResponseAt).toBe(receivedAt);
    client.disconnect();
    expect(client.lastResponseAt).toBe(0);
  });

  it("uses the MA info command on the native MA protocol", async () => {
    await connected(false);
    const probe = client.probeConnection();
    const frame = sentFrame();
    expect(frame.command).toBe("info");
    message({ message_id: frame.message_id, result: { server_version: "test" } });
    expect(await probe).toBe(true);
  });

  it.each([true, false])("treats a server error reply as responsive, HA=%s", async ha => {
    await connected(ha);
    const probe = client.probeConnection();
    const frame = sentFrame();
    message(ha
      ? { id: frame.id, type: "result", success: false, error: { code: "unsupported" } }
      : { message_id: frame.message_id, error_code: 1, details: "unsupported" });
    expect(await probe).toBe(true);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it.each([true, false])("bounds a stalled probe without closing a healthy socket, HA=%s", async ha => {
    await connected(ha);
    vi.useFakeTimers();
    const probe = client.probeConnection();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await probe).toBe(false);
    expect(client.isConnected()).toBe(true);
    expect(internals().pending.size).toBe(0);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it("invalidates a probe when its connection is replaced", async () => {
    await connected();
    const oldId = connectionId();
    const probe = client.probeConnection();
    const frame = sentFrame();
    client.disconnect();
    expect(await probe).toBe(false);
    await connected();
    message({ id: frame.id, type: "pong" }, oldId);
    expect(client.isConnected()).toBe(true);
    expect(internals().pending.size).toBe(0);
  });

  it("does not send probes while disconnected", async () => {
    expect(await client.probeConnection()).toBe(false);
    expect(bridge.send).not.toHaveBeenCalled();
  });
});

describe("cancelled BridgeThing sockets", () => {
  it("does not open a remote socket after immediate cancellation during SDK loading", async () => {
    const flight = client.connect("https://example.invalid", undefined, "bridgething");
    const rejected = expect(flight).rejects.toThrow("Connection replaced");
    client.disconnect();
    await rejected;
    await vi.waitFor(() => expect(bridge.dispose).toHaveBeenCalledOnce());
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
    expect(bridge.messages.size).toBe(0);
  });

  it("closes a cancelled remote socket after its delayed open completes", async () => {
    let finish!: (value: unknown) => void;
    bridge.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const flight = client.connect("https://example.invalid", undefined, "bridgething");
    const rejected = expect(flight).rejects.toThrow("Connection replaced");
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledOnce());
    const oldId = connectionId();
    client.disconnect(); await rejected;
    expect(bridge.messages.size).toBe(0);
    expect(bridge.dispose).not.toHaveBeenCalled();
    await connected(false);
    const newId = connectionId();
    finish({ ok: true, response: {} });
    await vi.waitFor(() => expect(bridge.close).toHaveBeenCalledOnce());
    expect(bridge.close.mock.calls[0][0].connectionId).toBe(oldId);
    expect(newId).not.toBe(oldId);
    expect(client.isConnected()).toBe(true);
    expect(bridge.dispose).toHaveBeenCalledOnce();
  });

  it("cleans up failed opens and absorbs remote-close failures", async () => {
    bridge.open.mockRejectedValueOnce(new Error("gateway unavailable"));
    bridge.close.mockRejectedValueOnce(new Error("already disconnected"));
    await expect(client.connect("https://example.invalid", undefined, "bridgething")).rejects.toThrow("gateway unavailable");
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(bridge.dispose).toHaveBeenCalledOnce();
    expect(bridge.messages.size).toBe(0);
  });

  it("absorbs remote-close failures when replacing an established connection", async () => {
    await connected(false);
    bridge.close.mockRejectedValueOnce(new Error("phone out of range"));
    client.disconnect(); client.disconnect();
    await vi.waitFor(() => expect(bridge.dispose).toHaveBeenCalledOnce());
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(bridge.messages.size).toBe(0);
    expect(bridge.closes.size).toBe(0);
    expect(bridge.errors.size).toBe(0);
  });
});
