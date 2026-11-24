import type { GroupPlayer, MassEvent, MassImage, MediaItem, Player, PlayerQueue, QueueItem } from "../types";
import { isActivelyGrouped, membershipChanges, ungroupTargets } from "./playerGroups";
import { clampVolume, readGroupVolume, type GroupVolumeInfo, type MemberVolume, type VolumeTarget } from "./playerVolume";
import { createWebRtcSocket } from "./WebRtcSocket";
import { REMOTE_ARTWORK_BASE, setRemoteArtworkLoader, setRemoteArtworkScope } from "./remoteArtwork";
import { imageUrl, siriusXmArtworkUrl } from "./images";
import { connectionTimings } from "./connection";
import { decodeHaSession, refreshHaSession, HaSignInRequired, type HaSession } from "./homeAssistantAuth";
import { isCompanionPhonePlayer } from "./phonePlayer";
import type { StartupPhase } from "./startupDiagnostics";

type MassTransport = "direct" | "bridgething" | "homeassistant" | "webrtc";
export type PlaybackSnapshot = { players: Player[]; queues: PlayerQueue[] };
type HaIngress = { url: string; session: string; expires: number };

const HA_CONNECT_TIMEOUT_MS = 30_000;
const HA_COMMAND_TIMEOUT_MS = 12_000;
const HA_MASS_PLAYER_TEMPLATE = `{{ states.media_player | selectattr('attributes.mass_player_type', 'defined') | map(attribute='entity_id') | list | tojson }}`;
const GENERIC_HA_RADIO_ARTISTS = new Set(["", "radio", "live radio", "stream", "unknown"]);

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  parts: unknown[];
  timeout: number;
  eventResult?: "template" | "entities";
  pong?: boolean;
};

class ServerResponseError extends Error {}

type TransportSocket = {
  ready?: Promise<void>;
  isOpen: () => boolean;
  send: (data: string) => void;
  close: () => void;
};

export class MassClient {
  private socket?: TransportSocket;
  private pending = new Map<string, Pending>();
  private eventListeners = new Set<(event: MassEvent) => void>();
  private closeListeners = new Set<() => void>();
  private sequence = 0;
  private commandTimeoutMs = 15_000;
  private haSequence = 0;
  private serverReady?: () => void;
  private connectionEpoch = 0;
  private serverResponseAt = 0;
  private serverResponseRevision = 0;
  private cancelConnection?: () => void;
  private protocol: "mass" | "ha" = "mass";
  private haBaseUrl = "";
  private haStates = new Map<string, HaState>();
  private haMassConfigEntryId = "";
  private haRefreshInFlight?: Promise<void>;
  private haHydratedQueues = new Map<string, PlayerQueue>();
  private haQueueHydrationSequence = new Map<string, number>();
  private haIngress?: HaIngress;
  private haIngressInFlight?: Promise<HaIngress>;
  private haPlayerEntityMap?: Map<string, string>;
  private haAuthCache?: { credential: string; session: HaSession };
  private haRejectedCredential?: string;
  private haCompanionDiscovery = false;
  private haCompanionPlayers: Player[] = [];
  private haCompanionPlayersAt = 0;
  private haCompanionPlayersInFlight?: Promise<Player[]>;
  private haCompanionPlayerIds = new Set<string>();
  private startupPhonePlayerId?: string;
  private priorityPhonePlayerId?: string;
  private startupSnapshot?: PlaybackSnapshot;
  private haInitializationDeferred = false;
  private haStatesReady = false;
  private haInitializationInFlight?: Promise<void>;
  private haWarmupTimer?: number;
  private startupPhase?: (phase: StartupPhase) => void;
  private volumeWriteQueue: Promise<void> = Promise.resolve();
  volumeRevision = 0;

  async connect(serverUrl: string, token?: string, transport: MassTransport = "direct", options: {
    tcpRelayOnly?: boolean; startupPhonePlayerId?: string; onStartupPhase?: (phase: StartupPhase) => void;
  } = {}): Promise<void> {
    this.disconnect();
    const epoch = this.connectionEpoch;
    this.startupPhonePlayerId = transport === "homeassistant" && /^[A-Za-z0-9_-]{43}$/.test(options.startupPhonePlayerId || "")
      ? options.startupPhonePlayerId : undefined;
    this.startupPhase = phase => {
      if (epoch !== this.connectionEpoch) return;
      try { options.onStartupPhase?.(phase); } catch { /* Diagnostics must not change connection behavior. */ }
    };
    const base = serverUrl.replace(/\/$/, "");
    this.commandTimeoutMs = connectionTimings(transport).commandMs;
    setRemoteArtworkScope(JSON.stringify([transport, base, token ?? ""]));
    if (transport === "homeassistant") {
      await this.connectHomeAssistant(base, token);
      return;
    }
    this.protocol = "mass";
    const wsUrl = `${base.replace(/^http/, "ws")}/ws`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (epoch === this.connectionEpoch) {
          this.cancelConnection = undefined;
          const socket = this.socket;
          this.socket = undefined;
          socket?.close();
          this.rejectPending(error);
        }
        reject(error);
      };
      const handleClose = () => {
        if (epoch !== this.connectionEpoch) return;
        if (!settled) fail(new Error("Music Assistant connection closed"));
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        if (transport === "webrtc") setRemoteArtworkLoader(undefined);
        this.rejectPending(new Error("Music Assistant connection closed"));
        this.closeListeners.forEach((listener) => listener());
      };
      const handleMessage = (rawData: string) => {
        if (epoch !== this.connectionEpoch) return;
        const data = JSON.parse(rawData) as Record<string, unknown>;
        this.recordServerResponse();
        if ("server_id" in data && "server_version" in data) {
          this.serverReady?.();
          return;
        }
        if ("event" in data) {
          this.eventListeners.forEach((listener) => listener(data as unknown as MassEvent));
          return;
        }
        this.handleResult(data);
      };
      timeout = window.setTimeout(() => {
        fail(new Error("Music Assistant did not respond"));
      }, transport === "webrtc" ? 75_000 : 12_000);

