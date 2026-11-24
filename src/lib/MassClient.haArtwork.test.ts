import { beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import { REMOTE_ARTWORK_BASE } from "./remoteArtwork";
import type { PlayerQueue } from "../types";

const bridge = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  net = { fetch: bridge.fetch };
  close = bridge.close;
} }));
const origin = "https://ha.example.invalid";
const picture = "/api/media_player_proxy/media_player.phone?token=test-picture-token&cache=track-1";
const state = () => ({ entity_id: "media_player.phone", state: "playing", attributes: {
  friendly_name: "Phone", mass_player_type: "player", media_title: "Track", media_artist: "Artist",
  entity_picture: "https://cdn.example.invalid/cover.jpg", entity_picture_local: picture,
} });
function setup() {
  const client = new MassClient();
  const internals = client as unknown as {
    protocol: string; haBaseUrl: string; haIngress?: unknown;
    haStates: Map<string, unknown>; refreshHaTrackedStates: () => Promise<void>;
    fetchHaCompanionArtwork: (path: string) => Promise<Blob>;
    haMediaIdentityChanged: (previous: unknown, next: unknown) => boolean;
  };
  internals.protocol = "ha"; internals.haBaseUrl = origin;
  internals.refreshHaTrackedStates = vi.fn(async () => {});
  internals.haStates.set("media_player.phone", state());
  return { client, internals };
}
beforeEach(() => {
  vi.clearAllMocks();
  bridge.fetch.mockResolvedValue({ ok: true, response: { response: {
    status: 200, body: new Uint8Array([1, 2, 3]), headers: [{ name: "Content-Type", value: "image/jpeg" }],
  } } });
});

describe("HA now-playing artwork", () => {
  it("keeps the exact SiriusXM asset but routes it through the phone using the valid host", async () => {
    const { client, internals } = setup();
    const source = "https://pri.art.prod.streaming.siriusxm.com/covers/current.png?size=300";
    internals.haStates.set("media_player.phone", { ...state(), attributes: { ...state().attributes, entity_picture: source } });
    const queue = await client.command<PlayerQueue>("player_queues/get", { queue_id: "media_player.phone" });
    const image = new URL(queue.current_item!.image!.url!);
    expect(image.origin).toBe(REMOTE_ARTWORK_BASE);
    expect(image.pathname).toBe("/siriusxm-artwork");
    expect(image.searchParams.get("url")).toBe("https://albumart.siriusxm.com/covers/current.png?size=300");
    await internals.fetchHaCompanionArtwork(image.pathname + image.search + "&v=track");
    expect(bridge.fetch.mock.calls[0][0].request).toMatchObject({
      url: "https://albumart.siriusxm.com/covers/current.png?size=300", headers: [], redirect: "error",
    });
  });

  it.each([
    "https://evil.example/cover.jpg", "https://albumart.siriusxm.com.evil.example/cover.jpg",
    "https://user:secret@albumart.siriusxm.com/cover.jpg", "https://albumart.siriusxm.com:8443/cover.jpg",
  ])("rejects forged SiriusXM artwork destinations: %s", async url => {
    const { internals } = setup();
    await expect(internals.fetchHaCompanionArtwork("/siriusxm-artwork?url=" + encodeURIComponent(url))).rejects.toThrow("Invalid Music Assistant artwork path");
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("uses HA's signed local cover rather than the external CDN", async () => {
    const { client } = setup();
    const queue = await client.command<PlayerQueue>("player_queues/get", { queue_id: "media_player.phone" });
    expect(queue.current_item?.name).toBe("Track");
    expect(queue.current_item?.image?.url).toBe(`${REMOTE_ARTWORK_BASE}/ha-media-player-proxy/media_player.phone?token=test-picture-token&cache=track-1`);
    expect(queue.current_item?.media_item?.image).toEqual(queue.current_item?.image);
  });

  it("fetches the signed image only from the HA origin without account credentials", async () => {
    const { internals } = setup();
    const blob = await internals.fetchHaCompanionArtwork("/ha-media-player-proxy/media_player.phone?token=test-picture-token&cache=track-1&v=track");
    expect(blob.size).toBe(3);
    expect(bridge.fetch.mock.calls[0][0].request).toMatchObject({
      url: `${origin}${picture}&v=track`, headers: [], method: "GET", redirect: "error",
    });
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it("does not let a signed-picture rejection invalidate MA ingress", async () => {
    const { internals } = setup();
    const ingress = { session: "test-ingress" };
    internals.haIngress = ingress;
    bridge.fetch.mockResolvedValueOnce({ ok: true, response: { response: { status: 403, body: new Uint8Array() } } });
    await expect(internals.fetchHaCompanionArtwork("/ha-media-player-proxy/media_player.phone?token=expired")).rejects.toThrow("403");
    expect(internals.haIngress).toBe(ingress);
  });

  it.each([
    "https://evil.example/ha-media-player-proxy/media_player.phone?token=test",
    "/ha-media-player-proxy/../../auth/token",
    "/ha-media-player-proxy/media_player.phone/extra",
    "/ha-media-player-proxy/sensor.phone",
    "/ha-media-player-proxy/media_player.phone#fragment",
  ])("rejects untrusted proxy paths: %s", async path => {
    const { internals } = setup();
    await expect(internals.fetchHaCompanionArtwork(path)).rejects.toThrow("Invalid Music Assistant artwork path");
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("does not mistake another origin's proxy URL for a signed HA image", async () => {
    const { client, internals } = setup();
    internals.haStates.set("media_player.phone", { ...state(), attributes: { ...state().attributes,
      entity_picture_local: "https://external.example/api/media_player_proxy/media_player.phone?token=external",
    } });
    const queue = await client.command<PlayerQueue>("player_queues/get", { queue_id: "media_player.phone" });
    expect(queue.current_item?.image?.url).toMatch(/^https:\/\/external\.example\//);
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("keeps legacy external pictures when no signed local picture is available", async () => {
    const { client, internals } = setup();
    internals.haStates.set("media_player.phone", { ...state(), attributes: { ...state().attributes, entity_picture_local: undefined } });
    const queue = await client.command<PlayerQueue>("player_queues/get", { queue_id: "media_player.phone" });
    expect(queue.current_item?.image?.url).toBe("https://cdn.example.invalid/cover.jpg");
  });

  it("recognizes a changed local picture signature even if external metadata is unchanged", () => {
    const { internals } = setup();
    const previous = state(), next = state();
    next.attributes.entity_picture_local += "-new";
    expect(internals.haMediaIdentityChanged(previous, next)).toBe(true);
  });

  it("discards a late image after its connection was replaced", async () => {
    const { client, internals } = setup();
    bridge.fetch.mockImplementationOnce(async () => {
      client.disconnect();
      return { ok: true, response: { response: { status: 200, body: new Uint8Array([1]) } } };
    });
    await expect(internals.fetchHaCompanionArtwork("/ha-media-player-proxy/media_player.phone?token=test")).rejects.toThrow("Artwork connection replaced");
    expect(bridge.close).toHaveBeenCalledOnce();
  });
});
