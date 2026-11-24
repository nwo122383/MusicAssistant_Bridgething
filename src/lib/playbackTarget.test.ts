import { describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import type { Player } from "../types";

const phone: Player = { player_id: "phone", name: "Phone", available: true, powered: true, volume_level: 20 };
function setup(player: Player | null, queue: { queue_id: string } | null = { queue_id: "phone" }) {
  const client = new MassClient();
  const command = vi.fn(async (name: string) => name === "players/get" ? player : queue);
  client.command = command as typeof client.command;
  return { client, command };
}

describe("fresh playback targeting", () => {
  it("checks the selected player and its own queue before playback", async () => {
    const { client, command } = setup(phone);
    expect(await client.getPlaybackTarget("phone", "phone")).toEqual({ player: phone, queueId: "phone" });
    expect(command.mock.calls).toEqual([["players/get", { player_id: "phone" }], ["player_queues/get", { queue_id: "phone" }]]);
  });

  it.each([null, { ...phone, available: false }, { ...phone, player_id: "home" }])("does not substitute a missing phone: %j", async player => {
    const { client, command } = setup(player);
    await expect(client.getPlaybackTarget("phone", "phone")).rejects.toThrow("Waiting for phone audio");
    expect(command).toHaveBeenCalledOnce();
  });

  it.each([
    { synced_to: "home" }, { active_group: "home" }, { group_members: ["phone", "home"] }, { group_childs: ["home"] },
  ])("does not send phone playback to a home group: %j", async patch => {
    const { client } = setup({ ...phone, ...patch });
    await expect(client.getPlaybackTarget("phone", "phone")).rejects.toThrow("Ungroup the phone");
  });

  it("never falls back to the phone's old active source", async () => {
    const { client } = setup({ ...phone, active_source: "home" }, null);
    await expect(client.getPlaybackTarget("phone", "phone")).rejects.toThrow("Waiting for phone audio");
  });

  it("allows a standalone phone with self-only group metadata", async () => {
    const { client } = setup({ ...phone, group_members: ["phone"], active_group: "phone" });
    expect((await client.getPlaybackTarget("phone", "phone")).queueId).toBe("phone");
  });

  it("preserves explicit home/group selection and refreshes its active source", async () => {
    const { client } = setup({ ...phone, player_id: "dining", active_source: "group" }, null);
    expect((await client.getPlaybackTarget("dining", "phone")).queueId).toBe("group");
  });

  it("rejects a target read across a connection change", async () => {
    const { client, command } = setup(phone);
    command.mockImplementationOnce(async () => { client.disconnect(); return phone; });
    await expect(client.getPlaybackTarget("phone", "phone")).rejects.toThrow("connection changed");
  });

  it("supports a fresh Home Assistant entity lookup without native ID confusion", async () => {
    const client = new MassClient();
    const internals = client as unknown as { protocol: string; refreshHaTrackedStates: () => Promise<void>; haStates: Map<string, unknown> };
    internals.protocol = "ha";
    internals.refreshHaTrackedStates = vi.fn(async () => {});
    internals.haStates.set("media_player.phone", { entity_id: "media_player.phone", state: "idle", attributes: {
      friendly_name: "Phone", volume_level: 0.2, mass_player_type: "player",
    } });
    const target = await client.getPlaybackTarget("media_player.phone", "media_player.phone");
    expect(target.player.player_id).toBe("media_player.phone");
    expect(target.queueId).toBe("media_player.phone");
    await expect(client.getPlaybackTarget("missing", "")).rejects.toThrow("unavailable");
  });
});
