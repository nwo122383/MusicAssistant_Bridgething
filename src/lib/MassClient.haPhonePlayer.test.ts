import { beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import type { Player, PlayerQueue } from "../types";
import { REMOTE_ARTWORK_BASE } from "./remoteArtwork";

const bridge = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  net = { fetch: bridge.fetch };
  close = bridge.close;
} }));
beforeEach(() => vi.clearAllMocks());

const phone: Player = { player_id: "stable-phone", name: "CarThing Phone", available: true, powered: true, volume_level: 0,
  provider: "sendspin", device_info: { model: "Mobile Application", manufacturer: "MusicAssistant_Bridgething" } };
const queue: PlayerQueue = { queue_id: phone.player_id, display_name: phone.name, active: true, state: "playing", elapsed_time: 10, elapsed_time_last_updated: 1 };

function setup() {
  const client = new MassClient();
  const internals = client as unknown as {
    protocol: string; refreshHaTrackedStates: () => Promise<void>; haMassCommand: ReturnType<typeof vi.fn>;
    haCompanionPlayers: Player[]; haCompanionPlayersAt: number; getHaPlayerEntityMap: () => Promise<Map<string, string>>;
  };
  internals.protocol = "ha";
  internals.refreshHaTrackedStates = vi.fn(async () => {});
  internals.getHaPlayerEntityMap = vi.fn(async () => new Map());
  internals.haMassCommand = vi.fn(async (command: string) => {
    if (command === "players/all") return [phone, { ...phone, player_id: "other", device_info: { manufacturer: "Other" } }];
    if (command === "players/get") return phone;
    if (command === "player_queues/get") return queue;
    return null;
  });
  return { client, internals, native: internals.haMassCommand };
}

