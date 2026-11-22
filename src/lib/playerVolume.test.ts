import { describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import { stepVolumeTarget } from "./playerVolume";
import type { GroupPlayer, Player } from "../types";

const speaker = (id: string, patch: Partial<GroupPlayer> = {}): GroupPlayer => ({
  player_id: id, name: id, available: true, powered: true, volume_level: 20, ...patch,
});
type Internals = {
  protocol: string;
  haRequest: ReturnType<typeof vi.fn>;
  haMassCommand: ReturnType<typeof vi.fn>;
  haStateToPlayer(state: unknown): Player;
};

function setup(players: GroupPlayer[], ha = false) {
  const client = new MassClient();
  const internal = client as unknown as Internals;
  internal.haRequest = vi.fn(async () => [
    { entity_id: "media_player.move", unique_id: "move", platform: "music_assistant" },
    { entity_id: "media_player.dining", unique_id: "dining", platform: "music_assistant" },
  ]);
  const command = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    const player = players.find(p => p.player_id === args?.player_id);
    if (name === "players/get") return player ? structuredClone(player) : null;
    if (name === "players/cmd/volume_set" && player) player.volume_level = Number(args?.volume_level);
    return undefined;
  });
  if (ha) { internal.protocol = "ha"; internal.haMassCommand = command; }
  else client.command = command as typeof client.command;
  return { client, internal, command };
}

