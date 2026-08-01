import type { MassEvent, MassImage, MediaItem, Player, PlayerQueue, QueueItem } from "../types";

type MassTransport = "direct" | "bridgething" | "homeassistant";

const HA_CONNECT_TIMEOUT_MS = 30_000;
const HA_COMMAND_TIMEOUT_MS = 12_000;
const HA_MASS_PLAYER_TEMPLATE = `{{ states.media_player | selectattr('attributes.mass_player_type', 'defined') | map(attribute='entity_id') | list | tojson }}`;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  parts: unknown[];
  timeout: number;
  eventResult?: "template" | "entities";
};

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
  private haSequence = 0;
  private serverReady?: () => void;
  private protocol: "mass" | "ha" = "mass";
  private haBaseUrl = "";
  private haStates = new Map<string, HaState>();
  private haMassConfigEntryId = "";
  private haRefreshInFlight?: Promise<void>;
  private haHydratedQueues = new Map<string, PlayerQueue>();
  private haQueueHydrationSequence = new Map<string, number>();

  async connect(serverUrl: string, token?: string, transport: MassTransport = "direct"): Promise<void> {
    this.disconnect();
    const base = serverUrl.replace(/\/$/, "");
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
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        this.rejectPending(error);
        reject(error);
      };
      const handleClose = () => {
        this.socket = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
        }
        this.rejectPending(new Error("Music Assistant connection closed"));
        this.closeListeners.forEach((listener) => listener());
      };
      const handleMessage = (rawData: string) => {
        const data = JSON.parse(rawData) as Record<string, unknown>;
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
      }, 12_000);

      this.serverReady = async () => {
        try {
          if (token) await this.command("auth", { token, device_name: "Car Thing" });
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };

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
    if (!this.socket?.isOpen()) {
      return Promise.reject(new Error("Music Assistant is not connected"));
    }
    const messageId = `ct-${Date.now()}-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Music Assistant command timed out: ${command}`));
      }, 15_000);
      this.pending.set(messageId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        parts: [],
        timeout,
      });
      this.socket!.send(JSON.stringify({ message_id: messageId, command, args }));
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

  disconnect(): void {
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
      pending.reject(new Error(String(message.details ?? message.error_code)));
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
    if (!token) throw new Error("Home Assistant long-lived access token is required");
    base = new URL(base).origin;
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
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
        this.rejectPending(error);
        reject(error);
      };
      const handleClose = () => {
        this.socket = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.rejectPending(new Error("Home Assistant connection closed"));
          this.closeListeners.forEach((listener) => listener());
        }
      };
      const handleMessage = (rawData: string) => {
        const data = JSON.parse(rawData) as HaMessage;
        if (data.type === "auth_required") {
          this.socket?.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (data.type === "auth_invalid") {
          fail(new Error("Home Assistant rejected the access token"));
          return;
        }
        if (data.type === "auth_ok") {
          void this.finishHomeAssistantConnect().then(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
          }, (error) => fail(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        if (data.type === "result") {
          this.handleHaResult(data);
          return;
        }
        if (data.type === "event") this.handleHaEvent(data);
      };

      timeout = window.setTimeout(() => fail(new Error("Home Assistant did not respond")), HA_CONNECT_TIMEOUT_MS);
      const socket = createBridgeThingSocket(wsUrl, handleMessage, handleClose);
      this.socket = socket;
      void socket.ready?.catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async finishHomeAssistantConnect(): Promise<void> {
    await this.loadHomeAssistantConfigEntry();
    const entityIds = await this.discoverHaPlayerEntityIds();
    if (entityIds.length) {
      await this.haRequestWithPending<null>("subscribe_entities", { entity_ids: entityIds }, "entities");
    }
  }

  private async loadHomeAssistantConfigEntry(): Promise<void> {
    try {
      const entries = await this.haRequest<HaConfigEntry[]>("config_entries/get", { domain: "music_assistant" });
      this.haMassConfigEntryId = entries.find((entry) => entry.state === "loaded")?.entry_id || entries[0]?.entry_id || "";
    } catch {
      this.haMassConfigEntryId = "";
    }
  }

  private haRequest<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return this.haRequestWithPending<T>(type, payload);
  }

  private haRequestWithPending<T>(
    type: string,
    payload: Record<string, unknown> = {},
    eventResult?: Pending["eventResult"],
  ): Promise<T> {
    if (!this.socket?.isOpen()) {
      return Promise.reject(new Error("Home Assistant is not connected"));
    }
    const messageId = ++this.haSequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(String(messageId));
        reject(new Error(`Home Assistant command timed out: ${type}`));
      }, HA_COMMAND_TIMEOUT_MS);
      this.pending.set(String(messageId), {
        resolve: resolve as (value: unknown) => void,
        reject,
        parts: [],
        timeout,
        eventResult,
      });
      this.socket!.send(JSON.stringify({ id: messageId, type, ...payload }));
    });
  }

  private handleHaResult(message: HaResultMessage): void {
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    if (!message.success) {
      this.pending.delete(String(message.id));
      clearTimeout(pending.timeout);
      pending.reject(new Error(message.error?.message || message.error?.code || "Home Assistant command failed"));
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
    if (this.haMediaIdentityChanged(previous, entity)) void this.emitHydratedHaQueue(entity.entity_id);
  }

  private async haCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (command === "players/all") {
      await this.refreshHaTrackedStates();
      return this.haPlayers() as T;
    }
    if (command === "player_queues/all") {
      await this.refreshHaTrackedStates();
      return (await this.haQueues()) as T;
    }
    if (command === "player_queues/items") return (await this.haQueueItems(String(args?.queue_id || ""))) as T;
    if (command === "music/search") return (await this.haSearch(args)) as T;
    if (command.startsWith("music/")) return (await this.haLibrary(command, args)) as T;

    if (command.startsWith("players/cmd/")) {
      const playerId = String(args?.player_id || "");
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
            return hydrated;
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
    try {
      const subscriptionId = this.haSequence + 1;
      const result = await this.haRequestWithPending<unknown>("render_template", { template: HA_MASS_PLAYER_TEMPLATE }, "template");
      void this.haRequest<null>("unsubscribe_events", { subscription: subscriptionId }).catch(() => undefined);
      const entityIds = typeof result === "string" ? JSON.parse(result) as unknown : result;
      if (Array.isArray(entityIds) && entityIds.every((entityId) => typeof entityId === "string")) {
        return entityIds;
      }
    } catch {
      // Fall back to the larger state call on older Home Assistant installs or restricted tokens.
    }
    const states = await this.haRequest<HaState[]>("get_states");
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
      if (this.haMediaIdentityChanged(previous, state)) void this.emitHydratedHaQueue(entityId);
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
    this.eventListeners.forEach((listener) => {
      listener({ event: "queue_updated", object_id: entityId, data: queue });
    });
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
      order_by: command === "music/recently_played_items" ? "name" : undefined,
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
        enqueue: "replace",
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
    };
  }

  private haStateToQueueItem(state: HaState): QueueItem | undefined {
    const attributes = state.attributes;
    const title = attributes.media_title || attributes.friendly_name;
    if (!title) return undefined;
    const image = this.haEntityImage(attributes.entity_picture);
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
      previousAttributes.entity_picture !== nextAttributes.entity_picture
    );
  }

  private haEntityImage(path?: string): MassImage | undefined {
    if (!path) return undefined;
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
};

