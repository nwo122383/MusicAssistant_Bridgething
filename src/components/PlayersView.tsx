import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Equal, Group, Link2Off, LoaderCircle, RefreshCw, Search, SlidersHorizontal, Smartphone, Speaker, X } from "lucide-react";
import type { GroupPlayer, Player } from "../types";
import type { MassClient } from "../lib/MassClient";
import { groupMembers, isActivelyGrouped } from "../lib/playerGroups";
import type { VolumeControl } from "../lib/playerVolume";

type Editor = { player: GroupPlayer; baseline: string[]; selected: string[] };
type VolumeEditor = { player: GroupPlayer; members: GroupPlayer[]; selectedId: string; loading: boolean };
const name = (p: Player) => p.display_name || p.name;

export function PlayersView({ client, fallbackPlayers, selected, onSelect, onChanged, onVolumeControl, onVolumeData, volumeLevel, phoneVolumePlayerId, phoneVolumePercent, onPhoneVolumePlayer }: {
  client: MassClient; fallbackPlayers: Player[]; selected?: string;
  onSelect: (player: Player) => void; onChanged: () => Promise<void>;
  phoneVolumePlayerId?: string; phoneVolumePercent?: number; onPhoneVolumePlayer?: (id: string) => void;
  onVolumeControl?: (control: VolumeControl | undefined) => void; volumeLevel?: number;
  onVolumeData?: () => void;
}) {
  const [players, setPlayers] = useState<GroupPlayer[]>([]);
  const [tab, setTab] = useState<"speakers" | "groups">("speakers");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<Editor>();
  const [volumeEditor, setVolumeEditor] = useState<VolumeEditor>();
  const volumeEditorRef = useRef(volumeEditor);
  volumeEditorRef.current = volumeEditor;
  const volumeRequest = useRef(0);
  const [confirm, setConfirm] = useState<"all" | GroupPlayer>();
  const mounted = useRef(true);
  const operation = useRef(false);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const mixer = volumeEditorRef.current;
      if (mixer && !mixer.loading) {
        const request = volumeRequest.current;
        const info = await client.getGroupVolumeInfo(mixer.player.player_id);
        onVolumeData?.();
        if (mounted.current && request === volumeRequest.current) {
          const selectedRemoved = !!mixer.selectedId && !info.members.some(member => member.player_id === mixer.selectedId);
          setVolumeEditor(current => current ? { ...current, members: info.members, selectedId: selectedRemoved ? "" : current.selectedId } : current);
          if (selectedRemoved) onVolumeControl?.({ player: mixer.player, individual: false });
          setError("");
        }
        return;
      }
      const next = await client.getGroupPlayers();
      if (mounted.current) {
        setPlayers(next); setError("");
        setVolumeEditor(current => current ? { ...current, members: current.members.map(member => next.find(p => p.player_id === member.player_id) ?? member) } : current);
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Unable to load speaker groups");
    } finally {
      loadingRef.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [client, onVolumeControl, onVolumeData]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (!operation.current) void refresh(); }, 10_000);
    return () => { mounted.current = false; volumeRequest.current += 1; window.clearInterval(timer); onVolumeControl?.(undefined); };
  }, [refresh, onVolumeControl]);

  const openVolume = async (player: GroupPlayer) => {
    const request = ++volumeRequest.current;
    setError(""); setMessage("");
    setVolumeEditor({ player, members: [], selectedId: "", loading: true });
    try {
      const info = await client.getGroupVolumeInfo(player.player_id);
      onVolumeData?.();
      if (!mounted.current || request !== volumeRequest.current) return;
      setVolumeEditor({ player, members: info.members, selectedId: "", loading: false });
      onVolumeControl?.({ player, individual: false });
    } catch (reason) {
      if (mounted.current && request === volumeRequest.current) {
        setError(reason instanceof Error ? reason.message : "Unable to read group volumes");
        setVolumeEditor(current => current ? { ...current, loading: false } : current);
      }
    }
  };
  const closeVolume = () => {
    volumeRequest.current += 1;
    setVolumeEditor(undefined);
    onVolumeControl?.(undefined);
  };

  const run = async (action: () => Promise<string>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await action();
      if (mounted.current) { setMessage(result); setEditor(undefined); }
      await refresh();
      await onChanged();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Unable to change group");
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const edit = (player: GroupPlayer) => {
    const baseline = groupMembers(player);
    setError(""); setMessage(""); setEditor({ player, baseline, selected: baseline });
  };
  const fallback: GroupPlayer[] = fallbackPlayers.map(p => ({ ...p, playback_player_id: p.player_id }));
  const visible = (players.length ? players : fallback).filter(p =>
    (tab === "groups" ? p.type === "group" : p.type !== "group") && name(p).toLowerCase().includes(query.toLowerCase()),
  ).sort((a, b) => Number(b.playback_player_id === selected) - Number(a.playback_player_id === selected) || name(a).localeCompare(name(b)));
  const lookup = (id: string) => players.find(p => p.player_id === id);
  const memberNames = (ids: string[]) => ids.map(id => lookup(id) ? name(lookup(id)!) : "Unavailable speaker").join(", ");
  const choices = editor ? players.filter(p => p.player_id !== editor.player.player_id &&
    (editor.baseline.includes(p.player_id) || (p.enabled !== false && editor.player.can_group_with?.includes(p.player_id))))
    .sort((a, b) => Number(editor.baseline.includes(b.player_id)) - Number(editor.baseline.includes(a.player_id)) || name(a).localeCompare(name(b))) : [];
  const volumeMember = volumeEditor?.members.find(p => p.player_id === volumeEditor.selectedId);
  const shownVolume = volumeLevel ?? (volumeMember?.volume_level ?? Math.max(0, ...(volumeEditor?.members ?? []).map(p => p.volume_level)));

  return <div className="page players-page">
    <div className="page-heading players-heading">
      <h2>Players</h2>
      <div className="players-tools">
        <button onClick={() => void refresh()} disabled={busy || loading} title="Refresh players" aria-label="Refresh players"><RefreshCw size={20} /></button>
        <button className="ungroup-all" disabled={busy || loading} onClick={() => setConfirm("all")}><Link2Off size={19} /> Ungroup All</button>
      </div>
    </div>
    <div className="players-filters">
      <div className="filter-row" role="tablist" aria-label="Player types">
        <button role="tab" aria-selected={tab === "speakers"} className={tab === "speakers" ? "active" : ""} onClick={() => setTab("speakers")}>Speakers</button>
        <button role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}>Groups</button>
      </div>
      <label className="search-box"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search players" aria-label="Search players" /></label>
    </div>
    {error && <p className="players-error" role="alert">{error}</p>}
    {message && <p className="players-message" role="status">{message}</p>}
    {busy && <p className="players-message" role="status"><LoaderCircle className="spin" size={18} /> Updating groups...</p>}
    {loading ? <div className="center-state"><LoaderCircle className="spin" /> Loading players...</div> : <div className="players-list">
      {visible.map(player => {
        const parent = lookup(player.active_group || player.synced_to || "");
        const target = parent || player;
        const members = groupMembers(player);
        const chosen = player.playback_player_id === selected;
        const canEdit = !!target.available && target.supported_features?.includes("set_members");
        return <div key={player.player_id} className={`speaker-row${chosen ? " selected" : ""}${!player.available ? " unavailable" : ""}`}>
          <button className="speaker-select" disabled={busy || !player.available || player.enabled === false || !player.playback_player_id} onClick={() => onSelect({ ...player, player_id: player.playback_player_id! })} title={!player.playback_player_id ? "Not exposed as a Home Assistant player" : `Select ${name(player)}`}>
            {player.type === "group" ? <Group size={24} /> : <Speaker size={24} />}
            <span className="speaker-copy"><strong>{name(player)}</strong>
              <small>{player.enabled === false ? "Disabled" : !player.available ? "Unavailable" : player.state || "idle"}{player.provider ? ` · ${player.provider.replace(/_/g, " ")}` : ""}</small>
              {parent && <small className="group-description">Grouped with {name(parent)}</small>}
              {!parent && members.length > 0 && <small className="group-description">{player.type === "group" ? "Members: " : "Grouped: "}{memberNames(members)}</small>}
            </span>
            {chosen && <Check size={20} aria-label="Selected player" />}
          </button>
          <div className="speaker-actions">
            <span className="speaker-level">{player.playback_player_id === phoneVolumePlayerId && phoneVolumePercent !== undefined ? phoneVolumePercent : player.type === "group" ? player.group_volume ?? player.volume_level ?? 0 : player.volume_level ?? 0}%</span>
            {onPhoneVolumePlayer && player.playback_player_id && (player.provider === "sendspin" || player.playback_player_id === phoneVolumePlayerId) && <button className={player.playback_player_id === phoneVolumePlayerId ? "active" : ""} aria-pressed={player.playback_player_id === phoneVolumePlayerId} disabled={busy} title={`Use phone media volume for ${name(player)}`} aria-label={`Use phone media volume for ${name(player)}`} onClick={() => onPhoneVolumePlayer(player.playback_player_id === phoneVolumePlayerId ? "" : player.playback_player_id!)}><Smartphone size={21} /></button>}
            {target.available && (target.type === "group" || isActivelyGrouped(target)) && <button disabled={busy} title={`Volume controls for ${name(target)}`} aria-label={`Volume controls for ${name(player)}`} onClick={() => void openVolume(target)}><SlidersHorizontal size={21} /></button>}
            {canEdit && <button onClick={() => edit(target)} disabled={busy} title={`Edit group for ${name(target)}`} aria-label={`Edit group for ${name(player)}`}><Group size={22} /></button>}
            {isActivelyGrouped(player) && <button onClick={() => setConfirm(player)} disabled={busy} title={`Ungroup ${name(player)}`} aria-label={`Ungroup ${name(player)}`}><Link2Off size={21} /></button>}
          </div>
        </div>;
      })}
      {!visible.length && <div className="center-state">No {tab} found</div>}
    </div>}
    {volumeEditor && <div className="ai-radio-backdrop">
      <div className="group-editor volume-editor" role="dialog" aria-modal="true" aria-labelledby="volume-editor-title">
        <div className="group-editor-heading"><h2 id="volume-editor-title">{name(volumeEditor.player)} volume</h2><button aria-label="Close volume controls" disabled={busy} onClick={closeVolume}><X /></button></div>
        {volumeEditor.loading ? <div className="center-state"><LoaderCircle className="spin" /> Loading speaker volumes...</div> : <>
          <div className="volume-panel-meter" role="status" aria-label={`Volume ${shownVolume}`}>
            <span>{volumeMember ? name(volumeMember) : "Whole group"}</span>
            <strong>{shownVolume}%</strong>
          </div>
          <div className="group-members-list volume-members-list" data-hardware-scroll>
            {[volumeEditor.player, ...volumeEditor.members].map((p, index) => <label className="group-choice" key={index === 0 ? "whole-group" : p.player_id}>
              <input type="radio" name="volume-speaker" checked={volumeEditor.selectedId === (index === 0 ? "" : p.player_id)} disabled={busy || !p.available} onChange={() => {
                setVolumeEditor(current => current ? { ...current, selectedId: index === 0 ? "" : p.player_id } : current);
                onVolumeControl?.({ player: p, individual: index !== 0 });
              }} />
              {index === 0 ? <Group size={20} /> : <Speaker size={20} />}
              <span>{index === 0 ? "Whole group" : name(p)}</span>
              <span className="volume-member-level">{index === 0 ? Math.max(0, ...volumeEditor.members.map(member => member.volume_level)) : p.volume_level}%</span>
            </label>)}
          </div>
        </>}
        {error && <p className="players-error" role="alert">{error}</p>}
        <div className="ai-radio-actions volume-editor-actions">
          <button disabled={busy || volumeEditor.loading || volumeEditor.members.length < 2} title="Match powered-on speakers to the lowest volume" onClick={() => {
            const current = volumeEditor;
            const request = volumeRequest.current;
            onVolumeControl?.(undefined);
            void run(async () => {
              try {
                const result = await client.syncGroupVolume(current.player.player_id);
                const info = await client.getGroupVolumeInfo(current.player.player_id);
                if (mounted.current && request === volumeRequest.current) setVolumeEditor({ ...current, members: info.members });
                return `${result.count} speakers matched at ${result.level}%`;
              } finally {
                if (mounted.current && request === volumeRequest.current) {
                  const chosen = current.members.find(p => p.player_id === current.selectedId);
                  onVolumeControl?.({ player: chosen ?? current.player, individual: !!chosen });
                }
              }
            });
          }}>{busy ? <LoaderCircle className="spin" size={20} /> : <Equal size={20} />} {busy ? "Matching..." : "Sync to lowest"}</button>
          <button className="primary" disabled={busy} onClick={closeVolume}>Done</button>
        </div>
      </div>
    </div>}
    {editor && <div className="ai-radio-backdrop">
      <div className="group-editor" role="dialog" aria-modal="true" aria-labelledby="group-editor-title">
        <div className="group-editor-heading"><h2 id="group-editor-title">{name(editor.player)}</h2><button aria-label="Close group editor" disabled={busy} onClick={() => setEditor(undefined)}><X /></button></div>
        <div className="group-members-list" data-hardware-scroll>
          <div className="group-leader"><Speaker size={20} /><strong>{name(editor.player)}</strong><span>Leader</span></div>
          {choices.map(p => <label key={p.player_id} className="group-choice">
            <input type="checkbox" checked={editor.selected.includes(p.player_id)} disabled={busy || editor.player.static_group_members?.includes(p.player_id) || (!p.available && !editor.selected.includes(p.player_id))} onChange={e => {
              const checked = e.target.checked;
              setEditor(current => current ? { ...current, selected: checked ? [...current.selected, p.player_id] : current.selected.filter(id => id !== p.player_id) } : current);
            }} />
            <span>{name(p)}<small>{editor.player.static_group_members?.includes(p.player_id) ? "Fixed member" : !p.available ? "Unavailable" : p.state || "idle"}</small></span>
          </label>)}
          {!choices.length && <p>No compatible speakers available</p>}
        </div>
        {error && <p className="players-error" role="alert">{error}</p>}
        <div className="ai-radio-actions"><button disabled={busy} onClick={() => setEditor(undefined)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void run(async () => {
          await client.setGroupMembers(editor.player.player_id, editor.selected, editor.baseline);
          return "Group updated";
        })}>{busy ? "Applying..." : "Apply"}</button></div>
      </div>
    </div>}
    {confirm && <div className="ai-radio-backdrop">
      <div className="ai-radio-dialog" role="dialog" aria-modal="true" aria-labelledby="ungroup-title">
        <h2 id="ungroup-title">{confirm === "all" ? "Ungroup all speakers?" : `Ungroup ${name(confirm)}?`}</h2>
        <p>{confirm === "all" ? "Release active speaker groups across Music Assistant, including players outside this list. Playback may stop in multiple rooms. Saved group setups are kept." : "Release this player from its active group. Playback may stop."}</p>
        <div className="ai-radio-actions"><button onClick={() => setConfirm(undefined)}>Cancel</button><button className="primary" onClick={() => {
          const target = confirm;
          setConfirm(undefined);
          void run(async () => {
            if (target !== "all") { await client.nativePlayerCommand("players/cmd/ungroup", { player_id: target.player_id }); return `${name(target)} released`; }
            const result = await client.ungroupAllPlayers();
            return result.failed.length ? `Could not release: ${result.failed.join(", ")}. Other group commands completed.`
              : result.attempted ? "Ungroup commands completed. Refreshing speaker state." : "No active speaker groups found";
          });
        }}>{confirm === "all" ? "Ungroup All" : "Ungroup"}</button></div>
      </div>
    </div>}
  </div>;
}
