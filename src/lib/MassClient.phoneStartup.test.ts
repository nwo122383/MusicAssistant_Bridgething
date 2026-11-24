import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import type { Player, PlayerQueue } from "../types";

const id = "p".repeat(43);
const phone: Player = { player_id: id, name: "Phone", available: true, powered: true, volume_level: 0,
  device_info: { model: "Mobile Application", manufacturer: "MusicAssistant_Bridgething" } };
const queue: PlayerQueue = { queue_id: id, display_name: "Phone", active: true, state: "playing", elapsed_time: 1, elapsed_time_last_updated: 1 };
const clients: MassClient[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.useRealTimers(); });

function setup(startupId: string | undefined = id) {
  const client = new MassClient(); clients.push(client);
  const close = vi.fn();
  const internals = client as unknown as {
    protocol: string; socket: unknown; startupPhonePlayerId?: string; startupPhase: ReturnType<typeof vi.fn>;
    finishHomeAssistantConnect: () => Promise<void>; haStatesReady: boolean; haInitializationDeferred: boolean;
    haMassCommand: ReturnType<typeof vi.fn>; loadHomeAssistantConfigEntry: ReturnType<typeof vi.fn>;
    discoverHaPlayerEntityIds: ReturnType<typeof vi.fn>; haRequestWithPending: ReturnType<typeof vi.fn>;
    refreshHaTrackedStates: ReturnType<typeof vi.fn>; haQueues: ReturnType<typeof vi.fn>; haLibrary: ReturnType<typeof vi.fn>;
  };
  internals.protocol = "ha";
  internals.socket = { isOpen: () => true, close };
  internals.startupPhonePlayerId = startupId;
  internals.startupPhase = vi.fn();
  internals.haMassCommand = vi.fn(async (command: string) => command === "players/get" ? phone : queue);
  internals.loadHomeAssistantConfigEntry = vi.fn(async () => {});
  internals.discoverHaPlayerEntityIds = vi.fn(async () => ["media_player.move"]);
  internals.haRequestWithPending = vi.fn(async () => null);
  internals.refreshHaTrackedStates = vi.fn(async () => {});
  internals.haQueues = vi.fn(async () => []);
  internals.haLibrary = vi.fn(async () => []);
  return { client, internals, close };
}