      this.serverReady = async () => {
        if (settled || epoch !== this.connectionEpoch) return;
        try {
          if (token) await this.command("auth", { token, device_name: "Car Thing" });
          if (!settled) {
            this.startupPhase?.("server_connected");
            if (transport === "webrtc") {
              const socket = this.socket as ReturnType<typeof createWebRtcSocket>;
              setRemoteArtworkLoader(path => socket.fetchImage(path, token));
            }
            settled = true;
            this.cancelConnection = undefined;
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      this.cancelConnection = () => fail(new Error("Connection replaced"));

      if (transport === "webrtc") {
        try {
          const socket = createWebRtcSocket(serverUrl, handleMessage, handleClose, error => {
            if (settled) handleClose();
            else fail(error);
          }, options.tcpRelayOnly ?? true);
          this.socket = socket;
          void socket.ready.catch(error => fail(error instanceof Error ? error : new Error(String(error))));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }

      if (transport === "bridgething") {
        const socket = createBridgeThingSocket(wsUrl, handleMessage, handleClose);
        this.socket = socket;
        void socket.ready?.catch((error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }

      const socket = new WebSocket(wsUrl);
      this.socket = createNativeSocket(socket);
      socket.onerror = () => {
        fail(new Error(`Unable to connect to ${wsUrl}`));
      };
      socket.onclose = handleClose;
      socket.onmessage = (message) => handleMessage(String(message.data));
    });
  }

  async login(username: string, password: string): Promise<string> {
    const result = await this.command<{ access_token?: string; token?: string }>("auth/login", {
      username,
      password,
      device_name: "Car Thing",
    });
    const token = result.access_token ?? result.token;
    if (!token) throw new Error("Music Assistant did not return an access token");
    await this.command("auth", { token, device_name: "Car Thing" });
    return token;
  }

  command<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (this.protocol === "ha") return this.haCommand<T>(command, args);
    return this.massCommand<T>(command, args);
  }

  get connectionGeneration(): number { return this.connectionEpoch; }
  get lastResponseAt(): number { return this.serverResponseAt; }
  get responseRevision(): number { return this.serverResponseRevision; }

  private recordServerResponse(): void {
    this.serverResponseAt = Date.now();
    this.serverResponseRevision += 1;
  }

  async probeConnection(): Promise<boolean> {
    if (!this.isConnected()) return false;
    const epoch = this.connectionEpoch;
    try {
      if (this.protocol === "ha") await this.haRequestWithPending("ping", {}, undefined, 8_000);
      else await this.massCommand("info", undefined, 8_000);
      return epoch === this.connectionEpoch && this.isConnected();
    } catch (error) {
      // A server rejection still proves that this socket can exchange messages.
      return error instanceof ServerResponseError && epoch === this.connectionEpoch && this.isConnected();
    }
  }

  private massCommand<T>(command: string, args?: Record<string, unknown>, timeoutMs = this.commandTimeoutMs): Promise<T> {
    if (!this.socket?.isOpen()) {
      return Promise.reject(new Error("Music Assistant is not connected"));
    }
    const messageId = `ct-${Date.now()}-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Music Assistant command timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        parts: [],
        timeout,
      });
      try { this.socket!.send(JSON.stringify({ message_id: messageId, command, args })); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(messageId);
        reject(error);
      }
    });
  }

  onEvent(listener: (event: MassEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  isConnected(): boolean {
    return this.socket?.isOpen() === true;
  }

  enablePhonePlayerDiscovery(playerId?: string): void {
    this.haCompanionDiscovery = true;
    if (playerId && !playerId.startsWith("media_player.")) this.haCompanionPlayerIds.add(playerId);
  }

  prioritizePhonePlayer(playerId?: string): void {
    this.priorityPhonePlayerId = this.haCompanionPlayers.some(player => player.player_id === playerId && isCompanionPhonePlayer(player))
      ? playerId : undefined;
  }

  takeStartupSnapshot(): PlaybackSnapshot | undefined {
    const snapshot = this.startupSnapshot;
    this.startupSnapshot = undefined;
    return snapshot;
  }

  async getPlaybackTarget(playerId: string, phonePlayerId: string): Promise<{ player: Player; queueId: string }> {
    const epoch = this.connectionEpoch;
    const player = await this.command<Player | null>("players/get", { player_id: playerId });
    if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed. Try again.");
    if (!player || player.player_id !== playerId || !player.available) {
      throw new Error(playerId === phonePlayerId ? "Waiting for phone audio" : "The selected player is unavailable");
    }
    const isPhone = !!phonePlayerId && playerId === phonePlayerId;
    if (isPhone && ([player.synced_to, player.active_group].some(id => id && id !== playerId) ||
      [...(player.group_members || []), ...(player.group_childs || [])].some(id => id !== playerId))) {
      throw new Error("Ungroup the phone player before starting car playback");
    }
    const queue = await this.command<PlayerQueue | null>("player_queues/get", { queue_id: playerId });
    if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed. Try again.");
    // The assigned phone can only use its own queue, never a former home-group source.
    const queueId = queue?.queue_id === playerId ? playerId : isPhone ? undefined : player.active_source;
    if (!queueId) throw new Error(isPhone ? "Waiting for phone audio" : "The selected player has no playback queue");
    return { player, queueId };
  }

  async nativePlayerCommand<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (command === "players/cmd/set_members" || command === "players/cmd/ungroup") this.haPlayerEntityMap = undefined;
    return this.protocol === "ha" ? await this.haMassCommand(command, args) as T : this.command<T>(command, args);
  }

  async getGroupPlayers(mapPlayback = true): Promise<GroupPlayer[]> {
    const players = await this.nativePlayerCommand<GroupPlayer[]>("players/all", { return_unavailable: true, return_disabled: true });
    if (this.protocol === "ha" && players.some(isCompanionPhonePlayer)) {
      this.haCompanionDiscovery = true;
      this.haCompanionPlayers = players.filter(isCompanionPhonePlayer);
      this.haCompanionPlayers.forEach(p => this.haCompanionPlayerIds.add(p.player_id));
      this.haCompanionPlayersAt = Date.now();
    }
    if (!mapPlayback) return players;
    if (this.protocol !== "ha") return players.map(p => ({ ...p, playback_player_id: p.player_id }));
    const entityMap = await this.getHaPlayerEntityMap();
    return players.map(player => ({
      ...player,
      playback_player_id: isCompanionPhonePlayer(player) ? player.player_id : entityMap.get(player.player_id) ?? entityMap.get(`mass_${player.player_id}`),
    }));
  }

  private async getHaPlayerEntityMap(): Promise<Map<string, string>> {
    if (this.haInitializationDeferred && !this.haStatesReady) await this.initializeHomeAssistantStates();
    if (!this.haPlayerEntityMap) {
      const epoch = this.connectionEpoch;
      const registry = await this.haRequest<Array<{ entity_id: string; unique_id: string; platform: string; config_entry_id?: string }>>("config/entity_registry/list");
      if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed");
      this.haPlayerEntityMap = new Map(registry.filter(entry => entry.platform === "music_assistant" &&
        (!entry.config_entry_id || entry.config_entry_id === this.haMassConfigEntryId)).map(entry => [entry.unique_id, entry.entity_id]));
    }
    return this.haPlayerEntityMap;
  }

  async getVolumeTarget(selected: Player, options: { individual?: boolean; nativeId?: boolean } = {}): Promise<VolumeTarget> {
    const epoch = this.connectionEpoch;
    const revision = this.volumeRevision;
    const companion = isCompanionPhonePlayer(selected);
    if (this.protocol === "ha" && !options.nativeId && !companion && (options.individual || (selected.type !== "group" && !isActivelyGrouped(selected)))) {
      return { playerId: selected.player_id, level: clampVolume(selected.volume_level), grouped: false, route: "homeassistant", connectionEpoch: epoch, revision };
    }
    let playerId = selected.player_id;
    if (this.protocol === "ha" && !options.nativeId && !companion) {
      const entityMap = await this.getHaPlayerEntityMap();
      const ids = [...entityMap].filter(([, entity]) => entity === selected.player_id).map(([id]) => id);
      if (ids.length !== 1) throw new Error("Unable to resolve the selected Music Assistant speaker for group volume");
      playerId = ids[0];
    }
    const read = (id: string) => this.nativePlayerCommand<GroupPlayer | null>("players/get", { player_id: id });
    let player = await read(playerId);
    if (!player && this.protocol === "ha" && !options.nativeId && playerId.startsWith("mass_")) player = await read(playerId.slice(5));
    const visited = new Set<string>();
    while (player) {
      if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed");
      if (!player.available || player.enabled === false) throw new Error("The volume speaker is unavailable");
      if (visited.has(player.player_id)) throw new Error("The speaker group changed. Refresh players and try again.");
      visited.add(player.player_id);
      const currentId = player.player_id;
      // A mixer opened for an explicit native group controls that group only.
      const parentId = !options.individual && !options.nativeId && [player.active_group, player.synced_to].find(id => id && id !== currentId);
      if (parentId) { player = await read(parentId); continue; }
      if (options.individual && player.type === "group") throw new Error("Select an individual speaker, not a virtual group");
      const grouped = !options.individual && (player.type === "group" || isActivelyGrouped(player));
      if (grouped) {
        const info = await readGroupVolume(player, read);
        if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed");
        const members = info.members.map(member => ({ playerId: member.player_id, level: member.volume_level }));
        return { playerId: player.player_id, level: Math.max(...members.map(member => member.level)), grouped: true, route: "native", connectionEpoch: epoch, revision, members, signature: info.signature };
      }
      const level = player.volume_level;
      if (typeof level !== "number" || !Number.isFinite(level)) throw new Error("Volume is unavailable for this speaker group");
      return { playerId: player.player_id, level: clampVolume(level), grouped, route: "native", connectionEpoch: epoch, revision };
    }
    throw new Error("The volume speaker is unavailable");
  }

  async setVolume(target: VolumeTarget, level: number): Promise<void> {
    if (!Number.isFinite(level)) throw new Error("Invalid volume level");
    await this.queueVolumeWrite(async () => {
      this.checkVolumeTarget(target);
      if (target.grouped) {
        if (!target.members || !target.signature) throw new Error("Refresh the speaker group before adjusting its volume");
        const current = await this.getGroupVolumeInfo(target.playerId);
        this.checkVolumeTarget(target);
        if (current.signature !== target.signature) throw new Error("The speaker group changed. Turn the dial again.");
        const delta = level - target.level;
        const desired = target.members.map(member => ({ ...member, level: clampVolume(member.level + delta) }));
        await this.writeMemberVolumes(current, desired, target.connectionEpoch);
      } else {
        const args = { player_id: target.playerId, volume_level: clampVolume(level) };
        if (target.route === "homeassistant") await this.command("players/cmd/volume_set", args);
        else await this.nativePlayerCommand("players/cmd/volume_set", args);
      }
    });
  }

  async getGroupVolumeInfo(playerId: string): Promise<GroupVolumeInfo> {
    const epoch = this.connectionEpoch;
    const read = (id: string) => this.nativePlayerCommand<GroupPlayer | null>("players/get", { player_id: id });
    const group = await read(playerId);
    if (!group?.available || group.enabled === false) throw new Error("The volume group is unavailable");
    if (group.type !== "group" && !isActivelyGrouped(group)) throw new Error("This speaker is no longer grouped");
    const info = await readGroupVolume(group, read);
    if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed");
    return info;
  }

  async syncGroupVolume(playerId: string): Promise<{ level: number; count: number }> {
    const epoch = this.connectionEpoch;
    this.volumeRevision += 1;
    let result!: { level: number; count: number };
    await this.queueVolumeWrite(async () => {
      if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed");
      const current = await this.getGroupVolumeInfo(playerId);
      if (current.members.length < 2) throw new Error("At least two powered-on speakers are needed to sync volume");
      const level = Math.min(...current.members.map(member => member.volume_level));
      await this.writeMemberVolumes(current, current.members.map(member => ({ playerId: member.player_id, level })), epoch);
      result = { level, count: current.members.length };
    });
    return result;
  }

  private checkVolumeTarget(target: VolumeTarget): void {
    if (target.connectionEpoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed. Turn the dial again.");
    if (target.revision !== undefined && target.revision !== this.volumeRevision) throw new Error("Volume levels were matched. Turn the dial again.");
  }

  private async queueVolumeWrite(action: () => Promise<void>): Promise<void> {
    const next = this.volumeWriteQueue.catch(() => {}).then(action);
    this.volumeWriteQueue = next.catch(() => {});
    await next;
  }

  private async writeMemberVolumes(current: GroupVolumeInfo, desired: MemberVolume[], epoch: number): Promise<void> {
    const attempted: GroupPlayer[] = [];
    try {
      for (const member of current.members) {
        if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed");
        const next = desired.find(value => value.playerId === member.player_id);
        if (!next || !Number.isFinite(next.level)) throw new Error("Speaker volume target is missing");
        if (next.level === member.volume_level) continue;
        attempted.push(member);
        await this.nativePlayerCommand("players/cmd/volume_set", { player_id: member.player_id, volume_level: clampVolume(next.level) });
      }
    } catch (reason) {
      for (const member of attempted.reverse()) {
        if (epoch !== this.connectionEpoch) break;
        try { await this.nativePlayerCommand("players/cmd/volume_set", { player_id: member.player_id, volume_level: member.volume_level }); } catch { /* A disconnected speaker may need a manual volume check. */ }
      }
      throw new Error(`Could not adjust all speakers. Check their volumes. ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  async setGroupMembers(playerId: string, desired: string[], baseline: string[]): Promise<void> {
    const player = (await this.getGroupPlayers(false)).find(p => p.player_id === playerId);
    if (!player?.available) throw new Error("The group leader is unavailable");
    const { add, remove } = membershipChanges(player, desired, baseline);
    if (!add.length && !remove.length) return;
    await this.nativePlayerCommand("players/cmd/set_members", {
      target_player: playerId, player_ids_to_add: add, player_ids_to_remove: remove,
    });
  }

  async ungroupAllPlayers(): Promise<{ attempted: number; failed: string[] }> {
    const targets = ungroupTargets(await this.getGroupPlayers(false));
    const failed: string[] = [];
    for (const player of targets) {
      try {
        await this.nativePlayerCommand("players/cmd/ungroup", { player_id: player.player_id });
      } catch {
        failed.push(player.display_name || player.name);
      }
    }
    return { attempted: targets.length, failed };
  }

  disconnect(): void {
    this.connectionEpoch += 1;
    this.serverResponseAt = 0;
    this.cancelConnection?.();
    this.cancelConnection = undefined;
    setRemoteArtworkLoader(undefined);
    this.haPlayerEntityMap = undefined;
    this.haIngress = undefined;
    this.haIngressInFlight = undefined;
    this.haCompanionPlayers = [];
    this.haCompanionPlayersAt = 0;
    this.haCompanionPlayersInFlight = undefined;
    this.haCompanionPlayerIds.clear();
    this.startupPhonePlayerId = undefined;
    this.priorityPhonePlayerId = undefined;
    this.startupSnapshot = undefined;
    this.haInitializationDeferred = false;
    this.haStatesReady = false;
    this.haInitializationInFlight = undefined;
    this.haRefreshInFlight = undefined;
    clearTimeout(this.haWarmupTimer);
    this.haWarmupTimer = undefined;
    this.startupPhase = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.haStates.clear();
    this.haMassConfigEntryId = "";
    this.haHydratedQueues.clear();
    this.haQueueHydrationSequence.clear();
    this.rejectPending(new Error("Connection replaced"));
  }

  private handleResult(message: Record<string, unknown>): void {
    const id = String(message.message_id ?? "");
    const pending = this.pending.get(id);
    if (!pending) return;
    if (message.error_code) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new ServerResponseError(String(message.details ?? message.error_code)));
      return;
    }
    if (message.partial) {
      if (Array.isArray(message.result)) pending.parts.push(...message.result);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.parts.length && Array.isArray(message.result)) {
      pending.resolve([...pending.parts, ...message.result]);
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectPending(error: Error): void {
    this.pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(error);
    });
    this.pending.clear();
  }

  private async connectHomeAssistant(base: string, token?: string): Promise<void> {
    if (!token) throw new Error("Sign in to Home Assistant in BridgeThing settings");
    const epoch = this.connectionEpoch;
    base = new URL(base).origin;
    const credential = token;
    const decoded = decodeHaSession(credential, base);
    if (decoded) {
      if (this.haRejectedCredential === credential) throw new HaSignInRequired("Sign in to Home Assistant again in BridgeThing settings");
      let session = this.haAuthCache?.credential === credential ? this.haAuthCache.session : decoded;
      if (session.expiresAt <= Date.now() + 60_000) {
        const bridge = await importBridgeThingClient();
        try {
          session = await refreshHaSession(session, async (url, init) => {
            const result = await bridge.net.fetch({ request: {
              url, method: "POST", headers: [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }],
              body: new TextEncoder().encode(String(init.body)), timeoutMs: 15_000, redirect: "error",
            } }, { timeoutMs: 18_000 });
            if (!result.ok) throw new Error("Unable to refresh Home Assistant sign-in through the phone");
            const response = result.response.response;
            return new Response(new TextDecoder().decode(response.body), { status: response.status });
          });
        } catch (error) {
          if (error instanceof HaSignInRequired) this.haRejectedCredential = credential;
          throw error;
        } finally { bridge.close(); }
      }
      if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
      this.haAuthCache = { credential, session };
      token = session.accessToken;
    }
    if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
    this.protocol = "ha";
    this.haBaseUrl = base;
    this.haStates.clear();
    const wsUrl = `${base.replace(/^http/, "ws")}/api/websocket`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout = 0;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (epoch === this.connectionEpoch) {
          this.cancelConnection = undefined;
          const socket = this.socket;
          this.socket = undefined;
          socket?.close();
          this.rejectPending(error);
        }
        reject(error);
      };
      const handleClose = () => {
        if (epoch !== this.connectionEpoch) return;
        const socket = this.socket;
        this.socket = undefined;
        if (!settled) fail(new Error("Home Assistant connection closed"));
        socket?.close();
        this.rejectPending(new Error("Home Assistant connection closed"));
        this.closeListeners.forEach((listener) => listener());
      };
      const handleMessage = (rawData: string) => {
        if (epoch !== this.connectionEpoch) return;
        const data = JSON.parse(rawData) as HaMessage;
        this.recordServerResponse();
        if (data.type === "auth_required") {
          this.socket?.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (data.type === "auth_invalid") {
          if (decoded) this.haAuthCache = { credential, session: { ...this.haAuthCache!.session, expiresAt: 0 } };
          fail(new Error("Home Assistant rejected the access token"));
          return;
        }
        if (data.type === "auth_ok") {
          this.startupPhase?.("server_connected");
          void this.finishHomeAssistantConnect().then(() => {
            if (!settled && epoch === this.connectionEpoch) {
              settled = true;
              clearTimeout(timeout);
              this.cancelConnection = undefined;
              resolve();
            }
          }, (error) => fail(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        if (data.type === "result") {
          this.handleHaResult(data);
          return;
        }
        if (data.type === "pong") {
          const pending = this.pending.get(String(data.id));
          if (pending?.pong) {
            this.pending.delete(String(data.id));
            clearTimeout(pending.timeout);
            pending.resolve(undefined);
          }
          return;
        }
        if (data.type === "event") this.handleHaEvent(data);
      };

      this.cancelConnection = () => fail(new Error("Connection replaced"));
      timeout = window.setTimeout(() => fail(new Error("Home Assistant did not respond")), HA_CONNECT_TIMEOUT_MS);
      const socket = createBridgeThingSocket(wsUrl, handleMessage, handleClose);
      this.socket = socket;
      void socket.ready?.catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async finishHomeAssistantConnect(): Promise<void> {
    const epoch = this.connectionEpoch;
    setRemoteArtworkLoader(path => this.fetchHaCompanionArtwork(path));
    const id = this.startupPhonePlayerId;
    if (id) {
      let deadline = 0;
      let expired = false;
      try {
        const read = async (): Promise<{ player: Player; queue: PlayerQueue | null } | undefined> => {
          const player = await this.haMassCommand("players/get", { player_id: id }) as Player | null;
          if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
          if (expired) return undefined;
          if (player?.player_id !== id || !isCompanionPhonePlayer(player)) return undefined;
          const queue = player.available ? await this.haMassCommand("player_queues/get", { queue_id: id }) as PlayerQueue | null : null;
          if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
          if (queue && queue.queue_id !== id) return undefined;
          return { player, queue };
        };
        const snapshot = await Promise.race([
          read(),
          new Promise<undefined>(resolve => { deadline = window.setTimeout(() => { expired = true; resolve(undefined); }, 8_000); }),
        ]);
        if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
        if (snapshot) {
          const { player, queue } = snapshot;
          this.enablePhonePlayerDiscovery(id);
          this.haCompanionPlayers = [player];
          this.haCompanionPlayersAt = Date.now();
          this.priorityPhonePlayerId = id;
          this.haInitializationDeferred = true;
          this.startupSnapshot = { players: [player], queues: queue ? [this.haCompanionQueue(queue)!] : [] };
          this.startupPhase?.("phone_snapshot_ready");
          this.scheduleHaWarmup();
          return;
        }
      } catch (error) {
        if (epoch !== this.connectionEpoch) throw error;
        // A fast-path miss is optional; retain the established HA startup path.
      } finally { expired = true; clearTimeout(deadline); }
    }
    await this.initializeHomeAssistantStates();
  }

  private async initializeHomeAssistantStates(): Promise<void> {
    if (this.haStatesReady) return;
    if (this.haInitializationInFlight) return this.haInitializationInFlight;
    const epoch = this.connectionEpoch;
    const assertCurrent = () => { if (epoch !== this.connectionEpoch) throw new Error("Connection replaced"); };
    const run = (async () => {
      await this.loadHomeAssistantConfigEntry();
      assertCurrent();
      const entityIds = await this.discoverHaPlayerEntityIds();
      assertCurrent();
      if (entityIds.length) await this.haRequestWithPending<null>("subscribe_entities", { entity_ids: entityIds }, "entities");
      assertCurrent();
      this.haStatesReady = true;
      clearTimeout(this.haWarmupTimer);
      this.haWarmupTimer = undefined;
      this.startupPhase?.("home_players_ready");
    })();
    this.haInitializationInFlight = run;
    try { await run; }
    finally { if (this.haInitializationInFlight === run) this.haInitializationInFlight = undefined; }
  }

  private scheduleHaWarmup(delay = 5_000): void {
    if (this.haWarmupTimer !== undefined || this.haStatesReady) return;
    const epoch = this.connectionEpoch;
    this.haWarmupTimer = window.setTimeout(() => {
      this.haWarmupTimer = undefined;
      if (epoch !== this.connectionEpoch || !this.isConnected()) return;
      void this.initializeHomeAssistantStates().catch(() => {
        if (epoch !== this.connectionEpoch) return;
        this.startupPhase?.("home_warmup_failed");
        this.scheduleHaWarmup(30_000);
      });
    }, delay);
  }

  private async loadHomeAssistantConfigEntry(): Promise<void> {
    const epoch = this.connectionEpoch;
    try {
      const entries = await this.haRequest<HaConfigEntry[]>("config_entries/get", { domain: "music_assistant" });
      if (epoch === this.connectionEpoch) this.haMassConfigEntryId = entries.find((entry) => entry.state === "loaded")?.entry_id || entries[0]?.entry_id || "";
    } catch {
      if (epoch === this.connectionEpoch) this.haMassConfigEntryId = "";
    }
  }

  private haRequest<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.haRequestWithPending<T>(type, payload);
  }

  private haRequestWithPending<T>(
    type: string,
    payload: Record<string, unknown> = {},
    eventResult?: Pending["eventResult"],
    timeoutMs = HA_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.socket?.isOpen()) {
      return Promise.reject(new Error("Home Assistant is not connected"));
    }
    const messageId = ++this.haSequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(String(messageId));
        reject(new Error(`Home Assistant command timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(String(messageId), {
        resolve: resolve as (value: unknown) => void,
        reject,
        parts: [],
        timeout,
        eventResult,
        pong: type === "ping",
      });
      try { this.socket!.send(JSON.stringify({ id: messageId, type, ...payload })); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(String(messageId));
        reject(error);
      }
    });
  }

  private handleHaResult(message: HaResultMessage): void {
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    if (!message.success) {
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      pending.reject(new ServerResponseError(message.error?.message || message.error?.code || "Home Assistant command failed"));
      return;
    }
    if (pending.eventResult) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timeout);
    pending.resolve(message.result);
  }

  private handleHaEvent(message: HaEventMessage): void {
    const pending = this.pending.get(String(message.id));
    if (pending?.eventResult === "template" && message.event && "result" in message.event) {
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      pending.resolve(message.event.result);
      return;
    }
    if (pending?.eventResult === "entities" && (message.event?.a || message.event?.c || message.event?.r)) {
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      this.handleHaEntitySubscriptionEvent(message.event);
      pending.resolve(null);
      return;
    }
    if (message.event?.a || message.event?.c || message.event?.r) {
      this.handleHaEntitySubscriptionEvent(message.event);
      return;
    }
    if (message.event?.event_type !== "state_changed") return;
    const entity = message.event.data?.new_state;
    if (!entity?.entity_id?.startsWith("media_player.") || !this.shouldTrackHaState(entity)) return;
    const previous = this.haStates.get(entity.entity_id);
    this.haStates.set(entity.entity_id, entity);
    this.emitHaState(entity);
    if (!this.priorityPhonePlayerId && this.haMediaIdentityChanged(previous, entity)) void this.emitHydratedHaQueue(entity.entity_id);
  }

  private async haCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const target = String(args?.player_id || args?.queue_id || args?.player_id_override || "");
    if (this.haInitializationDeferred && !this.haStatesReady && (command.startsWith("music/") || target.startsWith("media_player."))) {
      await this.initializeHomeAssistantStates();
    }
    if (command.startsWith("ai_radio/")) return await this.haAiRadioCommand(command, args) as T;
    if (command === "players/all") {
      if (!this.priorityPhonePlayerId && this.haInitializationDeferred && !this.haStatesReady) await this.initializeHomeAssistantStates();
      const [, phones] = await Promise.all([this.priorityPhonePlayerId ? Promise.resolve() : this.refreshHaTrackedStates(), this.getHaCompanionPlayers()]);
      return [...this.haPlayers(), ...phones] as T;
    }
    if (command === "players/get") {
      const playerId = String(args?.player_id || "");
      if (!playerId.startsWith("media_player.")) return await this.getHaCompanionPlayer(playerId) as T;
      await this.refreshHaTrackedStates();
      return (this.haPlayers().find(player => player.player_id === args?.player_id) ?? null) as T;
    }
    if (command === "player_queues/get") {
      const queueId = String(args?.queue_id || "");
      if (!queueId.startsWith("media_player.")) {
        const player = await this.getHaCompanionPlayer(queueId);
        return (player ? this.haCompanionQueue(await this.haMassCommand(command, args) as PlayerQueue | null) : null) as T;
      }
      await this.refreshHaTrackedStates();
      const state = this.haMediaStates().find(state => state.entity_id === args?.queue_id);
      return (state ? this.haStateToQueue(state) : null) as T;
    }
    if (command === "player_queues/all") {
      if (!this.priorityPhonePlayerId) {
        if (this.haInitializationDeferred && !this.haStatesReady) await this.initializeHomeAssistantStates();
        await this.refreshHaTrackedStates();
      }
      const phones = await this.getHaCompanionPlayers();
      const [queues, nativeQueues] = await Promise.all([
        this.priorityPhonePlayerId
          ? Promise.resolve(this.haMediaStates().map(state => this.mergeHaQueueState(state.entity_id, this.haStateToQueue(state))))
          : this.haQueues(),
        Promise.all(phones.filter(p => p.available).map(p => this.haMassCommand("player_queues/get", { queue_id: p.player_id }) as Promise<PlayerQueue | null>)),
      ]);
      return [...queues, ...nativeQueues.filter((q): q is PlayerQueue => !!q).map(q => this.haCompanionQueue(q))] as T;
    }
    if (command.startsWith("player_queues/") && args?.queue_id && !String(args.queue_id).startsWith("media_player.")) {
      if (!await this.getHaCompanionPlayer(String(args.queue_id))) throw new Error("Waiting for phone audio");
      const result = await this.haMassCommand(command, args);
      return (command === "player_queues/items" && Array.isArray(result) ? result.map(item => this.haCompanionItem(item)) : result) as T;
    }
    if (command === "player_queues/items") return (await this.haQueueItems(String(args?.queue_id || ""))) as T;
    if (command === "music/search") return (await this.haSearch(args)) as T;
    if (command.startsWith("music/")) return (await this.haLibrary(command, args)) as T;

    if (command.startsWith("players/cmd/")) {
      const playerId = String(args?.player_id || "");
      if (!playerId.startsWith("media_player.")) {
        if (!await this.getHaCompanionPlayer(playerId)) throw new Error("Waiting for phone audio");
        return await this.haMassCommand(command, args) as T;
      }
      const action = command.slice("players/cmd/".length);
      await this.callHaPlayerCommand(playerId, action, args);
      return undefined as T;
    }

    if (command.startsWith("player_queues/")) {
      const queueId = String(args?.queue_id || "");
      const action = command.slice("player_queues/".length);
      await this.callHaQueueCommand(queueId, action, args);
      return undefined as T;
    }

    throw new Error(`Home Assistant mode does not support ${command}`);
  }

  private async getHaCompanionPlayers(): Promise<Player[]> {
    if (!this.haCompanionDiscovery) return [];
    if (this.haCompanionPlayersInFlight) return this.haCompanionPlayersInFlight;
    if (this.haCompanionPlayersAt && Date.now() - this.haCompanionPlayersAt < 8_000) return this.haCompanionPlayers;
    const epoch = this.connectionEpoch;
    const run = (async () => {
      try {
        const ids = [...this.haCompanionPlayerIds];
        const players = ids.length
          ? (await Promise.all(ids.map(id => this.haMassCommand("players/get", { player_id: id }) as Promise<Player | null>))).filter((p): p is Player => !!p)
          : await this.haMassCommand("players/all", { return_unavailable: true, return_disabled: true }) as Player[];
        if (epoch !== this.connectionEpoch) return [];
        this.haCompanionPlayers = players.filter(isCompanionPhonePlayer);
        this.haCompanionPlayers.forEach(p => this.haCompanionPlayerIds.add(p.player_id));
      } catch {
        if (epoch !== this.connectionEpoch) return [];
        // Optional discovery must not break HA-only installations or retain stale readiness.
        this.haCompanionPlayers = this.haCompanionPlayers.map(p => ({ ...p, available: false }));
      }
      this.haCompanionPlayersAt = Date.now();
      return this.haCompanionPlayers;
    })();
    this.haCompanionPlayersInFlight = run;
    try { return await run; }
    finally { if (this.haCompanionPlayersInFlight === run) this.haCompanionPlayersInFlight = undefined; }
  }

  private async getHaCompanionPlayer(playerId: string): Promise<Player | null> {
    if (!this.haCompanionPlayers.some(p => p.player_id === playerId)) return null;
    const epoch = this.connectionEpoch;
    const player = await this.haMassCommand("players/get", { player_id: playerId }) as Player | null;
    if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed. Try again.");
    return player?.player_id === playerId && isCompanionPhonePlayer(player) ? player : null;
  }

  private haCompanionQueue(queue: PlayerQueue | null): PlayerQueue | null {
    if (!queue) return null;
    return { ...queue,
      current_item: queue.current_item ? this.haCompanionItem(queue.current_item) : undefined,
      next_item: queue.next_item ? this.haCompanionItem(queue.next_item) : undefined };
  }

  private haCompanionItem(item: QueueItem): QueueItem {
    const convert = (image?: MassImage): MassImage | undefined => image
      ? { path: "", provider: "music_assistant", url: imageUrl(REMOTE_ARTWORK_BASE, image, 256) } : undefined;
    const media = (value?: MediaItem): MediaItem | undefined => value ? { ...value,
      image: convert(value.image),
      metadata: value.metadata ? { ...value.metadata, images: value.metadata.images?.map(image => convert(image)!) } : undefined,
      album: value.album ? { ...value.album, image: convert(value.album.image),
        metadata: value.album.metadata ? { ...value.album.metadata, images: value.album.metadata.images?.map(image => convert(image)!) } : undefined } : undefined,
    } : undefined;
    return { ...item, image: convert(item.image), media_item: media(item.media_item) };
  }

  private async fetchHaCompanionArtwork(path: string): Promise<Blob> {
    const requested = new URL(path, REMOTE_ARTWORK_BASE);
    const haPicture = /^\/ha-media-player-proxy\/(media_player\.[a-z0-9_]+)$/.exec(requested.pathname);
    const sxmPicture = requested.pathname === "/siriusxm-artwork" ? siriusXmArtworkUrl(requested.searchParams.get("url") || "") : undefined;
    if (requested.origin !== REMOTE_ARTWORK_BASE || (!haPicture && !sxmPicture && !/^\/imageproxy(?:\/|$)/.test(requested.pathname)) || requested.hash) {
      throw new Error("Invalid Music Assistant artwork path");
    }
    const epoch = this.connectionEpoch;
    const assertCurrent = () => { if (epoch !== this.connectionEpoch) throw new Error("Artwork connection replaced"); };
    const ingress = haPicture || sxmPicture ? undefined : await this.ensureHaIngress();
    assertCurrent();
    const url = sxmPicture ? new URL(sxmPicture) : haPicture
      ? new URL(`/api/media_player_proxy/${haPicture[1]}${requested.search}`, this.haBaseUrl)
      : new URL(`.${requested.pathname}${requested.search}`, new URL(".", ingress!.url));
    if (!sxmPicture && (url.origin !== new URL(this.haBaseUrl).origin || (!haPicture && !url.pathname.startsWith("/api/hassio_ingress/")))) throw new Error("Invalid Music Assistant artwork route");
    const bridge = await importBridgeThingClient();
    try {
      assertCurrent();
      const result = await bridge.net.fetch({ request: { url: url.href, method: "GET",
        headers: ingress ? [{ name: "Cookie", value: `ingress_session=${ingress.session}` }] : [], body: null, timeoutMs: 15_000, redirect: "error",
      } }, { timeoutMs: 18_000 });
      assertCurrent();
      if (!result.ok) throw new Error("Music Assistant artwork request failed");
      const response = result.response.response;
      if ((response.status === 401 || response.status === 403) && ingress && this.haIngress === ingress) this.haIngress = undefined;
      if (response.status !== 200) throw new Error(`Music Assistant artwork failed (${response.status})`);
      const type = response.headers?.find(header => header.name.toLowerCase() === "content-type")?.value.split(";")[0] || "image/jpeg";
      if (!type.startsWith("image/")) throw new Error("Music Assistant did not return an image");
      return new Blob([response.body as BlobPart], { type });
    } finally { bridge.close(); }
  }

  private haPlayers(): Player[] {
    return this.haMediaStates().map((state) => this.haStateToPlayer(state));
  }

  private async haQueues(): Promise<PlayerQueue[]> {
    const queues = this.haMediaStates().map((state) => this.haStateToQueue(state));
    return Promise.all(
      queues.map((queue) =>
        this.hydrateHaQueue(queue)
          .then((hydrated) => {
            this.haHydratedQueues.set(hydrated.queue_id, hydrated);
            return this.mergeHaQueueState(queue.queue_id, queue);
          })
          .catch(() => this.mergeHaQueueState(queue.queue_id, queue)),
      ),
    );
  }

  private haMediaStates(): HaState[] {
    const states = [...this.haStates.values()].filter((state) => state.entity_id.startsWith("media_player."));
    const massStates = states.filter((state) => this.isHaMassMediaState(state));
    return massStates.length ? massStates : states;
  }

  private isHaMassMediaState(state: HaState): boolean {
    return typeof state.attributes.mass_player_type === "string";
  }

  private async discoverHaPlayerEntityIds(): Promise<string[]> {
    const epoch = this.connectionEpoch;
    try {
      const subscriptionId = this.haSequence + 1;
      const result = await this.haRequestWithPending<unknown>("render_template", { template: HA_MASS_PLAYER_TEMPLATE }, "template");
      if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
      void this.haRequest<null>("unsubscribe_events", { subscription: subscriptionId }).catch(() => undefined);
      const entityIds = typeof result === "string" ? JSON.parse(result) as unknown : result;
      if (Array.isArray(entityIds) && entityIds.every((entityId) => typeof entityId === "string")) {
        return entityIds;
      }
    } catch {
      if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
      // Fall back to the larger state call on older Home Assistant installs or restricted tokens.
    }
    const states = await this.haRequest<HaState[]>("get_states");
    if (epoch !== this.connectionEpoch) throw new Error("Connection replaced");
    const mediaStates = states.filter((state) => state.entity_id.startsWith("media_player."));
    const massStates = mediaStates.filter((state) => this.isHaMassMediaState(state));
    const playerStates = massStates.length ? massStates : mediaStates;
    this.haStates = new Map(playerStates.map((state) => [state.entity_id, state]));
    return playerStates.map((state) => state.entity_id);
  }

  private async refreshHaTrackedStates(): Promise<void> {
    if (this.haRefreshInFlight) return this.haRefreshInFlight;
    const run = (async () => {
      let entityIds = [...this.haStates.keys()];
      if (!entityIds.length) entityIds = await this.discoverHaPlayerEntityIds();
      if (!entityIds.length) return;
      const subscriptionId = this.haSequence + 1;
      await this.haRequestWithPending<null>("subscribe_entities", { entity_ids: entityIds }, "entities");
      void this.haRequest<null>("unsubscribe_events", { subscription: subscriptionId }).catch(() => undefined);
    })();
    this.haRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (this.haRefreshInFlight === run) this.haRefreshInFlight = undefined;
    }
  }

  private shouldTrackHaState(state: HaState): boolean {
    if (this.haStates.has(state.entity_id)) return true;
    return this.isHaMassMediaState(state);
  }

  private handleHaEntitySubscriptionEvent(event: HaEntitySubscriptionEvent): void {
    const upserts = { ...(event.a ?? {}), ...(event.c ?? {}) };
    Object.entries(upserts).forEach(([entityId, compact]) => {
      if (!entityId.startsWith("media_player.")) return;
      const previous = this.haStates.get(entityId);
      const state = this.expandHaCompactState(entityId, compact);
      if (!state || !this.shouldTrackHaState(state)) return;
      this.haStates.set(entityId, state);
      this.emitHaState(state);
      if (!this.priorityPhonePlayerId && this.haMediaIdentityChanged(previous, state)) void this.emitHydratedHaQueue(entityId);
    });
    const removed = Array.isArray(event.r) ? event.r : Object.keys(event.r ?? {});
    removed.forEach((entityId) => {
      this.haStates.delete(entityId);
    });
  }

  private expandHaCompactState(entityId: string, compact: HaCompactState): HaState | undefined {
    const previous = this.haStates.get(entityId);
    const state = compact.s ?? previous?.state;
    if (!state) return undefined;
    return {
      entity_id: entityId,
      state,
      attributes: {
        ...(previous?.attributes ?? {}),
        ...(compact.a ?? {}),
      },
    };
  }

  private emitHaState(state: HaState): void {
    const queue = this.mergeHaQueueState(state.entity_id, this.haStateToQueue(state));
    this.eventListeners.forEach((listener) => {
      listener({ event: "player_updated", object_id: state.entity_id, data: this.haStateToPlayer(state) });
      listener({ event: "queue_updated", object_id: state.entity_id, data: queue });
    });
  }

  private async emitHydratedHaQueue(entityId: string): Promise<void> {
    const state = this.haStates.get(entityId);
    if (!state) return;
    const sequence = (this.haQueueHydrationSequence.get(entityId) ?? 0) + 1;
    this.haQueueHydrationSequence.set(entityId, sequence);
    const queue = await this.hydrateHaQueue(this.haStateToQueue(state));
    if (this.haQueueHydrationSequence.get(entityId) !== sequence) return;
    this.haHydratedQueues.set(entityId, queue);
    const mergedQueue = this.mergeHaQueueState(entityId, this.haStateToQueue(state));
    this.eventListeners.forEach((listener) => {
      listener({ event: "queue_updated", object_id: entityId, data: mergedQueue });
    });
  }

  private async haAiRadioCommand(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const serviceArgs = { ...args };
    if (typeof serviceArgs.player_id_override === "string" && serviceArgs.player_id_override.startsWith("media_player.")) {
      const entityId = serviceArgs.player_id_override;
      const response = await this.getHaQueue(entityId);
      const queue = this.extractHaQueueEntry(response, entityId);
      const playerId = queue?.queue_id ?? queue?.player_id;
      if (typeof playerId !== "string" || playerId.startsWith("media_player.")) {
        throw new Error("Unable to resolve the selected Music Assistant player for AI Radio");
      }
      serviceArgs.player_id_override = playerId;
    }
    return this.haMassCommand(command, serviceArgs);
  }

  private async ensureHaIngress(): Promise<HaIngress> {
    if (this.haIngress && this.haIngress.expires > Date.now()) return this.haIngress;
    if (this.haIngressInFlight) return this.haIngressInFlight;
    const epoch = this.connectionEpoch;
    const assertCurrent = () => { if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed"); };
    const flight = (async () => {
      const panels = await this.haRequest<Record<string, { config?: { addon?: string }; title?: string }>>("get_panels");
      assertCurrent();
      const candidates = Object.values(panels).filter((panel) => panel.config?.addon && /music.?assistant/i.test(`${panel.title} ${panel.config.addon}`));
      if (candidates.length !== 1) throw new Error("Music Assistant needs a single add-on with Home Assistant ingress enabled");
      const slug = candidates[0].config!.addon!;
      const [info, session] = await Promise.all([
        this.haRequest<{ ingress_url?: string }>("supervisor/api", { endpoint: `/addons/${slug}/info`, method: "get" }),
        this.haRequest<{ session: string }>("supervisor/api", { endpoint: "/ingress/session", method: "post" }),
      ]);
      assertCurrent();
      if (!info.ingress_url || !session.session) throw new Error("Music Assistant ingress is unavailable");
      const url = new URL(`${info.ingress_url.replace(/\/$/, "")}/api`, this.haBaseUrl);
      if (url.origin !== new URL(this.haBaseUrl).origin || !url.pathname.startsWith("/api/hassio_ingress/")) {
        throw new Error("Invalid Music Assistant ingress route");
      }
      this.haIngress = { url: url.href, session: session.session, expires: Date.now() + 60_000 };
      return this.haIngress;
    })();
    this.haIngressInFlight = flight;
    try { return await flight; }
    finally { if (this.haIngressInFlight === flight) this.haIngressInFlight = undefined; }
  }

  private async haMassCommand(command: string, serviceArgs?: Record<string, unknown>): Promise<unknown> {
    const feature = command.startsWith("ai_radio/") ? "AI Radio"
      : /(?:set_members|ungroup|create_group_player)$/.test(command) ? "Player groups" : "Music Assistant";
    const epoch = this.connectionEpoch;
    const assertCurrent = () => { if (epoch !== this.connectionEpoch) throw new Error("Music Assistant connection changed"); };
    const ingress = await this.ensureHaIngress();
    assertCurrent();
    const bridge = await importBridgeThingClient();
    try {
      assertCurrent();
      const result = await bridge.net.fetch({ request: {
        url: ingress.url,
        method: "POST",
        headers: [
          { name: "Cookie", value: `ingress_session=${ingress.session}` },
          { name: "Content-Type", value: "application/json" },
        ],
        body: new TextEncoder().encode(JSON.stringify({ message_id: `ai-${++this.sequence}`, command, args: serviceArgs })),
        timeoutMs: 25_000,
        redirect: "error",
      } }, { timeoutMs: 30_000 });
      assertCurrent();
      if (!result.ok) throw new Error(`${feature} request failed through the BridgeThing companion`);
      this.recordServerResponse();
      const response = result.response.response;
      if (response.status < 200 || response.status >= 300) {
        if ((response.status === 401 || response.status === 403) && this.haIngress === ingress) this.haIngress = undefined;
        throw new Error(response.status === 400 || response.status === 404
          ? `${feature} command was rejected by Music Assistant. Refresh and try again.`
          : `${feature} request failed (${response.status})`);
      }
      return JSON.parse(new TextDecoder().decode(response.body));
    } finally {
      bridge.close();
    }
  }

  private async haSearch(args?: Record<string, unknown>): Promise<Record<string, MediaItem[]>> {
    const searchQuery = String(args?.search_query || args?.name || "").trim();
    if (!searchQuery) return {};
    const response = await this.callHaAction("music_assistant", "search", undefined, {
      config_entry_id: this.requireHaMassConfigEntryId(),
      name: searchQuery,
      limit: Number(args?.limit || 50),
    });
    const groups = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(groups).map(([key, value]) => [key, this.normalizeHaMediaItems(value, key.replace(/s$/, ""))]),
    );
  }

  private async haLibrary(command: string, args?: Record<string, unknown>): Promise<MediaItem[]> {
    const mediaTypeByCommand: Record<string, string> = {
      "music/playlists/library_items": "playlist",
      "music/albums/library_items": "album",
      "music/artists/library_items": "artist",
      "music/radios/library_items": "radio",
      "music/tracks/library_items": "track",
      "music/recently_played_items": "track",
    };
    const mediaType = mediaTypeByCommand[command];
    if (!mediaType) throw new Error(`Home Assistant mode does not support ${command}`);
    const response = await this.callHaAction("music_assistant", "get_library", undefined, {
      config_entry_id: this.requireHaMassConfigEntryId(),
      media_type: mediaType,
      limit: Number(args?.limit || 100),
      offset: Number(args?.offset || 0),
      favorite: args?.favorite === null ? undefined : args?.favorite,
      search: typeof args?.search === "string" ? args.search : undefined,
      order_by: typeof args?.order_by === "string" ? args.order_by : command === "music/recently_played_items" ? "name" : undefined,
    });
    return this.normalizeHaMediaItems((response as { items?: unknown })?.items ?? response, mediaType);
  }

  private async haQueueItems(queueId: string): Promise<QueueItem[]> {
    if (!queueId) return [];
    const response = await this.getHaQueue(queueId);
    const entry = this.extractHaQueueEntry(response, queueId);
    return this.haQueueCandidates(entry)
      .map((item: unknown, index: number) => this.normalizeHaQueueItem(item, index))
      .filter(Boolean) as QueueItem[];
  }

  private async hydrateHaQueue(queue: PlayerQueue): Promise<PlayerQueue> {
    const response = await this.getHaQueue(queue.queue_id);
    const entry = this.extractHaQueueEntry(response, queue.queue_id);
    if (!entry || typeof entry !== "object") return queue;
    const record = entry as Record<string, any>;
    const currentIndex = numberOrUndefined(
      record.current_index ?? record.index_in_buffer ?? record.current_item_index ?? queue.current_index,
    );
    const candidates = this.haQueueCandidates(record);
    const indexedItem = currentIndex !== undefined && currentIndex >= 0 ? candidates[currentIndex] : undefined;
    const currentItem =
      this.normalizeHaQueueItem(record.current_item ?? record.current ?? record.active_item ?? indexedItem, currentIndex ?? 0) ??
      queue.current_item;
    const nextItem =
      this.normalizeHaQueueItem(record.next_item ?? candidates[(currentIndex ?? -1) + 1], (currentIndex ?? 0) + 1) ??
      queue.next_item;
    const elapsed = numberOrUndefined(record.elapsed_time ?? record.media_position ?? record.corrected_elapsed_time);
    const elapsedUpdated =
      numberOrUndefined(record.elapsed_time_last_updated) ??
      dateSecondsOrUndefined(record.elapsed_time_last_updated) ??
      dateSecondsOrUndefined(record.media_position_updated_at);
    const repeat = record.repeat_mode ?? record.repeat;

    return {
      ...queue,
      state: String(record.state ?? queue.state),
      active: typeof record.active === "boolean" ? record.active : queue.active,
      shuffle_enabled: typeof record.shuffle_enabled === "boolean" ? record.shuffle_enabled : queue.shuffle_enabled,
      repeat_mode: repeat === "one" || repeat === "all" ? repeat : repeat === "off" ? "off" : queue.repeat_mode,
      elapsed_time: elapsed ?? queue.elapsed_time,
      elapsed_time_last_updated: elapsedUpdated ?? queue.elapsed_time_last_updated,
      current_item: currentItem,
      next_item: nextItem,
      current_index: currentIndex ?? queue.current_index,
      index_in_buffer: numberOrUndefined(record.index_in_buffer) ?? queue.index_in_buffer,
      items: numberOrUndefined(record.items) ?? numberOrUndefined(record.queue_size) ?? (candidates.length || queue.items),
    };
  }

  private haQueueCandidates(entry: any): unknown[] {
    return (
      (Array.isArray(entry?.queue_items) && entry.queue_items) ||
      (Array.isArray(entry?.items) && entry.items) ||
      (Array.isArray(entry?.queue) && entry.queue) ||
      [entry?.current_item, entry?.next_item].filter(Boolean)
    );
  }

  private async callHaPlayerCommand(playerId: string, action: string, args?: Record<string, unknown>): Promise<void> {
    const serviceByAction: Record<string, string> = {
      play_pause: "media_play_pause",
      previous: "media_previous_track",
      next: "media_next_track",
    };
    if (action === "volume_set") {
      await this.callHaService("media_player", "volume_set", playerId, {
        volume_level: Math.max(0, Math.min(1, Number(args?.volume_level ?? 0) / 100)),
      });
      return;
    }
    const service = serviceByAction[action];
    if (!service) throw new Error(`Home Assistant mode does not support player command ${action}`);
    await this.callHaService("media_player", service, playerId);
  }

  private async callHaQueueCommand(queueId: string, action: string, args?: Record<string, unknown>): Promise<void> {
    if (action === "shuffle") {
      await this.callHaService("media_player", "shuffle_set", queueId, { shuffle: args?.shuffle_enabled === true });
      return;
    }
    if (action === "repeat") {
      await this.callHaService("media_player", "repeat_set", queueId, { repeat: args?.repeat_mode || "off" });
      return;
    }
    if (action === "play_media") {
      await this.callHaAction("music_assistant", "play_media", queueId, {
        media_id: args?.media,
        media_type: args?.media_type || "track",
        enqueue: args?.option || args?.enqueue || "replace",
        radio_mode: args?.radio_mode === true ? true : undefined,
      }, false);
      return;
    }
    throw new Error(`Queue ${action} is not available in Home Assistant mode yet`);
  }

  private async callHaService(
    domain: string,
    service: string,
    entityId: string,
    serviceData: Record<string, unknown> = {},
  ): Promise<void> {
    if (!entityId) throw new Error("Select a Home Assistant media player first");
    await this.callHaAction(domain, service, entityId, serviceData, false);
  }

  private async callHaAction(
    domain: string,
    service: string,
    entityId?: string,
    serviceData: Record<string, unknown> = {},
    returnResponse = true,
  ): Promise<unknown> {
    const payload: Record<string, unknown> = {
      domain,
      service,
      service_data: compactRecord(serviceData),
    };
    if (returnResponse) payload.return_response = true;
    if (entityId) payload.target = { entity_id: entityId };
    const result = await this.haRequest<{ response?: unknown }>("call_service", payload);
    const state = entityId ? this.haStates.get(entityId) : undefined;
    if (state) {
      const queue = this.mergeHaQueueState(state.entity_id, this.haStateToQueue(state));
      this.eventListeners.forEach((listener) => {
        listener({ event: "player_updated", object_id: entityId, data: this.haStateToPlayer(state) });
        listener({ event: "queue_updated", object_id: entityId, data: queue });
      });
    }
    return result?.response;
  }

  private async getHaQueue(entityId: string): Promise<unknown> {
    return this.callHaAction("music_assistant", "get_queue", entityId);
  }

  private extractHaQueueEntry(response: unknown, entityId: string): any {
    if (!response || typeof response !== "object") return undefined;
    const record = response as Record<string, unknown>;
    return record[entityId] ?? record.queue ?? record;
  }

  private requireHaMassConfigEntryId(): string {
    if (this.haMassConfigEntryId) return this.haMassConfigEntryId;
    throw new Error("No Music Assistant integration entry found in Home Assistant");
  }

  private normalizeHaMediaItems(value: unknown, fallbackType = "track"): MediaItem[] {
    const items = Array.isArray(value) ? value : Array.isArray((value as { items?: unknown[] })?.items) ? (value as { items: unknown[] }).items : [];
    return items.map((item) => this.normalizeHaMediaItem(item, fallbackType)).filter(Boolean) as MediaItem[];
  }

  private normalizeHaMediaItem(item: unknown, fallbackType = "track"): MediaItem | undefined {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, any>;
    const uri = String(record.uri ?? record.media_id ?? record.media_content_id ?? record.item_id ?? record.name ?? "");
    const name = String(record.name ?? record.title ?? record.media_title ?? uri);
    if (!uri || !name) return undefined;
    const mediaType = String(record.media_type ?? record.media_content_type ?? fallbackType).replace(/s$/, "");
    const image = this.normalizeHaImage(
      record.image ??
        record.thumbnail ??
        record.image_url ??
        record.media_image_url ??
        record.artwork ??
        record.cover ??
        record.metadata?.images?.[0] ??
        record.images?.[0] ??
        record.album?.image ??
        record.album?.thumbnail ??
        record.album?.metadata?.images?.[0],
    );
    return {
      uri,
      item_id: String(record.item_id ?? record.media_id ?? uri),
      provider: String(record.provider ?? record.provider_id ?? "music_assistant"),
      name,
      media_type: mediaType,
      favorite: record.favorite,
      image,
      metadata: record.metadata,
      artists: Array.isArray(record.artists)
        ? record.artists.map((artist: any) => ({ name: String(artist.name ?? artist) }))
        : record.artist
        ? [{ name: String(record.artist) }]
        : undefined,
      album: record.album
        ? typeof record.album === "string"
          ? {
              uri: `${uri}:album`,
              item_id: `${uri}:album`,
              provider: "music_assistant",
              name: record.album,
              media_type: "album",
            }
          : this.normalizeHaMediaItem(record.album, "album")
        : undefined,
      owner: record.owner,
    };
  }

  private normalizeHaQueueItem(item: unknown, index: number): QueueItem | undefined {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, any>;
    const media = this.normalizeHaMediaItem(record.media_item ?? record, record.media_type ?? "track");
    const name = String(record.name ?? record.title ?? media?.name ?? "");
    if (!name) return undefined;
    return {
      queue_item_id: String(record.queue_item_id ?? record.item_id ?? record.uri ?? `${index}`),
      name,
      duration: typeof record.duration === "number" ? record.duration : media && typeof (media as any).duration === "number" ? (media as any).duration : undefined,
      image: this.normalizeHaImage(record.image) ?? media?.image,
      media_item: media,
    };
  }

  private normalizeHaImage(value: unknown): MassImage | undefined {
    if (!value) return undefined;
    if (Array.isArray(value)) return this.normalizeHaImage(value[0]);
    if (typeof value === "string") return this.haEntityImage(value);
    if (typeof value !== "object") return undefined;
    const record = value as Partial<MassImage> & {
      artwork?: unknown;
      cover?: unknown;
      image?: unknown;
      images?: unknown[];
      thumbnail?: unknown;
      thumbnails?: unknown[];
      url?: string;
    };
    if (record.url) return this.haEntityImage(record.url);
    if (record.path || record.proxy_id) return { provider: "music_assistant", ...record } as MassImage;
    return (
      this.normalizeHaImage(record.image) ??
      this.normalizeHaImage(record.thumbnail) ??
      this.normalizeHaImage(record.artwork) ??
      this.normalizeHaImage(record.cover) ??
      this.normalizeHaImage(record.images?.[0]) ??
      this.normalizeHaImage(record.thumbnails?.[0])
    );
  }

  private haStateToPlayer(state: HaState): Player {
    const attributes = state.attributes;
    const volume = typeof attributes.volume_level === "number" ? Math.round(attributes.volume_level * 100) : 0;
    return {
      player_id: state.entity_id,
      display_name: attributes.friendly_name,
      name: attributes.friendly_name || state.entity_id.replace(/^media_player\./, "").replace(/_/g, " "),
      available: state.state !== "unavailable" && state.state !== "unknown",
      powered: state.state !== "off" && state.state !== "unavailable" && state.state !== "unknown",
      volume_level: volume,
      type: typeof attributes.mass_player_type === "string" ? attributes.mass_player_type : undefined,
      group_members: Array.isArray(attributes.group_members) ? attributes.group_members.filter((id: unknown): id is string => typeof id === "string") : undefined,
      volume_muted: attributes.is_volume_muted,
      state: state.state,
      active_source: state.entity_id,
    };
  }

  private haStateToQueue(state: HaState): PlayerQueue {
    const attributes = state.attributes;
    const item = this.haStateToQueueItem(state);
    const repeat = attributes.repeat;
    return {
      queue_id: state.entity_id,
      display_name: attributes.friendly_name || state.entity_id,
      active: state.state === "playing" || state.state === "paused",
      available: state.state !== "unavailable" && state.state !== "unknown",
      shuffle_enabled: attributes.shuffle === true,
      repeat_mode: repeat === "one" || repeat === "all" ? repeat : "off",
      state: state.state,
      elapsed_time: typeof attributes.media_position === "number" ? attributes.media_position : 0,
      elapsed_time_last_updated: attributes.media_position_updated_at
        ? Date.parse(attributes.media_position_updated_at) / 1000
        : Date.now() / 1000,
      current_item: item,
      current_index: item ? 0 : undefined,
      index_in_buffer: item ? 0 : undefined,
      items: item ? 1 : 0,
    };
  }

  private mergeHaQueueState(queueId: string, base: PlayerQueue): PlayerQueue {
    const hydrated = this.haHydratedQueues.get(queueId);
    if (!hydrated?.current_item) return base;
    const currentItem = this.shouldPreferHaCurrentItem(base, hydrated) ? base.current_item : hydrated.current_item;
    return {
      ...hydrated,
      display_name: base.display_name,
      active: base.active,
      available: base.available,
      shuffle_enabled: base.shuffle_enabled,
      repeat_mode: base.repeat_mode,
      state: base.state,
      elapsed_time: base.elapsed_time,
      elapsed_time_last_updated: base.elapsed_time_last_updated,
      current_item: currentItem,
    };
  }

  private shouldPreferHaCurrentItem(base: PlayerQueue, hydrated: PlayerQueue): boolean {
    if (!base.current_item) return false;
    const baseMedia = base.current_item.media_item;
    if (!baseMedia) return false;

    const baseTitle = normalizeText(baseMedia.name || base.current_item.name);
    const station = normalizeText(baseMedia.album?.name);
    const artists = (baseMedia.artists ?? []).map((artist) => normalizeText(artist.name)).filter(Boolean);
    const hasSpecificArtist = artists.some((artist) => !GENERIC_HA_RADIO_ARTISTS.has(artist));
    const titleDiffersFromStation = !!baseTitle && !!station && baseTitle !== station;
    if (!hasSpecificArtist && !titleDiffersFromStation) return false;

    const hydratedMedia = hydrated.current_item?.media_item;
    const hydratedTitle = normalizeText(hydratedMedia?.name || hydrated.current_item?.name);
    const hydratedArtists = (hydratedMedia?.artists ?? []).map((artist) => normalizeText(artist.name)).filter(Boolean);
    const hydratedLooksLikeStation =
      hydratedMedia?.media_type === "radio" ||
      hydratedArtists.some((artist) => GENERIC_HA_RADIO_ARTISTS.has(artist)) ||
      (!!station && hydratedTitle === station);

    return hydratedLooksLikeStation || titleDiffersFromStation;
  }

  private haStateToQueueItem(state: HaState): QueueItem | undefined {
    const attributes = state.attributes;
    const title = attributes.media_title || attributes.friendly_name;
    if (!title) return undefined;
    const sxmPicture = siriusXmArtworkUrl(attributes.entity_picture);
    const image = sxmPicture
      ? { url: `${REMOTE_ARTWORK_BASE}/siriusxm-artwork?url=${encodeURIComponent(sxmPicture)}`, path: "", provider: "siriusxm" }
      : this.haEntityImage(attributes.entity_picture_local || attributes.entity_picture);
    const media: MediaItem = {
      uri: attributes.media_content_id || state.entity_id,
      item_id: attributes.media_content_id || state.entity_id,
      provider: "home_assistant",
      name: title,
      media_type: attributes.media_content_type || "track",
      image,
      artists: attributes.media_artist ? [{ name: attributes.media_artist }] : undefined,
      album: attributes.media_album_name
        ? {
            uri: `${state.entity_id}:album`,
            item_id: `${state.entity_id}:album`,
            provider: "home_assistant",
            name: attributes.media_album_name,
            media_type: "album",
            image,
          }
        : undefined,
    };
    return {
      queue_item_id: attributes.media_content_id || state.entity_id,
      name: title,
      duration: typeof attributes.media_duration === "number" ? attributes.media_duration : undefined,
      image,
      media_item: media,
    };
  }

  private haMediaIdentityChanged(previous: HaState | undefined, next: HaState): boolean {
    if (!previous) return true;
    const previousAttributes = previous.attributes;
    const nextAttributes = next.attributes;
    return (
      previous.state !== next.state ||
      previousAttributes.media_title !== nextAttributes.media_title ||
      previousAttributes.media_artist !== nextAttributes.media_artist ||
      previousAttributes.media_album_name !== nextAttributes.media_album_name ||
      previousAttributes.media_content_id !== nextAttributes.media_content_id ||
      previousAttributes.media_content_type !== nextAttributes.media_content_type ||
      previousAttributes.media_duration !== nextAttributes.media_duration ||
      previousAttributes.entity_picture !== nextAttributes.entity_picture ||
      previousAttributes.entity_picture_local !== nextAttributes.entity_picture_local
    );
  }

  private haEntityImage(path?: string): MassImage | undefined {
    if (!path) return undefined;
    if (this.haBaseUrl) {
      try {
        const url = new URL(path, this.haBaseUrl);
        const picture = /^\/api\/media_player_proxy\/(media_player\.[a-z0-9_]+)$/.exec(url.pathname);
        if (url.origin === new URL(this.haBaseUrl).origin && picture) {
          return { url: `${REMOTE_ARTWORK_BASE}/ha-media-player-proxy/${picture[1]}${url.search}`, path: "", provider: "home_assistant" };
        }
      } catch { return undefined; }
    }
    if (/^https?:\/\//.test(path)) return { url: path, path: "", provider: "home_assistant" };
    return { url: `${this.haBaseUrl}${path.startsWith("/") ? "" : "/"}${path}`, path: "", provider: "home_assistant" };
  }
}

type HaState = {
  entity_id: string;
  state: string;
  attributes: HaMediaAttributes;
};

type HaConfigEntry = {
  entry_id: string;
  domain?: string;
  state?: string;
};

type HaMediaAttributes = {
  entity_picture_local?: string;
  friendly_name?: string;
  volume_level?: number;
  is_volume_muted?: boolean;
  media_title?: string;
  media_artist?: string;
  media_album_name?: string;
  media_content_id?: string;
  media_content_type?: string;
  media_duration?: number;
  media_position?: number;
  media_position_updated_at?: string;
  entity_picture?: string;
  shuffle?: boolean;
  repeat?: string;
  mass_player_type?: string;
  group_members?: string[];
};

type HaMessage =
  | { type: "auth_required"; ha_version?: string }
  | { type: "auth_ok"; ha_version?: string }
  | { type: "auth_invalid"; message?: string }
  | { type: "pong"; id: number }
  | HaResultMessage
  | HaEventMessage;

type HaResultMessage = {
  id: number;
  type: "result";
  success: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
};

type HaEventMessage = {
  id: number;
  type: "event";
  event?: HaEntitySubscriptionEvent & {
    result?: unknown;
    event_type?: string;
    data?: {
      entity_id?: string;
      new_state?: HaState;
      old_state?: HaState;
    };
  };
};

type HaCompactState = {
  s?: string;
  a?: Partial<HaMediaAttributes>;
};

type HaEntitySubscriptionEvent = {
  a?: Record<string, HaCompactState>;
  c?: Record<string, HaCompactState>;
  r?: Record<string, unknown> | string[];
};

function createNativeSocket(socket: WebSocket): TransportSocket {
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: () => {
      try {
        socket.close();
      } catch {
        // Ignore close failures while replacing a connection.
      }
    },
  };
}

function createBridgeThingSocket(
  url: string,
  onMessage: (data: string) => void,
  onClose: () => void,
): TransportSocket {
  const connectionId =
    crypto.randomUUID?.() ?? `ma-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let open = false;
  let closed = false;
  const sendQueue: string[] = [];
  let client: Awaited<ReturnType<typeof importBridgeThingClient>> | undefined;
  let removeMessage: (() => void) | undefined;
  let removeClosed: (() => void) | undefined;
  let removeError: (() => void) | undefined;
  let opening = false;
  let openRequested = false;
  let cleanup: Promise<void> | undefined;

  const detach = () => {
    removeMessage?.();
    removeClosed?.();
    removeError?.();
    sendQueue.length = 0;
  };
  const closeRemote = (): Promise<void> => {
    if (cleanup) return cleanup;
    const owner = client;
    cleanup = (async () => {
      try {
        if (owner && openRequested) await owner.net.wsClose({ connectionId, code: 1000, reason: "client closed" });
      } catch { /* The phone may already be out of range. */ }
      finally { owner?.close(); }
    })();
    return cleanup;
  };

  const sendFrame = (data: string) => {
    if (!client || !open || closed) return;
    void client.net.wsSend({ connectionId, frame: { type: "text", data } }).catch(() => {
      open = false;
      if (!closed) onClose();
    });
  };

  const ready = (async () => {
    client = await importBridgeThingClient();
    if (closed) { await closeRemote(); return; }
    removeMessage = client.net.onWsMessage((message) => {
      if (closed || message.connectionId !== connectionId || message.frame.type !== "text") return;
      onMessage(message.frame.data);
    });
    removeClosed = client.net.onWsClosed((message) => {
      if (message.connectionId !== connectionId) return;
      open = false;
      if (!closed) onClose();
    });
    removeError = client.net.onWsErrorEvent((message) => {
      if (message.connectionId !== connectionId) return;
      open = false;
      if (!closed) onClose();
    });

    openRequested = true;
    opening = true;
    let result;
    try {
      result = await client.net.wsOpen(
        { connectionId, url, protocols: null, headers: null },
        { timeoutMs: 12_000 },
      );
    } finally { opening = false; }
    if (closed) { await closeRemote(); return; }
    if (!result.ok) {
      const detail =
        result.kind === "domain"
          ? JSON.stringify(result.error.error)
          : JSON.stringify(result.error);
      throw new Error(`BridgeThing could not open Music Assistant WebSocket: ${detail}`);
    }
    open = true;
    while (sendQueue.length) sendFrame(sendQueue.shift()!);
  })().catch(async (error) => {
    closed = true;
    open = false;
    detach();
    await closeRemote();
    throw error;
  });

  const socket: TransportSocket = {
    ready,
    isOpen: () => open && !closed,
    send: (data) => {
      if (closed) return;
      if (!open) {
        sendQueue.push(data);
        return;
      }
      sendFrame(data);
    },
    close: () => {
      if (closed) return;
      closed = true;
      open = false;
      detach();
      // Let an in-flight open settle before closing its remote socket and SDK owner.
      if (client && !opening) void closeRemote();
    },
  };
  return socket;
}

async function importBridgeThingClient() {
  const { BridgethingClient } = await import("@bridgething/client");
  return new BridgethingClient();
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function dateSecondsOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time / 1000 : undefined;
}
