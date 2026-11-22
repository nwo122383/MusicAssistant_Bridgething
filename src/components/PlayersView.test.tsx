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
    { player_id: "group", playback_player_id: "media_player.group", name: "Home Group", type: "group", available: true, powered: true, volume_level: 0, group_volume: 45, group_members: ["move", "dining"] },
  ];
  const client = {
    getGroupPlayers: vi.fn().mockResolvedValue(players),
    ungroupAllPlayers: vi.fn().mockResolvedValue({ attempted: 2, failed: [] }),
    setGroupMembers: vi.fn().mockResolvedValue(undefined),
    getGroupVolumeInfo: vi.fn(async () => ({ members: players.slice(0, 2), signature: "test-members" })),
    syncGroupVolume: vi.fn(async () => { players[0].volume_level = 20; players[1].volume_level = 20; return { level: 20, count: 2 }; }),
  };
  const select = vi.fn();
  const volumeControl = vi.fn();
  const rendered = render(<PlayersView client={client as unknown as MassClient} fallbackPlayers={[]} selected="media_player.move" onSelect={select} onChanged={vi.fn().mockResolvedValue(undefined)} onVolumeControl={volumeControl} />);
  return { client, select, volumeControl, ...rendered };
}

describe("Players screen", () => {
  it("opens in whole-group mode without automatically matching levels", async () => {
    const { client, volumeControl } = setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByRole("button", { name: "Volume controls for Move" }));
    const group = await screen.findByRole("radio", { name: /Whole group/ });
    expect((group as HTMLInputElement).checked).toBe(true);
    expect(client.syncGroupVolume).not.toHaveBeenCalled();
    expect(volumeControl).toHaveBeenLastCalledWith(expect.objectContaining({ individual: false }));
  });

  it("selects one member for the dial without changing playback selection or grouping", async () => {
    const { client, select, volumeControl } = setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByRole("button", { name: "Volume controls for Move" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Dining/ }));
    expect(volumeControl).toHaveBeenLastCalledWith(expect.objectContaining({ individual: true, player: expect.objectContaining({ player_id: "dining" }) }));
    expect(select).not.toHaveBeenCalled();
    expect(client.setGroupMembers).not.toHaveBeenCalled();
    expect(client.ungroupAllPlayers).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(volumeControl).toHaveBeenLastCalledWith(undefined);
  });

  it("matches levels only when Sync to lowest is pressed", async () => {
    const { client } = setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByRole("button", { name: "Volume controls for Move" }));
    await screen.findByRole("radio", { name: /Dining/ });
    expect(client.syncGroupVolume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Sync to lowest/ }));
    await waitFor(() => expect(client.syncGroupVolume).toHaveBeenCalledExactlyOnceWith("move"));
    await waitFor(() => expect(document.querySelectorAll(".volume-member-level").length).toBe(3));
    await waitFor(() => expect([...document.querySelectorAll(".volume-member-level")].every(el => el.textContent === "20%")).toBe(true));
  });
  it("shows aggregate volume for virtual groups", async () => {
    setup();
    await screen.findByText("Move");
    fireEvent.click(screen.getByRole("tab", { name: "Groups" }));
    expect(screen.getByText("Home Group")).toBeTruthy();
    expect(screen.getByText("45%")).toBeTruthy();
  });
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
