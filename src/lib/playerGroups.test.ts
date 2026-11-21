import { describe, expect, it, vi } from "vitest";
import type { GroupPlayer } from "../types";
import { groupMembers, membershipChanges, ungroupTargets } from "./playerGroups";
import { MassClient } from "./MassClient";

const player = (id: string, extra: Partial<GroupPlayer> = {}): GroupPlayer => ({
  player_id: id, name: id, available: true, powered: false, volume_level: 20, ...extra,
});

describe("speaker group operations", () => {
  it("does not confuse idle saved group membership with an active group", () => {
    const saved = player("saved", { type: "group", group_members: ["move", "dining"] });
    const leader = player("move", { group_members: ["move", "dining"] });
    const follower = player("dining", { synced_to: "move", available: false });
    const active = player("active", { type: "group", powered: true });
    expect(ungroupTargets([leader, saved, follower, active]).map(p => p.player_id)).toEqual(["active", "dining", "move"]);
    expect(groupMembers(leader)).toEqual(["dining"]);
  });

  it("computes membership changes and rejects stale edits", () => {
    const leader = player("move", { group_members: ["move", "dining"], can_group_with: ["dining", "roam"] });
    expect(membershipChanges(leader, ["roam"], ["dining"])).toEqual({ add: ["roam"], remove: ["dining"] });
    expect(() => membershipChanges(leader, ["roam"], [])).toThrow("changed elsewhere");
    expect(() => membershipChanges(leader, ["unknown"], ["dining"])).toThrow("no longer join");
    expect(() => membershipChanges({ ...leader, static_group_members: ["dining"] }, [], ["dining"])).toThrow("Fixed");
  });

  it("ungroups hidden/unavailable followers and continues after a failure without editing saved groups", async () => {
    const client = new MassClient();
    vi.spyOn(client, "getGroupPlayers").mockResolvedValue([
      player("move", { group_members: ["dining"] }),
      player("dining", { synced_to: "move", available: false }),
      player("saved", { type: "group", group_members: ["move", "dining"] }),
      player("hidden", { supported_features: ["set_members"], enabled: false }),
    ]);
    const command = vi.spyOn(client, "nativePlayerCommand").mockImplementation(async (_command, args) => {
      if (args?.player_id === "dining") throw new Error("offline");
    });
    expect(await client.ungroupAllPlayers()).toEqual({ attempted: 3, failed: ["dining"] });
    expect(command.mock.calls).toEqual([
      ["players/cmd/ungroup", { player_id: "dining" }],
      ["players/cmd/ungroup", { player_id: "move" }],
      ["players/cmd/ungroup", { player_id: "hidden" }],
    ]);
  });

  it("checks fresh membership before applying only the requested additions/removals", async () => {
    const client = new MassClient();
    vi.spyOn(client, "getGroupPlayers").mockResolvedValue([player("move", { group_members: ["dining"], can_group_with: ["roam"] })]);
    const command = vi.spyOn(client, "nativePlayerCommand").mockResolvedValue(undefined);
    await client.setGroupMembers("move", ["roam"], ["dining"]);
    expect(command).toHaveBeenCalledWith("players/cmd/set_members", { target_player: "move", player_ids_to_add: ["roam"], player_ids_to_remove: ["dining"] });
  });
});
