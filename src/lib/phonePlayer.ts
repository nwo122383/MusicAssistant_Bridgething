import type { Player } from "../types";

export function nextPlayerId(players: Player[], current: string, phonePlayerId: string): string {
  if (current && current === phonePlayerId) return current;
  return players.some(player => player.player_id === current) ? current : players[0]?.player_id || "";
}

export function currentPlayer(players: Player[], selected: string, phonePlayerId: string): Player | undefined {
  return players.find(player => player.player_id === selected) ?? (selected && selected === phonePlayerId ? undefined : players[0]);
}
