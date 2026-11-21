import type { GroupPlayer } from "../types";

export function groupMembers(player: GroupPlayer): string[] {
  return [...new Set(player.group_members ?? player.group_childs ?? [])].filter(id => id !== player.player_id);
}

export function isActivelyGrouped(player: GroupPlayer): boolean {
  if (player.synced_to || player.active_group) return true;
  if (player.type === "group") return player.powered || player.state === "playing" || player.state === "paused";
  return groupMembers(player).length > 0;
}

export function ungroupTargets(players: GroupPlayer[]): GroupPlayer[] {
  // Release virtual group sessions first, followers next, then any remaining leaders.
  return players.filter(p => isActivelyGrouped(p) ||
    (p.type !== "group" && p.supported_features?.includes("set_members"))).sort((a, b) => {
    const order = (p: GroupPlayer) => p.type === "group" ? 0 : p.synced_to || p.active_group ? 1 : 2;
    return order(a) - order(b);
  });
}

export function membershipChanges(player: GroupPlayer, desired: string[], baseline: string[]) {
  const current = groupMembers(player);
  if (current.length !== baseline.length || current.some(id => !baseline.includes(id))) {
    throw new Error("This group changed elsewhere. Close and reopen the group editor.");
  }
  const add = [...new Set(desired)].filter(id => id !== player.player_id && !current.includes(id));
  const remove = current.filter(id => !desired.includes(id));
  if (add.some(id => !player.can_group_with?.includes(id))) throw new Error("A selected speaker can no longer join this group");
  if (remove.some(id => player.static_group_members?.includes(id))) throw new Error("Fixed group members cannot be removed individually");
  return { add, remove };
}
