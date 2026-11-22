import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Player } from "../types";
import type { VolumeTarget } from "../lib/playerVolume";
import { usePlayerVolume } from "./usePlayerVolume";

const move: Player = { player_id: "move", name: "Move", available: true, powered: true, volume_level: 10, group_members: ["dining"] };
const target: VolumeTarget = { playerId: "move", level: 40, grouped: true, route: "native", connectionEpoch: 0 };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
};
function setup() {
  const client = { getVolumeTarget: vi.fn(async () => ({ ...target })), setVolume: vi.fn(async (_target: VolumeTarget, _level: number) => {}) };
  const onError = vi.fn();
  const ensureConnected = vi.fn(async () => true);
  const hook = renderHook(({ player, enabled, connectionKey }) => usePlayerVolume({ client, player, enabled, connectionKey, ensureConnected, onError }), {
    initialProps: { player: move, enabled: true, connectionKey: "server-a" },
  });
  return { ...hook, client, onError, ensureConnected };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("volume wheel sessions", () => {
  it("applies each wheel step to every member while retaining their offsets", async () => {
    const { result, client } = setup();
    client.getVolumeTarget.mockResolvedValueOnce({ ...target, level: 24, members: [{ playerId: "move", level: 9 }, { playerId: "dining", level: 24 }] });
    act(() => result.current.changeVolume(2));
    await tick(500);
    expect(client.setVolume).toHaveBeenLastCalledWith(expect.objectContaining({ members: [{ playerId: "move", level: 11 }, { playerId: "dining", level: 26 }] }), 26);
    act(() => result.current.changeVolume(-2));
    await tick(500);
    expect(client.setVolume).toHaveBeenLastCalledWith(expect.objectContaining({ members: [{ playerId: "move", level: 9 }, { playerId: "dining", level: 24 }] }), 24);
  });
  it("uses aggregate volume and coalesces rapid wheel turns", async () => {
    const { result, client } = setup();
    act(() => { result.current.changeVolume(2); result.current.changeVolume(2); result.current.changeVolume(-2); });
    await tick();
    expect(result.current.volume).toBe(42);
    expect(client.getVolumeTarget).toHaveBeenCalledOnce();
    await tick(499);
    expect(client.setVolume).not.toHaveBeenCalled();
    await tick(1);
    expect(client.setVolume).toHaveBeenCalledExactlyOnceWith({ ...target, level: 42 }, 42);
    await tick(2500);
    expect(result.current.volume).toBeUndefined();
  });

  it("keeps all wheel input received while reading a slow group level", async () => {
    const { result, client } = setup();
    const read = deferred<VolumeTarget>();
    client.getVolumeTarget.mockReturnValueOnce(read.promise);
    act(() => result.current.changeVolume(2));
    await tick();
    act(() => { result.current.changeVolume(2); result.current.changeVolume(2); });
    await act(async () => read.resolve(target));
    expect(result.current.volume).toBe(46);
    await tick(500);
    expect(client.setVolume).toHaveBeenCalledExactlyOnceWith({ ...target, level: 46 }, 46);
  });

  it("clamps each step so reversing at the end of the range responds immediately", async () => {
    const { result, client } = setup();
    client.getVolumeTarget.mockResolvedValueOnce({ ...target, level: 100 });
    act(() => { result.current.changeVolume(2); result.current.changeVolume(-2); });
    await tick();
    expect(result.current.volume).toBe(98);
  });

  it("serializes slow writes and sends the latest debounced level afterwards", async () => {
    const { result, client } = setup();
    const first = deferred<void>();
    client.setVolume.mockReturnValueOnce(first.promise);
    act(() => result.current.changeVolume(2));
    await tick(500);
    act(() => result.current.changeVolume(2));
    await tick(500);
    act(() => result.current.changeVolume(2));
    await tick(500);
    expect(client.setVolume).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    expect(client.setVolume.mock.calls.map(call => call[1])).toEqual([42, 46]);
  });

  it("does not reread stale server volume while a previous write is outstanding", async () => {
    const { result, client } = setup();
    const first = deferred<void>();
    client.setVolume.mockReturnValueOnce(first.promise);
    act(() => result.current.changeVolume(2));
    await tick(4000);
    expect(result.current.volume).toBeUndefined();
    act(() => result.current.changeVolume(2));
    await tick(500);
    expect(result.current.volume).toBe(44);
    expect(client.getVolumeTarget).toHaveBeenCalledOnce();
    await act(async () => first.resolve());
    expect(client.setVolume.mock.calls.map(call => call[1])).toEqual([42, 44]);
  });

  it.each(["selection", "membership", "connection", "phone"])("cancels a pending write on a %s change", async change => {
    const { result, client, rerender } = setup();
    act(() => result.current.changeVolume(2));
    await tick();
    rerender({
      player: change === "selection" ? { ...move, player_id: "roam" } : change === "membership" ? { ...move, group_members: [] } : move,
      enabled: change !== "phone",
      connectionKey: change === "connection" ? "server-b" : "server-a",
    });
    await tick(500);
    expect(client.setVolume).not.toHaveBeenCalled();
    expect(result.current.volume).toBeUndefined();
  });

  it("ignores late reads from a previously selected player", async () => {
    const { result, client, rerender } = setup();
    const read = deferred<VolumeTarget>();
    client.getVolumeTarget.mockReturnValueOnce(read.promise);
    act(() => result.current.changeVolume(2));
    await tick();
    rerender({ player: { ...move, player_id: "roam" }, enabled: true, connectionKey: "server-a" });
    await act(async () => read.resolve(target));
    await tick(1000);
    expect(client.setVolume).not.toHaveBeenCalled();
    expect(result.current.volume).toBeUndefined();
  });

  it("cancels queued member adjustments if the leader's membership changes", async () => {
    const client = { getVolumeTarget: vi.fn(async () => target), setVolume: vi.fn(async () => {}) };
    const dining = { ...move, player_id: "dining", synced_to: "move", group_members: [] };
    const hook = renderHook(({ leader }) => usePlayerVolume({
      client, player: dining, players: [dining, leader], enabled: true, connectionKey: "server", ensureConnected: async () => true, onError: vi.fn(),
    }), { initialProps: { leader: move } });
    act(() => hook.result.current.changeVolume(2));
    await tick();
    hook.rerender({ leader: { ...move, group_members: ["dining", "roam"] } });
    await tick(500);
    expect(client.setVolume).not.toHaveBeenCalled();
  });

  it("reports errors and reads a fresh level on the next attempt", async () => {
    const { result, client, onError } = setup();
    client.setVolume.mockRejectedValueOnce(new Error("connection changed"));
    act(() => result.current.changeVolume(2));
    await tick(500);
    expect(onError).toHaveBeenCalledWith("connection changed");
    expect(result.current.volume).toBeUndefined();
    client.getVolumeTarget.mockResolvedValueOnce({ ...target, level: 30 });
    act(() => result.current.changeVolume(-2));
    await tick(500);
    expect(client.setVolume).toHaveBeenLastCalledWith({ ...target, level: 28 }, 28);
  });

  it("does nothing for the phone route or when reconnection fails", async () => {
    const { result, client, rerender, ensureConnected } = setup();
    rerender({ player: move, enabled: false, connectionKey: "server-a" });
    act(() => result.current.changeVolume(2));
    await tick(1000);
    expect(ensureConnected).not.toHaveBeenCalled();
    rerender({ player: move, enabled: true, connectionKey: "server-a" });
    ensureConnected.mockResolvedValue(false);
    act(() => result.current.changeVolume(2));
    await tick(1000);
    expect(client.getVolumeTarget).not.toHaveBeenCalled();
    expect(client.setVolume).not.toHaveBeenCalled();
  });

  it("cancels debounce and hide timers when unmounted", async () => {
    const { result, client, unmount } = setup();
    act(() => result.current.changeVolume(2));
    await tick();
    unmount();
    await tick(4000);
    expect(client.setVolume).not.toHaveBeenCalled();
  });
});