describe("safe HA companion-first startup", () => {
  it("makes the verified phone and its own queue ready without awaiting home speakers", async () => {
    const { client, internals } = setup();
    await internals.finishHomeAssistantConnect();
    expect(client.takeStartupSnapshot()).toEqual({ players: [phone], queues: [queue] });
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.loadHomeAssistantConfigEntry).not.toHaveBeenCalled();
    expect(internals.discoverHaPlayerEntityIds).not.toHaveBeenCalled();
    expect(internals.haMassCommand.mock.calls).toEqual([["players/get", { player_id: id }], ["player_queues/get", { queue_id: id }]]);
    expect(internals.startupPhase).toHaveBeenCalledWith("phone_snapshot_ready");
  });

  it("retains the normal startup sequence when no fast-path target is provided", async () => {
    const { client, internals } = setup(undefined);
    internals.startupPhonePlayerId = undefined;
    await internals.finishHomeAssistantConnect();
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.haMassCommand).not.toHaveBeenCalled();
    expect(internals.loadHomeAssistantConfigEntry).toHaveBeenCalledOnce();
    expect(internals.discoverHaPlayerEntityIds).toHaveBeenCalledOnce();
    expect(internals.haRequestWithPending).toHaveBeenCalledWith("subscribe_entities", { entity_ids: ["media_player.move"] }, "entities");
  });

  it.each([null, { ...phone, player_id: "another-phone" }, { ...phone, device_info: { manufacturer: "Another app" } }])("falls back to normal startup for an unverified target: %j", async player => {
    const { client, internals } = setup();
    internals.haMassCommand.mockResolvedValue(player);
    await internals.finishHomeAssistantConnect();
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.loadHomeAssistantConfigEntry).toHaveBeenCalledOnce();
    expect(internals.haMassCommand).toHaveBeenCalledOnce();
  });

  it("does not make an optional native-API failure break existing HA startup", async () => {
    const { client, internals } = setup();
    internals.haMassCommand.mockRejectedValue(new Error("Ingress not permitted"));
    await internals.finishHomeAssistantConnect();
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.haStatesReady).toBe(true);
  });

  it("bounds optional fast lookup and ignores a successful response arriving after fallback", async () => {
    const { client, internals } = setup();
    let reply!: (value: Player) => void;
    internals.haMassCommand.mockImplementationOnce(() => new Promise<Player>(resolve => { reply = resolve; }));
    const connecting = internals.finishHomeAssistantConnect();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(internals.loadHomeAssistantConfigEntry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await connecting;
    expect(internals.haStatesReady).toBe(true);
    expect(client.takeStartupSnapshot()).toBeUndefined();
    reply(phone); await vi.advanceTimersByTimeAsync(0);
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.startupPhase).not.toHaveBeenCalledWith("phone_snapshot_ready");
    expect(internals.haMassCommand).toHaveBeenCalledOnce();
  });

  it("retains an unavailable assigned phone without substituting a home speaker", async () => {
    const { client, internals } = setup();
    internals.haMassCommand.mockResolvedValue({ ...phone, available: false });
    await internals.finishHomeAssistantConnect();
    expect(client.takeStartupSnapshot()).toEqual({ players: [{ ...phone, available: false }], queues: [] });
    expect(internals.loadHomeAssistantConfigEntry).not.toHaveBeenCalled();
    expect(internals.haMassCommand).toHaveBeenCalledOnce();
  });

  it("never accepts a foreign queue as the phone's startup queue", async () => {
    const { client, internals } = setup();
    internals.haMassCommand.mockImplementation(async (command: string) => command === "players/get" ? phone : { ...queue, queue_id: "home" });
    await internals.finishHomeAssistantConnect();
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.loadHomeAssistantConfigEntry).toHaveBeenCalledOnce();
  });

  it("does not hydrate or resubscribe all home queues during phone-priority polling", async () => {
    const { client, internals } = setup();
    await internals.finishHomeAssistantConnect(); client.takeStartupSnapshot();
    expect(await client.command("players/all")).toEqual([phone]);
    expect(await client.command("player_queues/all")).toEqual([queue]);
    expect(internals.refreshHaTrackedStates).not.toHaveBeenCalled();
    expect(internals.haQueues).not.toHaveBeenCalled();
    expect(internals.loadHomeAssistantConfigEntry).not.toHaveBeenCalled();
  });

  it("loads home state in the background without interrupting the ready phone", async () => {
    const { client, internals, close } = setup();
    await internals.finishHomeAssistantConnect(); client.takeStartupSnapshot();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(internals.haStatesReady).toBe(true);
    expect(internals.startupPhase).toHaveBeenCalledWith("home_players_ready");
    expect(close).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(true);
  });

  it("keeps phone controls usable if background home loading fails and retries later", async () => {
    const { client, internals, close } = setup();
    internals.discoverHaPlayerEntityIds.mockRejectedValueOnce(new Error("Home state temporarily unavailable"));
    await internals.finishHomeAssistantConnect(); client.takeStartupSnapshot();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(internals.startupPhase).toHaveBeenCalledWith("home_warmup_failed");
    expect(client.isConnected()).toBe(true);
    expect(await client.command("player_queues/all")).toEqual([queue]);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(internals.haStatesReady).toBe(true);
  });

  it("restores normal speaker and queue loading when the user selects a home speaker", async () => {
    const { client, internals } = setup();
    await internals.finishHomeAssistantConnect(); client.takeStartupSnapshot();
    client.prioritizePhonePlayer(undefined);
    await client.command("players/all"); await client.command("player_queues/all");
    expect(internals.loadHomeAssistantConfigEntry).toHaveBeenCalledOnce();
    expect(internals.refreshHaTrackedStates).toHaveBeenCalledTimes(2);
    expect(internals.haQueues).toHaveBeenCalledOnce();
  });

  it("initializes the standard HA library path on demand", async () => {
    const { client, internals } = setup();
    await internals.finishHomeAssistantConnect(); client.takeStartupSnapshot();
    await client.command("music/playlists/library_items");
    expect(internals.haStatesReady).toBe(true);
    expect(internals.haLibrary).toHaveBeenCalledWith("music/playlists/library_items", undefined);
  });

  it("discards a phone response from a replaced connection", async () => {
    const { client, internals } = setup();
    internals.haMassCommand.mockImplementation(async () => { client.disconnect(); return phone; });
    await expect(internals.finishHomeAssistantConnect()).rejects.toThrow("Connection replaced");
    expect(client.takeStartupSnapshot()).toBeUndefined();
    expect(internals.loadHomeAssistantConfigEntry).not.toHaveBeenCalled();
  });

  it("cancels deferred warming on disconnect", async () => {
    const { client, internals } = setup();
    await internals.finishHomeAssistantConnect(); client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(internals.loadHomeAssistantConfigEntry).not.toHaveBeenCalled();
    expect(client.takeStartupSnapshot()).toBeUndefined();
  });
});
