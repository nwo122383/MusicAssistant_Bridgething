import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import { encodeHaSession } from "./homeAssistantAuth";

const bridge = vi.hoisted(() => ({
  fetch: vi.fn(), open: vi.fn(), send: vi.fn(), close: vi.fn(),
  message: (_event: { connectionId: string; frame: { type: string; data: string } }) => {},
  closed: (_event: { connectionId: string }) => {},
}));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  net = {
    fetch: bridge.fetch, wsOpen: bridge.open, wsSend: bridge.send, wsClose: vi.fn(async () => {}),
    onWsMessage: (handler: typeof bridge.message) => { bridge.message = handler; return () => {}; },
    onWsClosed: (handler: typeof bridge.closed) => { bridge.closed = handler; return () => {}; },
    onWsErrorEvent: () => () => {},
  };
  close = bridge.close;
} }));

let client: MassClient;
const origin = "https://ha.example.com";
const credential = () => encodeHaSession({ origin, accessToken: "expired-test-access", refreshToken: "test-refresh", expiresAt: Date.now() - 1000 });
beforeEach(() => {
  vi.clearAllMocks(); client = new MassClient();
  (client as unknown as { finishHomeAssistantConnect: () => Promise<void> }).finishHomeAssistantConnect = vi.fn(async () => {});
  bridge.open.mockResolvedValue({ ok: true, response: {} });
  bridge.send.mockResolvedValue(undefined);
  bridge.fetch.mockResolvedValue({ ok: true, response: { response: {
    status: 200, body: new TextEncoder().encode(JSON.stringify({ access_token: "renewed-test-access", expires_in: 1800 })),
  } } });
});
afterEach(() => { client.disconnect(); });
function message(type: string) {
  const id = bridge.open.mock.calls[bridge.open.mock.calls.length - 1][0].connectionId;
  bridge.message({ connectionId: id, frame: { type: "text", data: JSON.stringify({ type }) } });
}
async function ready() {
  await vi.waitFor(() => expect(bridge.open).toHaveBeenCalled());
  message("auth_required"); message("auth_ok");
}

describe("Home Assistant renewable credentials", () => {
  it("refreshes expired credentials through the phone and sends only the access token to HA", async () => {
    const saved = credential();
    const run = client.connect(origin, saved, "homeassistant");
    await ready(); await run;
    expect(bridge.fetch).toHaveBeenCalledOnce();
    const request = bridge.fetch.mock.calls[0][0].request;
    expect(request.url).toBe(origin + "/auth/token");
    expect(request.redirect).toBe("error");
    expect(new TextDecoder().decode(request.body)).toContain("grant_type=refresh_token");
    const frames = bridge.send.mock.calls.map(([arg]) => JSON.parse(arg.frame.data));
    expect(frames[0]).toEqual({ type: "auth", access_token: "renewed-test-access" });
    expect(JSON.stringify(frames)).not.toContain("test-refresh");
    const second = client.connect(origin, saved, "homeassistant");
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2));
    message("auth_required"); message("auth_ok"); await second;
    expect(bridge.fetch).toHaveBeenCalledOnce();
  });

  it("keeps manual HA tokens compatible", async () => {
    const run = client.connect(origin, "manual-test-token", "homeassistant");
    await ready(); await run;
    expect(bridge.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(bridge.send.mock.calls[0][0].frame.data).access_token).toBe("manual-test-token");
  });

  it("does not let a diagnostics failure interrupt a working connection", async () => {
    const run = client.connect(origin, "manual-test-token", "homeassistant", {
      onStartupPhase: () => { throw new Error("Diagnostic storage unavailable"); },
    });
    await ready(); await run;
    expect(client.isConnected()).toBe(true);
  });

  it("does not repeatedly submit a revoked refresh credential", async () => {
    bridge.fetch.mockResolvedValue({ ok: true, response: { response: { status: 400, body: new TextEncoder().encode("{}") } } });
    const saved = credential();
    await expect(client.connect(origin, saved, "homeassistant")).rejects.toThrow(/Sign in again/);
    await expect(client.connect(origin, saved, "homeassistant")).rejects.toThrow(/Sign in to Home Assistant again/);
    expect(bridge.fetch).toHaveBeenCalledOnce();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it("never sends a saved session to a different server", async () => {
    await expect(client.connect("https://other.example.com", credential(), "homeassistant")).rejects.toThrow(/this server URL/);
    expect(bridge.fetch).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
  });

  it("cancels an HA handshake immediately when replaced", async () => {
    const run = client.connect(origin, "manual-test-token", "homeassistant");
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalled());
    const rejected = expect(run).rejects.toThrow(/replaced/);
    client.disconnect(); await rejected;
    expect(client.isConnected()).toBe(false);
  });

  it("notifies app recovery when an established HA connection closes", async () => {
    const closed = vi.fn(); client.onClose(closed);
    const run = client.connect(origin, "manual-test-token", "homeassistant");
    await ready(); await run;
    bridge.closed({ connectionId: bridge.open.mock.calls[0][0].connectionId });
    expect(closed).toHaveBeenCalledOnce();
    expect(client.isConnected()).toBe(false);
  });
});