type HaMessage =
  | { type: "auth_required"; ha_version?: string }
  | { type: "auth_ok"; ha_version?: string }
  | { type: "auth_invalid"; message?: string }
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

  const sendFrame = (data: string) => {
    if (!client || !open || closed) return;
    void client.net.wsSend({ connectionId, frame: { type: "text", data } }).catch(() => {
      open = false;
      if (!closed) onClose();
    });
  };

  const ready = (async () => {
    client = await importBridgeThingClient();
    removeMessage = client.net.onWsMessage((message) => {
      if (message.connectionId !== connectionId || message.frame.type !== "text") return;
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

    const result = await client.net.wsOpen(
      { connectionId, url, protocols: null, headers: null },
      { timeoutMs: 12_000 },
    );
    if (!result.ok) {
      const detail =
        result.kind === "domain"
          ? JSON.stringify(result.error.error)
          : JSON.stringify(result.error);
      throw new Error(`BridgeThing could not open Music Assistant WebSocket: ${detail}`);
    }
    open = true;
    while (sendQueue.length) sendFrame(sendQueue.shift()!);
  })().catch((error) => {
    closed = true;
    open = false;
    removeMessage?.();
    removeClosed?.();
    removeError?.();
    client?.close();
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
      removeMessage?.();
      removeClosed?.();
      removeError?.();
      if (!client) return;
      void client.net.wsClose({ connectionId, code: 1000, reason: "client closed" }).finally(() => {
        client?.close();
      });
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

function numberOrUndefined(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function dateSecondsOrUndefined(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time / 1000 : undefined;
}
