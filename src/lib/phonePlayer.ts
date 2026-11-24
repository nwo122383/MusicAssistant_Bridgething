import type { ConnectionConfig, Player } from "../types";

export function isCompanionPhonePlayer(player: Player): boolean {
  return player.device_info?.manufacturer === "MusicAssistant_Bridgething" &&
    player.device_info.model === "Mobile Application";
}

export function phoneStartupTarget(config: ConnectionConfig, selected: string, assigned: string, verifiedCompanion: string): string | undefined {
  return config.transport === "homeassistant" && selected === assigned && assigned === verifiedCompanion && /^[A-Za-z0-9_-]{43}$/.test(assigned)
    ? assigned : undefined;
}

export function nextPlayerId(_players: Player[], current: string, phonePlayerId: string): string {
  // A temporarily missing player must never redirect playback to another room.
  return current || phonePlayerId;
}

export function currentPlayer(players: Player[], selected: string, _phonePlayerId: string): Player | undefined {
  return players.find(player => player.player_id === selected && player.available);
}
