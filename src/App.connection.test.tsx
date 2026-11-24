import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const server = vi.hoisted(() => ({
  connect: vi.fn(), disconnect: vi.fn(), command: vi.fn(), probe: vi.fn(),
  open: false, generation: 0, responseAt: 0, revision: 0,
  bluetooth: (_connected: boolean) => {},
  config: (_change: { key: string; value: string }) => {},
}));
vi.mock("./lib/MassClient", () => ({ MassClient: class {
  connect = server.connect;
  disconnect = server.disconnect;
  command = server.command;
  probeConnection = server.probe;
  get connectionGeneration() { return server.generation; }
  get lastResponseAt() { return server.responseAt; }
  get responseRevision() { return server.revision; }
  isConnected() { return server.open; }
  onEvent() { return () => {}; }
  onClose() { return () => {}; }
  takeStartupSnapshot() { return undefined; }
  enablePhonePlayerDiscovery() {}
  prioritizePhonePlayer() {}
} }));
vi.mock("./hooks/useHardware", () => ({ useHardware: () => {} }));
vi.mock("./hooks/usePlayerVolume", () => ({ usePlayerVolume: () => ({ volume: undefined, changeVolume: () => {} }) }));
vi.mock("./lib/bridgething", async original => ({
  ...await original<typeof import("./lib/bridgething")>(),
  isBridgeThingRuntime: () => true,
  loadBridgeThingPreferences: async () => undefined,
  readBridgeThingBrightness: async () => undefined,
  subscribeBridgeThingConfig: async (handler: typeof server.config) => { server.config = handler; return () => {}; },
  subscribeBridgeThingBluetooth: async (handler: typeof server.bluetooth) => { server.bluetooth = handler; return () => {}; },
  subscribeBridgeThingDocs: async () => () => {},
  subscribeBridgeThingVoice: async () => () => {},
  connectBridgeThingPhoneVolume: async () => ({ close: () => {} }),
}));

function respond() { server.responseAt = Date.now(); server.revision += 1; }
const config = { transport: "homeassistant", serverUrl: "https://ha.example.invalid", token: "test-only-token" };
const snapshot = (name: string) => name === "players/all"
  ? [{ player_id: "selected", name: "Selected speaker", available: true, powered: true, volume_level: 20 }]
  : [];
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() { await act(async () => { render(<App />); }); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("carthing-ma-config-v1", JSON.stringify(config));
  localStorage.setItem("carthing-ma-player-v1", "selected");
  server.open = false; server.generation = 0; server.responseAt = 0; server.revision = 0;
  server.connect.mockImplementation(async () => { server.generation += 1; server.open = true; respond(); });
  server.disconnect.mockImplementation(() => { server.generation += 1; server.open = false; server.responseAt = 0; });
  server.command.mockImplementation(async (name: string) => { respond(); return snapshot(name); });
  server.probe.mockImplementation(async () => { respond(); return true; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("app connection recovery", () => {
  it("keeps a responsive session after one failed metadata refresh", async () => {
    await mount();
    let failed = false;
    server.command.mockImplementation(async (name: string) => {
      if (name === "players/all" && !failed) { failed = true; throw new Error("temporary metadata timeout"); }
      respond(); return snapshot(name);
    });
    await advance(4_000);
    expect(server.probe).toHaveBeenCalledOnce();
    expect(server.disconnect).not.toHaveBeenCalled();
    expect(server.connect).toHaveBeenCalledOnce();
    await advance(8_000);
    expect(server.connect).toHaveBeenCalledOnce();
    expect(localStorage.getItem("carthing-ma-player-v1")).toBe("selected");
  });

  it("requires two failed health checks before resetting a silent open connection", async () => {
    await mount();
    server.command.mockRejectedValue(new Error("request stalled"));
    server.probe.mockResolvedValue(false);
    await advance(4_000);
    expect(server.disconnect).not.toHaveBeenCalled();
    await advance(4_000);
    expect(server.probe).toHaveBeenCalledTimes(2);
    expect(server.disconnect).toHaveBeenCalledOnce();
  });

  it("does not let cached snapshots hide a silent socket", async () => {
    await mount();
    server.command.mockImplementation(async (name: string) => snapshot(name));
    server.probe.mockResolvedValue(false);
    await advance(20_000);
    expect(server.probe).toHaveBeenCalledOnce();
    expect(server.disconnect).not.toHaveBeenCalled();
    await advance(4_000);
    expect(server.disconnect).toHaveBeenCalledOnce();
  });

  it("does not interrupt a session just because the app regains focus", async () => {
    await mount();
    server.command.mockRejectedValueOnce(new Error("temporary metadata timeout"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(server.probe).toHaveBeenCalledOnce();
    expect(server.disconnect).not.toHaveBeenCalled();
  });

  it("pauses connection attempts while the phone is absent and resumes when it returns", async () => {
    await mount();
    await act(async () => { server.bluetooth(false); });
    await advance(90_000);
    expect(server.connect).toHaveBeenCalledOnce();
    await act(async () => { server.bluetooth(true); });
    await advance(1_000);
    expect(server.connect).toHaveBeenCalledTimes(2);
    expect(server.open).toBe(true);
    expect(JSON.parse(localStorage.getItem("carthing-ma-config-v1")!)).toEqual(config);
    expect(localStorage.getItem("carthing-ma-player-v1")).toBe("selected");
  });

  it("saves an inactive remote ID without reconnecting HA", async () => {
    await mount();
    await act(async () => { server.config({ key: "remoteId", value: "NEW-REMOTE-ID" }); });
    await advance(1_000);
    expect(server.connect).toHaveBeenCalledOnce();
    expect(server.disconnect).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("carthing-ma-config-v1")!).remoteId).toBe("NEW-REMOTE-ID");
  });

  it("ignores a delayed recovery timer if the connection has already recovered", async () => {
    await mount();
    server.open = false;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    server.open = true;
    await advance(1_000);
    expect(server.connect).toHaveBeenCalledOnce();
    expect(server.disconnect).not.toHaveBeenCalled();
  });

  it("uses the latest settings when a real connection change is debounced", async () => {
    await mount();
    await act(async () => { server.config({ key: "token", value: "updated-test-token" }); });
    await act(async () => { server.config({ key: "remoteId", value: "inactive-new-id" }); });
    await advance(1_000);
    expect(server.connect).toHaveBeenCalledTimes(2);
    expect(server.connect.mock.calls[1][1]).toBe("updated-test-token");
    expect(JSON.parse(localStorage.getItem("carthing-ma-config-v1")!).remoteId).toBe("inactive-new-id");
  });
});
