import { beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock("@bridgething/client", () => ({
  BridgethingClient: class {
    net = { fetch: mocks.fetch };
    close = mocks.close;
  },
}));

type Internals = {
  protocol: string;
  haBaseUrl: string;
  haRequest: ReturnType<typeof vi.fn>;
  getHaQueue: ReturnType<typeof vi.fn>;
};

describe("AI Radio through Home Assistant ingress", () => {
  let client: MassClient;
  let internal: Internals;
  beforeEach(() => {
    vi.clearAllMocks();
    client = new MassClient();
    internal = client as unknown as Internals;
    internal.protocol = "ha";
    internal.haBaseUrl = "https://ha.example.com";
    internal.haRequest = vi.fn(async (type, args) => {
      if (type === "get_panels") return { ma: { title: "Music Assistant", config: { addon: "example_music_assistant" } } };
      if (args.endpoint.endsWith("/info")) return { ingress_url: "/api/hassio_ingress/example" };
      return { session: "test-session" };
    });
    internal.getHaQueue = vi.fn(async () => ({ "media_player.move": { queue_id: "ma-move" } }));
    mocks.fetch.mockResolvedValue({ ok: true, response: { response: {
      status: 200, body: new TextEncoder().encode(JSON.stringify([{ id: "blues", name: "Blues radio" }])),
    } } });
  });

  it("lists shows through the companion with an ingress cookie and caches the session", async () => {
    expect(await client.command("ai_radio/stations/list")).toEqual([{ id: "blues", name: "Blues radio" }]);
    await client.command("ai_radio/stations/list");
    expect(internal.haRequest).toHaveBeenCalledTimes(3);
    const { request } = mocks.fetch.mock.calls[0][0];
    expect(request.url).toBe("https://ha.example.com/api/hassio_ingress/example/api");
    expect(request.headers).toContainEqual({ name: "Cookie", value: "ingress_session=test-session" });
    expect(request.redirect).toBe("error");
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it("resolves the selected HA entity to MA's player ID before starting a show", async () => {
    await client.command("ai_radio/start", { station_id: "blues", player_id_override: "media_player.move" });
    const body = JSON.parse(new TextDecoder().decode(mocks.fetch.mock.calls[0][0].request.body));
    expect(body.args).toEqual({ station_id: "blues", player_id_override: "ma-move" });
  });

  it("refuses to start on an unresolved player", async () => {
    internal.getHaQueue.mockResolvedValue({});
    await expect(client.command("ai_radio/start", { station_id: "blues", player_id_override: "media_player.move" })).rejects.toThrow("resolve");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not forward ingress cookies to another origin", async () => {
    internal.haRequest.mockImplementation(async (type, args) => type === "get_panels"
      ? { ma: { config: { addon: "example_music_assistant" } } }
      : args.endpoint.endsWith("/info") ? { ingress_url: "https://other.example.com/api/hassio_ingress/example" } : { session: "test-session" });
    await expect(client.command("ai_radio/stations/list")).rejects.toThrow("Invalid");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reports HTTP errors and closes the companion client", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, response: { response: { status: 403, body: new Uint8Array() } } });
    await expect(client.command("ai_radio/stations/list")).rejects.toThrow("403");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("keeps native grouping IDs while mapping selectable players to their HA entities", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, response: { response: {
      status: 200, body: new TextEncoder().encode(JSON.stringify([
        { player_id: "move", name: "Move", available: true },
        { player_id: "hidden", name: "Hidden", available: false, synced_to: "move" },
      ])),
    } } });
    const baseRequest = internal.haRequest.getMockImplementation() as (type: string, args?: Record<string, unknown>) => Promise<unknown>;
    internal.haRequest.mockImplementation(async (type, args) => type === "config/entity_registry/list"
      ? [{ entity_id: "media_player.move", unique_id: "move", platform: "music_assistant" }]
      : baseRequest(type, args));
    const players = await client.getGroupPlayers();
    expect(players[0]).toMatchObject({ player_id: "move", playback_player_id: "media_player.move" });
    expect(players[1]).toMatchObject({ player_id: "hidden", available: false, synced_to: "move" });
    expect(players[1].playback_player_id).toBeUndefined();
    const requestBody = JSON.parse(new TextDecoder().decode(mocks.fetch.mock.calls[0][0].request.body));
    expect(requestBody).toMatchObject({ command: "players/all", args: { return_unavailable: true, return_disabled: true } });
  });
});