describe("HA Cloud companion phone players", () => {
  it("does not add ingress requests to ordinary HA-only refreshes", async () => {
    const { client, native } = setup();
    expect(await client.command("players/all")).toEqual([]);
    expect(await client.command("player_queues/all")).toEqual([]);
    expect(native).not.toHaveBeenCalled();
  });

  it("discovers the companion without requiring an HA media-player entity", async () => {
    const { client, native } = setup(); client.enablePhonePlayerDiscovery();
    const [players, queues] = await Promise.all([client.command("players/all"), client.command("player_queues/all")]);
    expect(players).toEqual([phone]); expect(queues).toEqual([queue]);
    expect(native.mock.calls.filter(([c]) => c === "players/all")).toHaveLength(1);
  });

  it("makes the native phone selectable in the speaker selector", async () => {
    const { client } = setup();
    expect((await client.getGroupPlayers()).find(p => p.player_id === phone.player_id)?.playback_player_id).toBe(phone.player_id);
    expect(await client.command("players/all")).toEqual([phone]);
  });

  it("routes phone controls and queues to MA using exactly the phone ID", async () => {
    const { client, native } = setup(); client.enablePhonePlayerDiscovery();
    await client.command("players/all");
    await client.command("players/cmd/pause", { player_id: phone.player_id });
    await client.command("player_queues/play_media", { queue_id: phone.player_id, media: "library://track/1", option: "replace" });
    expect(native).toHaveBeenCalledWith("players/cmd/pause", { player_id: phone.player_id });
    expect(native).toHaveBeenCalledWith("player_queues/play_media", { queue_id: phone.player_id, media: "library://track/1", option: "replace" });
  });

  it("does not redirect an unknown native player to another speaker", async () => {
    const { client, native } = setup(); client.enablePhonePlayerDiscovery(); await client.command("players/all");
    native.mockClear();
    await expect(client.command("player_queues/play_media", { queue_id: "living-room", media: "library://track/1" })).rejects.toThrow("Waiting for phone audio");
    await expect(client.getPlaybackTarget("missing", "missing")).rejects.toThrow("Waiting for phone audio");
    expect(native).not.toHaveBeenCalled();
  });

  it("checks fresh phone availability rather than cached discovery", async () => {
    const { client, native } = setup(); client.enablePhonePlayerDiscovery(); await client.command("players/all");
    native.mockImplementation(async () => ({ ...phone, available: false }));
    await expect(client.getPlaybackTarget(phone.player_id, phone.player_id)).rejects.toThrow("Waiting for phone audio");
  });

  it("removes stale readiness when discovery fails without breaking HA refresh", async () => {
    const { client, internals, native } = setup(); client.enablePhonePlayerDiscovery(); await client.command("players/all");
    internals.haCompanionPlayersAt = 0;
    native.mockRejectedValue(new Error("Ingress offline"));
    expect(await client.command("players/all")).toEqual([{ ...phone, available: false }]);
  });

  it("does not carry a discovery response across a connection change", async () => {
    const { client, native } = setup(); client.enablePhonePlayerDiscovery();
    native.mockImplementation(async () => { client.disconnect(); return [phone]; });
    expect(await client.command("players/all")).toEqual([]);
  });

  it("refreshes an assigned phone by ID without repeatedly downloading every home player", async () => {
    const { client, native } = setup();
    client.enablePhonePlayerDiscovery(phone.player_id);
    expect(await client.command("players/all")).toEqual([phone]);
    expect(native).toHaveBeenCalledWith("players/get", { player_id: phone.player_id });
    expect(native.mock.calls.some(([command]) => command === "players/all")).toBe(false);
  });

  it("routes native queue artwork through MA rather than the HA root without changing song details", async () => {
    const { client, native } = setup(); client.enablePhonePlayerDiscovery(); await client.command("players/all");
    const item = { queue_item_id: "track", name: "Track", image: { path: "cover.jpg", provider: "library" },
      media_item: { uri: "library://track/1", name: "Track", item_id: "1", provider: "library", media_type: "track",
        artists: [{ name: "Artist" }], metadata: { images: [{ path: "cover.jpg", provider: "library" }] } } };
    native.mockImplementation(async (command: string) => command === "players/get" ? phone : { ...queue, current_item: item });
    const result = await client.command<PlayerQueue>("player_queues/get", { queue_id: phone.player_id });
    expect(result.current_item?.media_item?.name).toBe("Track");
    expect(result.current_item?.media_item?.artists).toEqual([{ name: "Artist" }]);
    expect(result.current_item?.image?.url).toMatch(new RegExp(`^${REMOTE_ARTWORK_BASE}/imageproxy\\?`));
    expect(result.current_item?.media_item?.metadata?.images?.[0].url).toContain("provider=library");
    expect(item.image.path).toBe("cover.jpg");
  });

  it("authenticates artwork requests only within the configured HA ingress route", async () => {
    const { client } = setup();
    const internals = client as unknown as { haBaseUrl: string; haIngress: unknown; fetchHaCompanionArtwork: (path: string) => Promise<Blob> };
    internals.haBaseUrl = "https://ha.example.com";
    internals.haIngress = { url: "https://ha.example.com/api/hassio_ingress/addon/api", session: "private-session", expires: Date.now() + 60_000 };
    bridge.fetch.mockResolvedValue({ ok: true, response: { response: { status: 200, body: new Uint8Array([1, 2, 3]) } } });
    const blob = await internals.fetchHaCompanionArtwork("/imageproxy?path=cover&provider=library");
    expect(blob.size).toBe(3);
    const request = bridge.fetch.mock.calls[0][0].request;
    expect(request.url).toBe("https://ha.example.com/api/hassio_ingress/addon/imageproxy?path=cover&provider=library");
    expect(request.headers).toEqual([{ name: "Cookie", value: "ingress_session=private-session" }]);
    expect(request.url).not.toContain("private-session");
    expect(request.redirect).toBe("error");
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it.each(["https://evil.example/imageproxy", "/api/token", "/imageproxy/../../auth/token", "/imageproxy#fragment"])("rejects untrusted artwork paths: %s", async path => {
    const { client } = setup();
    await expect((client as unknown as { fetchHaCompanionArtwork: (path: string) => Promise<Blob> }).fetchHaCompanionArtwork(path)).rejects.toThrow("Invalid Music Assistant artwork path");
    expect(bridge.fetch).not.toHaveBeenCalled();
  });
});
