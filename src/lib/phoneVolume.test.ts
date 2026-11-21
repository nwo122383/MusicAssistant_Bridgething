import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectBridgeThingPhoneVolume, setBridgeThingPhoneVolumePlayer } from "./bridgething";
import { currentPlayer, nextPlayerId } from "./phonePlayer";
import type { Player } from "../types";

const bridge = vi.hoisted(() => ({
  up: vi.fn(), down: vi.fn(), close: vi.fn(), set: vi.fn(), off: vi.fn(),
  volume: (_event: { level: number; muted: boolean }) => {}, error: () => {},
}));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  audio = {
    volumeUp: bridge.up, volumeDown: bridge.down,
    onVolumeChanged: (handler: typeof bridge.volume) => { bridge.volume = handler; return bridge.off; },
    onErrorEvent: (handler: () => void) => { bridge.error = handler; return bridge.off; },
  };
  doc = { set: bridge.set };
  close = bridge.close;
} }));
beforeEach(() => { vi.clearAllMocks(); bridge.set.mockResolvedValue({ ok: true }); });

describe("phone media volume through BridgeThing", () => {
  it("waits for the pinned phone instead of redirecting car playback to a home speaker", () => {
    const home: Player = { player_id: "home", name: "Home", available: true, powered: true, volume_level: 20 };
    const phone: Player = { ...home, player_id: "phone", name: "Phone" };
    expect(nextPlayerId([home], "phone", "phone")).toBe("phone");
    expect(currentPlayer([home], "phone", "phone")).toBeUndefined();
    expect(currentPlayer([home, phone], "phone", "phone")).toBe(phone);
    expect(nextPlayerId([home], "unknown", "")).toBe("home");
    expect(nextPlayerId([home], "", "")).toBe("home");
    expect(currentPlayer([home, phone], "home", "phone")).toBe(home);
  });
  it("uses relative Android volume steps and reports actual levels including zero", async () => {
    const changed = vi.fn();
    const control = await connectBridgeThingPhoneVolume(changed, vi.fn());
    bridge.volume({ level: 0, muted: true });
    bridge.volume({ level: 0.16, muted: false });
    expect(changed.mock.calls).toEqual([[0], [16]]);
    await control.adjust(2);
    await control.adjust(-2);
    expect(bridge.up).toHaveBeenCalledOnce();
    expect(bridge.down).toHaveBeenCalledOnce();
    control.close();
    expect(bridge.off).toHaveBeenCalledTimes(2);
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it("reports phone volume failures and persists the explicit player assignment", async () => {
    const error = vi.fn();
    const control = await connectBridgeThingPhoneVolume(vi.fn(), error);
    await control.adjust(1);
    bridge.error();
    expect(error).toHaveBeenCalledOnce();
    await setBridgeThingPhoneVolumePlayer("test-phone-player");
    expect(bridge.set).toHaveBeenCalledWith({ key: "phoneVolumePlayerId", value: "test-phone-player" }, { timeoutMs: 3000 });
    control.close();
  });
});
