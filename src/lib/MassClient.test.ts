import { describe, expect, it } from "vitest";
import { MassClient } from "./MassClient";
import type { PlayerQueue } from "../types";

type MassClientInternals = {
  onEvent(listener: (event: { event: string; object_id?: string; data?: unknown }) => void): () => void;
  emitHydratedHaQueue(entityId: string): Promise<void>;
  haStateToQueue(state: unknown): PlayerQueue;
  mergeHaQueueState(queueId: string, base: PlayerQueue): PlayerQueue;
  hydrateHaQueue(queue: PlayerQueue): Promise<PlayerQueue>;
  haStates: Map<string, unknown>;
  haHydratedQueues: Map<string, PlayerQueue>;
};

describe("Home Assistant queue merging", () => {
  it("keeps live radio track metadata over a hydrated station item", () => {
    const client = new MassClient() as unknown as MassClientInternals;
    const queueId = "media_player.living_room_move_2";
    const base = client.haStateToQueue({
      entity_id: queueId,
      state: "playing",
      attributes: {
        friendly_name: "Move_MA",
        media_title: "Fly Away",
        media_artist: "Peter Allen",
        media_album_name: "Yacht Rock Radio",
        media_content_id: "library://radio/3",
        media_content_type: "music",
        entity_picture: "/api/media_player_proxy/media_player.living_room_move_2?token=abc",
      },
    });

    client.haHydratedQueues.set(queueId, {
      ...base,
      current_item: {
        queue_item_id: "library://radio/3",
        name: "Yacht Rock Radio",
        media_item: {
          uri: "library://radio/3",
          item_id: "library://radio/3",
          provider: "music_assistant",
          name: "Yacht Rock Radio",
          media_type: "radio",
          artists: [{ name: "radio" }],
        },
      },
    });

    const merged = client.mergeHaQueueState(queueId, base);

    expect(merged.current_item?.name).toBe("Fly Away");
    expect(merged.current_item?.media_item?.artists?.[0]?.name).toBe("Peter Allen");
    expect(merged.current_item?.media_item?.album?.name).toBe("Yacht Rock Radio");
    expect(merged.current_item?.media_item?.image?.provider).toBe("home_assistant");
  });

  it("emits merged live radio metadata after async hydration", async () => {
    const client = new MassClient() as unknown as MassClientInternals;
    const queueId = "media_player.living_room_move_2";
    const state = {
      entity_id: queueId,
      state: "playing",
      attributes: {
        friendly_name: "Move_MA",
        media_title: "Fly Away",
        media_artist: "Peter Allen",
        media_album_name: "Yacht Rock Radio",
        media_content_id: "library://radio/3",
        media_content_type: "music",
      },
    };
    const base = client.haStateToQueue(state);
    client.haStates.set(queueId, state);
    client.hydrateHaQueue = async () => ({
      ...base,
      current_item: {
        queue_item_id: "library://radio/3",
        name: "Yacht Rock Radio",
        media_item: {
          uri: "library://radio/3",
          item_id: "library://radio/3",
          provider: "music_assistant",
          name: "Yacht Rock Radio",
          media_type: "radio",
          artists: [{ name: "radio" }],
        },
      },
    });
    const events: Array<{ event: string; object_id?: string; data?: unknown }> = [];
    client.onEvent((event) => events.push(event));

    await client.emitHydratedHaQueue(queueId);

    const queueEvent = events.find((event) => event.event === "queue_updated");
    expect((queueEvent?.data as PlayerQueue | undefined)?.current_item?.name).toBe("Fly Away");
  });
});
