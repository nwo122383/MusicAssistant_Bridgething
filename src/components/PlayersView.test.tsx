import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlayersView } from "./PlayersView";
import type { MassClient } from "../lib/MassClient";

afterEach(cleanup);
function setup() {
  const players = [
    { player_id: "move", playback_player_id: "media_player.move", name: "Move", available: true, powered: true, volume_level: 25, supported_features: ["set_members"], group_members: ["dining"], can_group_with: ["dining", "roam"] },
    { player_id: "dining", name: "Dining", available: true, powered: true, volume_level: 20, synced_to: "move" },
    { player_id: "roam", name: "Roam", available: true, powered: true, volume_level: 20 },
  ];
  const client = { getGroupPlayers: vi.fn().mockResolvedValue(players), ungroupAllPlayers: vi.fn().mockResolvedValue({ attempted: 2, failed: [] }), setGroupMembers: vi.fn().mockResolvedValue(undefined) };
  const select = vi.fn();
  render(<PlayersView client={client as unknown as MassClient} fallbackPlayers={[]} selected="media_player.move" onSelect={select} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  return { client, select };
}

describe("Players screen", () => {
  it("requires confirmation, supports cancel, and only then runs Ungroup All", async () => {
    const { client } = setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByText("Ungroup All"));
    expect(client.ungroupAllPlayers).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("Saved group setups are kept");
    fireEvent.click(screen.getByText("Cancel"));
    expect(client.ungroupAllPlayers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Ungroup All"));
    fireEvent.click(screen.getAllByText("Ungroup All")[1]);
    await waitFor(() => expect(client.ungroupAllPlayers).toHaveBeenCalledOnce());
  });

  it("preselects current members and applies the edited membership", async () => {
    const { client } = setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByLabelText("Edit group for Move"));
    const dining = screen.getByRole("checkbox", { name: /Dining/ });
    const roam = screen.getByRole("checkbox", { name: /Roam/ });
    expect((dining as HTMLInputElement).checked).toBe(true);
    expect((roam as HTMLInputElement).checked).toBe(false);
    fireEvent.click(dining);
    fireEvent.click(roam);
    fireEvent.click(screen.getByText("Apply"));
    await waitFor(() => expect(client.setGroupMembers).toHaveBeenCalledWith("move", ["roam"], ["dining"]));
  });

  it("selects the HA playback entity rather than the native grouping ID", async () => {
    const { select } = setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByTitle("Select Move"));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ player_id: "media_player.move" }));
  });
});
