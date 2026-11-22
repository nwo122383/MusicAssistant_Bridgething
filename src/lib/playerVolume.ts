import type { GroupPlayer, Player } from "../types";
import { groupMembers } from "./playerGroups";

export type MemberVolume = { playerId: string; level: number };
export type VolumeControl = { player: Player; individual: boolean };
export type GroupVolumeInfo = { members: GroupPlayer[]; signature: string };

export type VolumeTarget = {
  playerId: string;
  level: number;
  grouped: boolean;
  route: "native" | "homeassistant";
  connectionEpoch: number;
  revision?: number;
  members?: MemberVolume[];
  signature?: string;
};

export function clampVolume(level: number): number {
  return Math.max(0, Math.min(100, Math.round(level)));
}

export function stepVolumeTarget(target: VolumeTarget, delta: number): VolumeTarget {
  if (!target.members) return { ...target, level: clampVolume(target.level + delta) };
  const members = target.members.map(member => ({ ...member, level: clampVolume(member.level + delta) }));
  return { ...target, members, level: Math.max(...members.map(member => member.level)) };
}

export async function readGroupVolume(root: GroupPlayer, read: (id: string) => Promise<GroupPlayer | null>): Promise<GroupVolumeInfo> {
  const leaves = new Map<string, GroupPlayer>();
  const seen = new Set<string>();
  const topology: Array<[string, string[], string | null, string | null]> = [];
  const visit = async (player: GroupPlayer, ancestors: Set<string>): Promise<void> => {
    if (ancestors.has(player.player_id)) throw new Error("The speaker group contains a cycle. Refresh players and try again.");
    if (seen.has(player.player_id)) return;
    if (seen.size >= 128) throw new Error("This speaker group is too large to adjust safely");
    seen.add(player.player_id);
    const children = groupMembers(player).sort();
    topology.push([player.player_id, children, player.active_group ?? null, player.synced_to ?? null]);
    if (player.type !== "group" && player.available && player.powered && player.enabled !== false && player.volume_control !== "none" && typeof player.volume_level === "number" && Number.isFinite(player.volume_level)) leaves.set(player.player_id, player);
    const next = new Set(ancestors).add(player.player_id);
    for (const id of children) {
      const child = await read(id);
      if (child) await visit(child, next);
    }
  };
  await visit(root, new Set());
  const members = [...leaves.values()].sort((a, b) => a.player_id.localeCompare(b.player_id));
  if (!members.length) throw new Error("No powered-on speakers with volume control are available in this group");
  return { members, signature: JSON.stringify([topology.sort((a, b) => a[0].localeCompare(b[0])), members.map(member => member.player_id)]) };
}