describe("playback group volume", () => {
  it("uses the group's level rather than the leader's individual volume", async () => {
    const move = speaker("move", { group_members: ["move", "dining"], group_volume: 45 });
    const { client, command } = setup([move, speaker("dining", { volume_level: 45 })]);
    const target = await client.getVolumeTarget(move);
    expect(target).toMatchObject({ playerId: "move", level: 45, grouped: true });
    await client.setVolume(target, 47);
    expect(command).toHaveBeenCalledWith("players/cmd/volume_set", { player_id: "move", volume_level: 22 });
    expect(command).toHaveBeenCalledWith("players/cmd/volume_set", { player_id: "dining", volume_level: 47 });
    expect(command.mock.calls.some(([name]) => name === "players/cmd/group_volume")).toBe(false);
  });

  it.each(["synced_to", "active_group"] as const)("resolves a member's %s before reading or adjusting group volume", async key => {
    const dining = speaker("dining", { [key]: "move", volume_level: 10 });
    const { client, command } = setup([dining, speaker("move", { group_members: ["dining"], group_volume: 35, volume_level: 35 })]);
    const target = await client.getVolumeTarget(dining);
    expect(target).toMatchObject({ playerId: "move", level: 35, grouped: true });
    await client.setVolume(target, 33);
    expect(command).toHaveBeenCalledWith("players/cmd/volume_set", { player_id: "move", volume_level: 33 });
    expect(command).toHaveBeenCalledWith("players/cmd/volume_set", { player_id: "dining", volume_level: 8 });
  });

  it("keeps standalone speaker volume individual and clamps the range", async () => {
    const move = speaker("move", { group_members: ["move"] });
    const { client, command } = setup([move]);
    const target = await client.getVolumeTarget(move);
    expect(target.grouped).toBe(false);
    await client.setVolume(target, 102);
    expect(command).toHaveBeenLastCalledWith("players/cmd/volume_set", { player_id: "move", volume_level: 100 });
    await client.setVolume(target, -2);
    expect(command).toHaveBeenLastCalledWith("players/cmd/volume_set", { player_id: "move", volume_level: 0 });
  });

  it("supports virtual group players and zero group volume", async () => {
    const group = speaker("group", { type: "group", group_members: ["move", "dining"], group_volume: 0, powered: false, state: "idle" });
    const { client } = setup([group, speaker("move", { volume_level: 0 }), speaker("dining", { volume_level: 0 })]);
    expect(await client.getVolumeTarget(group)).toMatchObject({ grouped: true, level: 0 });
  });

  it("derives group volume from the members when the aggregate field is unavailable", async () => {
    const move = speaker("move", { group_members: ["dining"], group_volume: null });
    const { client } = setup([move, speaker("dining", { volume_level: 35 })]);
    expect(await client.getVolumeTarget(move)).toMatchObject({ level: 35, grouped: true });
  });

  it("rejects missing group leaders, cycles and unavailable speakers", async () => {
    for (const players of [
      [speaker("move", { synced_to: "missing" })],
      [speaker("move", { synced_to: "dining" }), speaker("dining", { synced_to: "move" })],
      [speaker("move", { available: false })],
    ]) {
      const { client } = setup(players);
      await expect(client.getVolumeTarget(players[0])).rejects.toThrow();
    }
  });

  it("maps an HA member to its MA ID and uses ingress for group volume", async () => {
    const { client, internal, command } = setup([
      speaker("move", { group_members: ["dining"], group_volume: 40, volume_level: 40 }), speaker("dining", { synced_to: "move" }),
    ], true);
    const selected = internal.haStateToPlayer({ entity_id: "media_player.dining", state: "playing", attributes: {
      volume_level: 0.2, mass_player_type: "player", group_members: ["media_player.move", "media_player.dining"],
    } });
    const target = await client.getVolumeTarget(selected);
    expect(target).toMatchObject({ playerId: "move", level: 40, grouped: true, route: "native" });
    await client.setVolume(target, 42);
    expect(command).toHaveBeenCalledWith("players/cmd/volume_set", { player_id: "move", volume_level: 42 });
    expect(command).toHaveBeenCalledWith("players/cmd/volume_set", { player_id: "dining", volume_level: 22 });
    expect(internal.haRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps HA standalone volume on the existing service without ingress access", async () => {
    const { client, internal, command } = setup([], true);
    const target = await client.getVolumeTarget(speaker("media_player.move"));
    await client.setVolume(target, 22);
    expect(command).not.toHaveBeenCalled();
    expect(internal.haRequest).toHaveBeenCalledWith("call_service", expect.objectContaining({
      domain: "media_player", service: "volume_set", target: { entity_id: "media_player.move" }, service_data: { volume_level: 0.22 },
    }));
  });

  it("supports legacy mass_ registry IDs without guessing another speaker", async () => {
    const move = speaker("move", { group_members: ["dining"], group_volume: 25, volume_level: 25 });
    const { client, internal } = setup([move, speaker("dining")], true);
    internal.haRequest.mockResolvedValue([{ entity_id: "media_player.move", unique_id: "mass_move", platform: "music_assistant" }]);
    expect(await client.getVolumeTarget({ ...move, player_id: "media_player.move" })).toMatchObject({ playerId: "move", level: 25 });
  });

  it("rejects stale targets after a connection change", async () => {
    const move = speaker("move");
    const { client, command } = setup([move]);
    const target = await client.getVolumeTarget(move);
    client.disconnect();
    await expect(client.setVolume(target, 25)).rejects.toThrow(/connection changed/);
    expect(command).toHaveBeenCalledTimes(1);
  });
});

const pair = () => [speaker("move", { volume_level: 9, group_members: ["move", "dining"] }), speaker("dining", { volume_level: 24, synced_to: "move" })];
const virtualPair = () => [speaker("group", { type: "group", group_members: ["move", "dining"] }), ...pair().map(p => ({ ...p, group_members: [], synced_to: null }))];

describe("equal-point changes and optional matching", () => {
  it("changes 9/24 to 11/26 and back without proportional scaling", async () => {
    const players = pair();
    const { client, command } = setup(players);
    const initial = await client.getVolumeTarget(players[0]);
    expect(command.mock.calls.some(([name]) => name === "players/cmd/volume_set")).toBe(false);
    const up = stepVolumeTarget(initial, 2);
    await client.setVolume(up, up.level);
    expect(players.map(p => p.volume_level)).toEqual([11, 26]);
    const down = stepVolumeTarget(up, -2);
    await client.setVolume(down, down.level);
    expect(players.map(p => p.volume_level)).toEqual([9, 24]);
  });

  it("clamps each member independently and responds when reversing at 100", async () => {
    const players = pair();
    players[1].volume_level = 100;
    const { client } = setup(players);
    let target = stepVolumeTarget(await client.getVolumeTarget(players[0]), 2);
    await client.setVolume(target, target.level);
    expect(players.map(p => p.volume_level)).toEqual([11, 100]);
    target = stepVolumeTarget(target, -2);
    await client.setVolume(target, target.level);
    expect(players.map(p => p.volume_level)).toEqual([9, 98]);
  });

  it("adjusts one grouped speaker without changing any group membership", async () => {
    const players = pair();
    const originalMembership = JSON.stringify(players.map(p => [p.group_members, p.synced_to]));
    const { client, command } = setup(players);
    const target = await client.getVolumeTarget(players[1], { individual: true });
    await client.setVolume(target, 22);
    expect(players.map(p => p.volume_level)).toEqual([9, 22]);
    expect(command.mock.calls.filter(([name]) => name === "players/cmd/volume_set")).toEqual([
      ["players/cmd/volume_set", { player_id: "dining", volume_level: 22 }],
    ]);
    expect(JSON.stringify(players.map(p => [p.group_members, p.synced_to]))).toBe(originalMembership);
  });

  it("matches to the lowest only after an explicit sync and then steps together", async () => {
    const players = [...virtualPair(), speaker("unrelated", { volume_level: 70 })];
    const { client, command } = setup(players);
    await client.getVolumeTarget(players[0]);
    expect(players.slice(1).map(p => p.volume_level)).toEqual([9, 24, 70]);
    expect(await client.syncGroupVolume("group")).toEqual({ level: 9, count: 2 });
    expect(players.slice(1).map(p => p.volume_level)).toEqual([9, 9, 70]);
    expect(command.mock.calls.filter(([name]) => name === "players/cmd/volume_set")).toHaveLength(1);
    const next = stepVolumeTarget(await client.getVolumeTarget(players[0]), 2);
    await client.setVolume(next, next.level);
    expect(players.slice(1).map(p => p.volume_level)).toEqual([11, 11, 70]);
  });

  it("treats zero as a valid lowest volume", async () => {
    const players = virtualPair();
    players[1].volume_level = 0;
    const { client } = setup(players);
    expect(await client.syncGroupVolume("group")).toEqual({ level: 0, count: 2 });
    expect(players.slice(1).map(p => p.volume_level)).toEqual([0, 0]);
  });

  it("skips unavailable, powered-off and non-volume speakers without waking them", async () => {
    const players = [...virtualPair(), speaker("offline", { available: false, volume_level: 0 }), speaker("off", { powered: false, volume_level: 0 }), speaker("no-volume", { volume_control: "none", volume_level: 0 })];
    players[0].group_members!.push("offline", "off", "no-volume");
    const { client, command } = setup(players);
    expect(await client.syncGroupVolume("group")).toEqual({ level: 9, count: 2 });
    expect(command.mock.calls.filter(([name]) => name === "players/cmd/volume_set")).toEqual([
      ["players/cmd/volume_set", { player_id: "dining", volume_level: 9 }],
    ]);
  });

  it("invalidates queued pre-sync wheel commands", async () => {
    const players = virtualPair();
    const { client } = setup(players);
    const target = await client.getVolumeTarget(players[0]);
    await client.syncGroupVolume("group");
    await expect(client.setVolume(target, 26)).rejects.toThrow(/matched/);
    expect(players.slice(1).map(p => p.volume_level)).toEqual([9, 9]);
  });

  it("deduplicates speakers in nested groups and rejects cyclic groups", async () => {
    const players = [speaker("root", { type: "group", group_members: ["nested", "dining"] }), speaker("nested", { type: "group", group_members: ["move", "dining"] }), ...virtualPair().slice(1)];
    const { client, command } = setup(players);
    const target = await client.getVolumeTarget(players[0]);
    await client.setVolume(target, 26);
    expect(command.mock.calls.filter(([name]) => name === "players/cmd/volume_set")).toHaveLength(2);
    players[1].group_members!.push("root");
    await expect(client.getVolumeTarget(players[0])).rejects.toThrow(/cycle/);
  });

  it("does not follow a larger parent when the mixer addresses a specific subgroup", async () => {
    const group = speaker("group", { type: "group", active_group: "larger", group_members: ["move", "dining"] });
    const { client } = setup([group, ...virtualPair().slice(1), speaker("larger", { type: "group", group_members: ["group", "other"] }), speaker("other", { volume_level: 80 })]);
    expect(await client.getVolumeTarget(group, { nativeId: true })).toMatchObject({ playerId: "group", level: 24 });
  });

  it("rejects changed membership before writing to any speaker", async () => {
    const players = [...pair(), speaker("roam")];
    const { client, command } = setup(players);
    const target = await client.getVolumeTarget(players[0]);
    players[0].group_members!.push("roam");
    await expect(client.setVolume(target, 26)).rejects.toThrow(/group changed/);
    expect(command.mock.calls.filter(([name]) => name === "players/cmd/volume_set")).toHaveLength(0);
  });

  it("attempts to restore original member levels after a partial failure", async () => {
    const players = pair();
    const { client, command } = setup(players);
    const base = command.getMockImplementation()!;
    let failed = false;
    command.mockImplementation(async (name, args) => {
      if (name === "players/cmd/volume_set" && args?.player_id === "move" && !failed) { failed = true; throw new Error("speaker error"); }
      return base(name, args);
    });
    const target = await client.getVolumeTarget(players[0]);
    await expect(client.setVolume(target, 26)).rejects.toThrow(/Could not adjust all speakers/);
    expect(players.map(p => p.volume_level)).toEqual([9, 24]);
  });
});
