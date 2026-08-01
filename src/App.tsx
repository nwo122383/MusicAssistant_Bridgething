import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Album,
  ArrowLeft,
  Bluetooth,
  CircleAlert,
  Disc3,
  Heart,
  Home,
  ListMusic,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Repeat,
  Repeat1,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Speaker,
  Sun,
  Trash2,
  Usb,
  Volume2,
} from "lucide-react";
import { useHardware } from "./hooks/useHardware";
import {
  applyBridgeThingBrightness,
  isBridgeThingRuntime,
  loadBridgeThingPreferences,
  readBridgeThingBrightness,
  subscribeBridgeThingConfig,
  subscribeBridgeThingDocs,
} from "./lib/bridgething";
import { imageUrl, itemImage } from "./lib/images";
import { MassClient } from "./lib/MassClient";
import {
  loadBrightnessPreference,
  loadConfig,
  loadDisplaySize,
  loadNowPlayingTextSize,
  loadPlayerId,
  loadPresets,
  saveBrightnessPreference,
  saveConfig,
  saveDisplaySize,
  saveNowPlayingTextSize,
  savePlayerId,
  savePresets,
} from "./lib/storage";
import type { BrightnessPreference, DisplaySize, NowPlayingTextSize } from "./lib/storage";
import type {
  ConnectionConfig,
  ConnectionState,
  MassEvent,
  MediaItem,
  Player,
  PlayerQueue,
  Preset,
  QueueItem,
} from "./types";

type View = "now" | "library" | "players" | "queue" | "settings";
type LibraryKind = "recent" | "playlists" | "albums" | "artists" | "radio";
type RepeatMode = "off" | "all" | "one";
const LIBRARY_PAGE_SIZE = 100;
const VOLUME_COMMAND_DELAY_MS = 500;
const VOLUME_OVERLAY_HIDE_MS = 3_000;
const PLAYING_POSITION_FRESH_MS = 15_000;
const EXTERNAL_PLAYBACK_REFRESH_MS = 4_000;
const SIDE_BY_SIDE_PATH = "/music-assistant";
const AUTO_RELOAD_STORAGE_KEY = "carthing-ma-last-auto-reload";

function isSideBySideInstall(): boolean {
  return window.location.pathname === SIDE_BY_SIDE_PATH || window.location.pathname.startsWith(`${SIDE_BY_SIDE_PATH}/`);
}

function isLocalRelayUrl(serverUrl: string): boolean {
  return serverUrl.includes("127.0.0.1:4173") || serverUrl.includes("localhost:4173");
}

function urlLabel(transport: ConnectionConfig["transport"]): string {
  if (transport === "homeassistant") return "Home Assistant / Nabu Casa URL";
  if (transport === "bridgething") return "Music Assistant HTTPS URL";
  return "Music Assistant URL";
}

function urlPlaceholder(transport: ConnectionConfig["transport"]): string {
  if (transport === "homeassistant") return "https://home-assistant.example.com";
  if (transport === "bridgething") return "https://music.example.com";
  return "http://music-assistant.local:8095";
}

function returnToNocturne(): void {
  window.location.assign("/?carthingMaBypass=1");
}

const libraryCommands: Record<Exclude<LibraryKind, "recent">, string> = {
  playlists: "music/playlists/library_items",
  albums: "music/albums/library_items",
  artists: "music/artists/library_items",
  radio: "music/radios/library_items",
};

function itemSubtitle(item: MediaItem): string {
  if (item.artists?.length) return item.artists.map((artist) => artist.name).join(", ");
  return item.owner || item.media_type.replace(/_/g, " ");
}

function formatTime(seconds = 0): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function artworkCacheKey(item?: QueueItem): string | undefined {
  if (!item) return undefined;
  const media = item.media_item;
  return [
    item.queue_item_id,
    media?.uri,
    media?.name,
    media?.artists?.map((artist) => artist.name).join(","),
    media?.album?.name,
  ].filter(Boolean).join("|") || undefined;
}

function configDisplaySize(value: string | null | undefined): DisplaySize | undefined {
  return value === "standard" || value === "large" || value === "xlarge" ? value : undefined;
}

function configNowPlayingTextSize(value: string | null | undefined): NowPlayingTextSize | undefined {
  return value === "small" || value === "medium" || value === "large" || value === "xlarge" ? value : undefined;
}

function configBrightness(value: string | null | undefined): number {
  const level = Number(value);
  return Number.isFinite(level) ? Math.max(0.05, Math.min(1, level)) : 0.55;
}

export default function App() {
  const sideBySide = isSideBySideInstall();
  const client = useMemo(() => new MassClient(), []);
  const [config, setConfig] = useState<ConnectionConfig>(loadConfig);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("now");
  const [players, setPlayers] = useState<Player[]>([]);
  const [queues, setQueues] = useState<PlayerQueue[]>([]);
  const [activePlayerId, setActivePlayerId] = useState(loadPlayerId);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [selectedQueueIndex, setSelectedQueueIndex] = useState(0);
  const [queueSelectionTouched, setQueueSelectionTouched] = useState(false);
  const [libraryKind, setLibraryKind] = useState<LibraryKind>("recent");
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryHasMore, setLibraryHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [presetCandidate, setPresetCandidate] = useState<MediaItem>();
  const [notice, setNotice] = useState("");
  const [volumePreview, setVolumePreview] = useState<number>();
  const [displaySize, setDisplaySize] = useState<DisplaySize>(loadDisplaySize);
  const [nowPlayingTextSize, setNowPlayingTextSize] = useState<NowPlayingTextSize>(loadNowPlayingTextSize);
  const [brightness, setBrightness] = useState<BrightnessPreference>(() => loadBrightnessPreference() ?? { mode: "auto", level: 0.55 });
  const [brightnessAvailable, setBrightnessAvailable] = useState(false);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const volumeCommandTimer = useRef<number | undefined>(undefined);
  const volumeOverlayTimer = useRef<number | undefined>(undefined);
  const configReconnectTimer = useRef<number | undefined>(undefined);
  const volumePreviewRef = useRef<number | undefined>(undefined);
  const libraryRequestId = useRef(0);
  const reconnectFailures = useRef(0);
  const hadSuccessfulConnection = useRef(false);
  const connectInFlight = useRef<Promise<void> | undefined>(undefined);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const connectionStateChangedAt = useRef(Date.now());
  const configRef = useRef(config);

  const activePlayer = players.find((player) => player.player_id === activePlayerId) ?? players[0];
  const activeQueue =
    queues.find((queue) => queue.queue_id === activePlayer?.player_id) ??
    queues.find((queue) => queue.queue_id === activePlayer?.active_source);
  const currentItem = activeQueue?.current_item;
  const currentMedia = currentItem?.media_item;
  const positionRecentlyUpdated =
    activeQueue?.elapsed_time_last_updated !== undefined &&
    Date.now() - activeQueue.elapsed_time_last_updated * 1000 < PLAYING_POSITION_FRESH_MS;
  const isPlaying = activeQueue?.state === "playing" || activePlayer?.state === "playing" || (positionRecentlyUpdated && !!currentItem);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 1_800);
  }, []);

  useEffect(() => {
    connectionStateRef.current = connection;
    connectionStateChangedAt.current = Date.now();
  }, [connection]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    if (!isBridgeThingRuntime(sideBySide)) return;
    let cancelled = false;
    const syncBrightness = async () => {
      try {
        const saved = loadBrightnessPreference();
        if (saved) {
          await applyBridgeThingBrightness(saved);
          if (!cancelled) {
            setBrightness(saved);
            setBrightnessAvailable(true);
          }
          return;
        }
        const current = await readBridgeThingBrightness();
        if (!cancelled && current) {
          setBrightness(current);
          setBrightnessAvailable(true);
        }
      } catch {
        if (!cancelled) setBrightnessAvailable(false);
      }
    };
    void syncBrightness();
    return () => {
      cancelled = true;
    };
  }, [sideBySide]);

  const refreshCore = useCallback(async () => {
    const [nextPlayers, nextQueues] = await Promise.all([
      client.command<Player[]>("players/all"),
      client.command<PlayerQueue[]>("player_queues/all"),
    ]);
    const visiblePlayers = nextPlayers.filter((player) => player.available);
    setPlayers(visiblePlayers);
    setQueues(nextQueues);
    setActivePlayerId((current) => {
      const selected = visiblePlayers.some((player) => player.player_id === current)
        ? current
        : visiblePlayers[0]?.player_id || "";
      if (selected) savePlayerId(selected);
      return selected;
    });
  }, [client]);

  const connect = useCallback(
    async (nextConfig = config, credentials?: { username: string; password: string }) => {
      if (connectInFlight.current) return connectInFlight.current;
      const run = (async () => {
      if (!nextConfig.serverUrl) {
        setView("settings");
        return;
      }
      clearTimeout(reconnectTimer.current);
      setConnection("connecting");
      setError("");
      try {
        await client.connect(
          nextConfig.serverUrl,
          credentials?.username ? undefined : nextConfig.token,
          nextConfig.transport ?? "direct",
        );
        let resolvedConfig = nextConfig;
        if (credentials?.username) {
          const token = await client.login(credentials.username, credentials.password);
          resolvedConfig = { ...nextConfig, token };
          setConfig(resolvedConfig);
          saveConfig(resolvedConfig);
        }
        await refreshCore();
        setConnection("connected");
        hadSuccessfulConnection.current = true;
        reconnectFailures.current = 0;
        setConfig(resolvedConfig);
        saveConfig(resolvedConfig);
      } catch (reason) {
        reconnectFailures.current += 1;
        setConnection("error");
        setError(reason instanceof Error ? reason.message : String(reason));
        if (
          sideBySide &&
          hadSuccessfulConnection.current &&
          reconnectFailures.current >= 2 &&
          isLocalRelayUrl(nextConfig.serverUrl)
        ) {
          const lastReload = Number(window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY) || "0");
          if (Date.now() - lastReload > 45_000) {
            window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, String(Date.now()));
            window.location.reload();
          }
        }
      }
      })();
      connectInFlight.current = run;
      try {
        await run;
      } finally {
        if (connectInFlight.current === run) connectInFlight.current = undefined;
      }
    },
    [client, config, refreshCore, sideBySide],
  );

  const scheduleReconnect = useCallback(
    (delay = 2_000) => {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = window.setTimeout(() => {
        const nextConfig = configRef.current;
        if (nextConfig.serverUrl) void connect(nextConfig);
      }, delay);
    },
    [connect],
  );

  const ensureConnected = useCallback(async () => {
    if (connectionStateRef.current === "connected" && client.isConnected()) return true;
    const nextConfig = configRef.current;
    if (!nextConfig.serverUrl) {
      setView("settings");
      showNotice("Music Assistant is not configured");
      return false;
    }
    showNotice("Reconnecting to Music Assistant...");
    await connect(nextConfig);
    return client.isConnected();
  }, [client, connect, showNotice]);

  useEffect(() => {
    if (!isBridgeThingRuntime(sideBySide)) return;
    let removeConfigSubscription: (() => void) | undefined;
    let removeDocSubscription: (() => void) | undefined;
    let cancelled = false;
    const handleUiChange = (key: string, value: string | null | undefined) => {
      if (key === "displaySize") {
        const next = configDisplaySize(value);
        if (next) {
          setDisplaySize(next);
          saveDisplaySize(next);
        }
        return true;
      }
      if (key === "nowPlayingTextSize") {
        const next = configNowPlayingTextSize(value);
        if (next) {
          setNowPlayingTextSize(next);
          saveNowPlayingTextSize(next);
        }
        return true;
      }
      if (key === "brightnessMode") {
        setBrightness((current) => {
          const next: BrightnessPreference = {
            mode: value === "manual" ? "manual" : "auto",
            level: current.level,
          };
          saveBrightnessPreference(next);
          void applyBridgeThingBrightness(next)
            .then(() => setBrightnessAvailable(true))
            .catch(() => setBrightnessAvailable(false));
          return next;
        });
        return true;
      }
      if (key === "brightnessLevel") {
        setBrightness((current) => {
          const next: BrightnessPreference = {
            mode: "manual",
            level: configBrightness(value),
          };
          saveBrightnessPreference(next);
          void applyBridgeThingBrightness(next)
            .then(() => setBrightnessAvailable(true))
            .catch(() => setBrightnessAvailable(false));
          return next;
        });
        return true;
      }
      return false;
    };
    void subscribeBridgeThingDocs((change) => {
      handleUiChange(change.key, change.value);
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else removeDocSubscription = unsubscribe;
      })
      .catch(() => {
        // Doc change events are best-effort; startup doc loading still works without them.
      });
    void subscribeBridgeThingConfig((change) => {
      if (handleUiChange(change.key, change.value)) return;
      if (change.key !== "serverUrl" && change.key !== "token" && change.key !== "transport") return;
      setConfig((current) => {
        const next: ConnectionConfig = {
          ...current,
          ...(change.key === "serverUrl" ? { serverUrl: change.value?.trim() || "" } : {}),
          ...(change.key === "token" ? { token: change.value?.trim() || undefined } : {}),
          ...(change.key === "transport"
            ? {
                transport:
                  change.value === "homeassistant" || change.value === "direct"
                    ? change.value
                    : "bridgething",
              }
            : {}),
        };
        saveConfig(next);
        window.clearTimeout(configReconnectTimer.current);
        if (next.serverUrl) {
          configReconnectTimer.current = window.setTimeout(() => void connect(next), 750);
        }
        return next;
      });
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else removeConfigSubscription = unsubscribe;
      })
      .catch(() => {
        // Config change events are best-effort; startup config loading still works without them.
      });
    return () => {
      cancelled = true;
      removeConfigSubscription?.();
      removeDocSubscription?.();
      window.clearTimeout(configReconnectTimer.current);
    };
    // The subscription handler always passes an explicit config into connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBySide]);

  useEffect(() => {
    const removeEvent = client.onEvent((event: MassEvent) => {
      if (event.event === "player_updated" && event.data) {
        const update = event.data as Player;
        setPlayers((current) => current.map((player) => (player.player_id === update.player_id ? update : player)));
      }
      if (event.event === "queue_updated" && event.data) {
        const update = event.data as PlayerQueue;
        setQueues((current) => current.map((queue) => (queue.queue_id === update.queue_id ? update : queue)));
      }
      if (event.event === "queue_time_updated" && typeof event.data === "number" && event.object_id) {
        setQueues((current) =>
          current.map((queue) =>
            queue.queue_id === event.object_id
              ? { ...queue, elapsed_time: event.data as number, elapsed_time_last_updated: Date.now() / 1000 }
              : queue,
          ),
        );
      }
      if (event.event === "player_added" || event.event === "player_removed") void refreshCore();
    });
    const removeClose = client.onClose(() => {
      setConnection((current) => {
        if (current === "connected") scheduleReconnect();
        return current === "idle" ? current : "error";
      });
    });
    let cancelled = false;
    const bootstrap = async () => {
      let nextConfig = config;
      if (isBridgeThingRuntime(sideBySide)) {
        try {
          const bridgePreferences = await loadBridgeThingPreferences();
          if (bridgePreferences?.config) {
            nextConfig = bridgePreferences.config;
            if (!cancelled) {
              setConfig(nextConfig);
              saveConfig(nextConfig);
            }
          }
          if (!cancelled && bridgePreferences?.displaySize) {
            setDisplaySize(bridgePreferences.displaySize);
            saveDisplaySize(bridgePreferences.displaySize);
          }
          if (!cancelled && bridgePreferences?.nowPlayingTextSize) {
            setNowPlayingTextSize(bridgePreferences.nowPlayingTextSize);
            saveNowPlayingTextSize(bridgePreferences.nowPlayingTextSize);
          }
          if (!cancelled && bridgePreferences?.brightness) {
            setBrightness(bridgePreferences.brightness);
            saveBrightnessPreference(bridgePreferences.brightness);
            void applyBridgeThingBrightness(bridgePreferences.brightness)
              .then(() => setBrightnessAvailable(true))
              .catch(() => setBrightnessAvailable(false));
          }
        } catch {
          // BridgeThing config is optional so local development and Nocturne installs keep working.
        }
      }
      const configUrls = nextConfig.serverUrl
        ? []
        : sideBySide
        ? ["./device-config.json", "http://172.16.42.1:4173/api/device-config", "/api/device-config"]
        : ["/api/device-config"];
      for (const url of configUrls) {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) continue;
          nextConfig = (await response.json()) as ConnectionConfig;
          if (!cancelled) {
            setConfig(nextConfig);
            saveConfig(nextConfig);
          }
          break;
        } catch {
          // Try the next bridge location, then fall back to device-local configuration.
        }
      }
      if (cancelled) return;
      if (nextConfig.serverUrl) void connect(nextConfig);
      else setView("settings");
    };
    void bootstrap();
    return () => {
      cancelled = true;
      removeEvent();
      removeClose();
      clearTimeout(reconnectTimer.current);
      client.disconnect();
      clearTimeout(volumeCommandTimer.current);
      clearTimeout(volumeOverlayTimer.current);
    };
    // Initial connection is intentionally performed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (connection === "error") {
      const localRelay = isLocalRelayUrl(config.serverUrl);
      const retryDelay = localRelay ? 4_000 : 8_000;
      reconnectTimer.current = window.setTimeout(() => {
        const nextConfig = configRef.current;
        if (nextConfig.serverUrl) void connect(nextConfig);
      }, localRelay ? 2_000 : 5_000);
      const interval = window.setInterval(() => {
        if (connectionStateRef.current !== "error") return;
        const nextConfig = configRef.current;
        if (nextConfig.serverUrl) void connect(nextConfig);
      }, retryDelay);
      const reload = localRelay && sideBySide
        ? window.setTimeout(() => {
            const lastReload = Number(window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY) || "0");
            if (Date.now() - lastReload > 45_000) {
              window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, String(Date.now()));
              window.location.reload();
            }
          }, 18_000)
        : undefined;
      return () => {
        clearTimeout(reconnectTimer.current);
        window.clearInterval(interval);
        if (reload) window.clearTimeout(reload);
      };
    }
    return () => clearTimeout(reconnectTimer.current);
  }, [connection, connect, config, sideBySide]);

  useEffect(() => {
    if (connection !== "connected") return;
    const interval = window.setInterval(() => {
      if (!client.isConnected()) {
        setConnection("error");
        scheduleReconnect();
        return;
      }
      void refreshCore().catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setConnection("error");
        scheduleReconnect();
      });
    }, EXTERNAL_PLAYBACK_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [client, connection, refreshCore, scheduleReconnect]);

  useEffect(() => {
    const reconnectIfNeeded = () => {
      const nextConfig = configRef.current;
      if (!nextConfig.serverUrl) return;
      if (connectionStateRef.current === "connected" && client.isConnected()) {
        void refreshCore().catch(() => {
          setConnection("error");
          scheduleReconnect(750);
        });
        return;
      }
      scheduleReconnect(750);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") reconnectIfNeeded();
    };
    window.addEventListener("focus", reconnectIfNeeded);
    window.addEventListener("online", reconnectIfNeeded);
    window.addEventListener("pageshow", reconnectIfNeeded);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", reconnectIfNeeded);
      window.removeEventListener("online", reconnectIfNeeded);
      window.removeEventListener("pageshow", reconnectIfNeeded);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [client, refreshCore, scheduleReconnect]);

  useEffect(() => {
    if (!sideBySide || !isLocalRelayUrl(config.serverUrl)) return;
    const watchdog = window.setInterval(() => {
      if (connectionStateRef.current === "connected") return;
      if (Date.now() - connectionStateChangedAt.current < 22_000) return;
      window.location.reload();
    }, 5_000);
    return () => window.clearInterval(watchdog);
  }, [config.serverUrl, sideBySide]);

  const loadLibrary = useCallback(
    async (kind: LibraryKind, query = "", append = false) => {
      if (connection !== "connected" || !client.isConnected()) {
        const connected = await ensureConnected();
        if (!connected) return;
      }
      const requestId = ++libraryRequestId.current;
      const trimmedQuery = query.trim();
      setLibraryBusy(true);
      setLibraryKind(kind);
      if (!append) {
        setLibrary([]);
        setLibraryHasMore(false);
      }
      try {
        let result: unknown;
        const offset = append ? library.length : 0;
        if (trimmedQuery) {
          const search = await client.command<Record<string, MediaItem[]>>("music/search", {
            search_query: trimmedQuery,
            limit: 50,
          });
          result = Object.values(search).flat();
        } else if (kind === "recent") {
          result = await client.command<MediaItem[]>("music/recently_played_items", { limit: 16 });
        } else {
          result = await client.command<MediaItem[]>(libraryCommands[kind], {
            limit: LIBRARY_PAGE_SIZE,
            offset,
            favorite: null,
          });
        }
        if (libraryRequestId.current !== requestId) return;
        const page = Array.isArray(result) ? (result as MediaItem[]) : [];
        setLibrary((current) => (append ? [...current, ...page] : page));
        setLibraryHasMore(!trimmedQuery && kind !== "recent" && page.length === LIBRARY_PAGE_SIZE);
      } catch (reason) {
        if (libraryRequestId.current !== requestId) return;
        showNotice(reason instanceof Error ? reason.message : "Library request failed");
      } finally {
        if (libraryRequestId.current === requestId) setLibraryBusy(false);
      }
    },
    [client, connection, ensureConnected, library.length, showNotice],
  );

  useEffect(() => {
    if (view === "library" && library.length === 0) void loadLibrary(libraryKind);
  }, [view, library.length, libraryKind, loadLibrary]);

  const refreshQueueItems = useCallback(
    async (queueId = activeQueue?.queue_id) => {
      if (!queueId) return;
      try {
        const items = await client.command<QueueItem[]>("player_queues/items", {
          queue_id: queueId,
          limit: 100,
          offset: 0,
        });
        setQueueItems(items);
      } catch (reason) {
        showNotice(reason instanceof Error ? reason.message : "Queue request failed");
      }
    },
    [activeQueue?.queue_id, client, showNotice],
  );

  useEffect(() => {
    if (!activeQueue || view !== "queue") return;
    void refreshQueueItems(activeQueue.queue_id);
  }, [activeQueue?.queue_id, activeQueue?.current_index, refreshQueueItems, view]);

  useEffect(() => {
    if (view !== "queue") {
      setQueueSelectionTouched(false);
      return;
    }
    if (!queueItems.length) {
      setSelectedQueueIndex(0);
      return;
    }
    setSelectedQueueIndex((current) => {
      if (queueSelectionTouched && current >= 0 && current < queueItems.length) return current;
      const currentItemIndex = queueItems.findIndex(
        (item) => item.queue_item_id === activeQueue?.current_item?.queue_item_id,
      );
      const fallbackIndex = activeQueue?.current_index ?? 0;
      return Math.max(0, Math.min(queueItems.length - 1, currentItemIndex >= 0 ? currentItemIndex : fallbackIndex));
    });
  }, [activeQueue?.current_index, activeQueue?.current_item?.queue_item_id, queueItems, queueSelectionTouched, view]);

  const playerCommand = useCallback(
    async (command: string, args?: Record<string, unknown>) => {
      if (!activePlayer) return;
      try {
        if (!(await ensureConnected())) return;
        await client.command(`players/cmd/${command}`, { player_id: activePlayer.player_id, ...args });
        if (command !== "volume_set") {
          window.setTimeout(() => void refreshCore(), 350);
          window.setTimeout(() => void refreshCore(), 1_200);
        }
      } catch (reason) {
        showNotice(reason instanceof Error ? reason.message : "Command failed");
      }
    },
    [activePlayer, client, ensureConnected, refreshCore, showNotice],
  );

  const queueCommand = useCallback(
    async (command: string, args?: Record<string, unknown>) => {
      if (!activeQueue) return;
      try {
        if (!(await ensureConnected())) return;
        await client.command(`player_queues/${command}`, { queue_id: activeQueue.queue_id, ...args });
        window.setTimeout(() => void refreshCore(), 350);
      } catch (reason) {
        showNotice(reason instanceof Error ? reason.message : "Queue command failed");
      }
    },
    [activeQueue, client, ensureConnected, refreshCore, showNotice],
  );

  const setQueueMode = useCallback(
    (queueId: string, patch: Partial<PlayerQueue>) => {
      setQueues((current) => current.map((queue) => (queue.queue_id === queueId ? { ...queue, ...patch } : queue)));
    },
    [],
  );

  const toggleShuffle = useCallback(() => {
    if (!activeQueue) return;
    if (activeQueue.is_dynamic) return showNotice("Shuffle is managed by this queue");
    const shuffle_enabled = !activeQueue.shuffle_enabled;
    setQueueMode(activeQueue.queue_id, { shuffle_enabled });
    void queueCommand("shuffle", { shuffle_enabled });
  }, [activeQueue, queueCommand, setQueueMode, showNotice]);

  const toggleRepeat = useCallback(() => {
    if (!activeQueue) return;
    if (activeQueue.is_dynamic) return showNotice("Repeat is unavailable for this queue");
    const current = activeQueue.repeat_mode ?? "off";
    const repeat_mode: RepeatMode = current === "off" ? "all" : current === "all" ? "one" : "off";
    setQueueMode(activeQueue.queue_id, { repeat_mode });
    void queueCommand("repeat", { repeat_mode });
  }, [activeQueue, queueCommand, setQueueMode, showNotice]);

  const refreshQueueAfterCommand = useCallback(
    (queueId: string) => {
      window.setTimeout(() => {
        void refreshQueueItems(queueId);
        void refreshCore();
      }, 250);
    },
    [refreshCore, refreshQueueItems],
  );

  const selectQueueDelta = useCallback(
    (delta: number) => {
      if (!queueItems.length) return;
      setQueueSelectionTouched(true);
      setSelectedQueueIndex((current) => Math.max(0, Math.min(queueItems.length - 1, current + delta)));
    },
    [queueItems.length],
  );

  const playQueueItem = useCallback(
    (item: QueueItem) => {
      if (!activeQueue) return;
      void queueCommand("play_index", { index: item.queue_item_id });
      showNotice(`Playing ${item.name}`);
      setView("now");
      refreshQueueAfterCommand(activeQueue.queue_id);
    },
    [activeQueue, queueCommand, refreshQueueAfterCommand, showNotice],
  );

  const playSelectedQueueItem = useCallback(() => {
    const item = queueItems[selectedQueueIndex];
    if (item) playQueueItem(item);
  }, [playQueueItem, queueItems, selectedQueueIndex]);

  const moveQueueItemNext = useCallback(
    (item: QueueItem) => {
      if (!activeQueue) return;
      void queueCommand("move_item", { queue_item_id: item.queue_item_id, pos_shift: 0 });
      showNotice(`Playing ${item.name} next`);
      refreshQueueAfterCommand(activeQueue.queue_id);
    },
    [activeQueue, queueCommand, refreshQueueAfterCommand, showNotice],
  );

  const removeQueueItem = useCallback(
    (item: QueueItem) => {
      if (!activeQueue) return;
      setQueueItems((current) => current.filter((entry) => entry.queue_item_id !== item.queue_item_id));
      void queueCommand("delete_item", { item_id_or_index: item.queue_item_id });
      showNotice(`Removed ${item.name}`);
      refreshQueueAfterCommand(activeQueue.queue_id);
    },
    [activeQueue, queueCommand, refreshQueueAfterCommand, showNotice],
  );

  const playMedia = useCallback(
    async (media: MediaItem | Preset) => {
      if (!activePlayer) return showNotice("Select a player first");
      try {
        if (!(await ensureConnected())) return;
        await client.command("player_queues/play_media", {
          queue_id: activeQueue?.queue_id || activePlayer.player_id,
          media: media.uri,
          media_type: "media_type" in media ? media.media_type : media.mediaType,
          option: "replace",
        });
        setView("now");
        window.setTimeout(() => void refreshCore(), 350);
        window.setTimeout(() => void refreshCore(), 1_200);
      } catch (reason) {
        showNotice(reason instanceof Error ? reason.message : "Unable to play item");
      }
    },
    [activePlayer, activeQueue?.queue_id, client, ensureConnected, refreshCore, showNotice],
  );

  const changeVolume = useCallback(
    (change: number) => {
      if (!activePlayer) return;
      const baseline = volumePreviewRef.current ?? activePlayer.volume_level ?? 0;
      const next = Math.max(0, Math.min(100, baseline + change));
      volumePreviewRef.current = next;
      setVolumePreview(next);
      setPlayers((current) =>
        current.map((player) => (player.player_id === activePlayer.player_id ? { ...player, volume_level: next } : player)),
      );
      clearTimeout(volumeCommandTimer.current);
      volumeCommandTimer.current = window.setTimeout(() => {
        void playerCommand("volume_set", { volume_level: next });
      }, VOLUME_COMMAND_DELAY_MS);
      clearTimeout(volumeOverlayTimer.current);
      volumeOverlayTimer.current = window.setTimeout(() => {
        volumePreviewRef.current = undefined;
        setVolumePreview(undefined);
      }, VOLUME_OVERLAY_HIDE_MS);
    },
    [activePlayer, playerCommand],
  );

  const savePreset = useCallback(
    (slot: number) => {
      const media = presetCandidate ?? currentMedia;
      if (!media?.uri) return showNotice("Choose a library item first");
      const preset: Preset = {
        slot,
        uri: media.uri,
        name: media.name,
        mediaType: media.media_type,
        image: itemImage(media),
      };
      setPresets((current) => {
        const next = [...current.filter((entry) => entry.slot !== slot), preset].sort((a, b) => a.slot - b.slot);
        savePresets(next);
        return next;
      });
      showNotice(`Saved ${media.name} to preset ${slot}`);
    },
    [currentMedia, presetCandidate, showNotice],
  );

  const pressPreset = useCallback(
    (slot: number) => {
      const preset = presets.find((entry) => entry.slot === slot);
      if (preset) void playMedia(preset);
      else showNotice(`Preset ${slot} is empty`);
    },
    [playMedia, presets, showNotice],
  );

  useHardware({
    dialLeft: () => (view === "queue" ? selectQueueDelta(-1) : changeVolume(-2)),
    dialRight: () => (view === "queue" ? selectQueueDelta(1) : changeVolume(2)),
    dialPress: () => (view === "queue" ? playSelectedQueueItem() : void playerCommand("play_pause")),
    presetPress: pressPreset,
    presetLongPress: savePreset,
    back: () => {
      if (sideBySide && view === "now") returnToNocturne();
      else setView("now");
    },
    settings: () => setView("settings"),
  });

  const openQueueView = () => {
    setQueueSelectionTouched(false);
    setView("queue");
  };

  const selectPlayer = (player: Player) => {
    setActivePlayerId(player.player_id);
    savePlayerId(player.player_id);
    setView("now");
    showNotice(`${player.display_name || player.name} selected`);
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void loadLibrary(libraryKind, searchQuery);
  };

  const updateBrightness = (next: BrightnessPreference) => {
    const normalized = { ...next, level: Math.max(0.05, Math.min(1, next.level)) };
    setBrightness(normalized);
    saveBrightnessPreference(normalized);
    setBrightnessAvailable(true);
    void applyBridgeThingBrightness(normalized).catch(() => {
      setBrightnessAvailable(false);
      showNotice("Brightness control is unavailable");
    });
  };

  return (
    <main className="device-shell" data-display-size={displaySize} data-now-playing-text-size={nowPlayingTextSize}>
      <div className="ambient" style={{ backgroundImage: currentItem ? `url(${imageUrl(config.serverUrl, itemImage(currentItem), 256, artworkCacheKey(currentItem))})` : undefined }} />

      <section className="content">
        {view === "now" && (
          <NowPlaying
            item={currentItem}
            serverUrl={config.serverUrl}
            playing={isPlaying}
            queue={activeQueue}
            onPrevious={() => void playerCommand("previous")}
            onPlayPause={() => void playerCommand("play_pause")}
            onNext={() => void playerCommand("next")}
            shuffleEnabled={activeQueue?.shuffle_enabled === true}
            repeatMode={activeQueue?.repeat_mode ?? "off"}
            onShuffle={toggleShuffle}
            onRepeat={toggleRepeat}
          />
        )}
        {view === "library" && (
          <LibraryView
            kind={libraryKind}
            items={library}
            busy={libraryBusy}
            query={searchQuery}
            serverUrl={config.serverUrl}
            onKind={(kind) => void loadLibrary(kind)}
            onQuery={setSearchQuery}
            onSearch={submitSearch}
            onSelect={(item) => setPresetCandidate(item)}
            onPlay={(item) => void playMedia(item)}
            selected={presetCandidate?.uri}
            hasMore={libraryHasMore}
            onLoadMore={() => void loadLibrary(libraryKind, searchQuery, true)}
          />
        )}
        {view === "players" && <PlayersView players={players} selected={activePlayer?.player_id} onSelect={selectPlayer} />}
        {view === "queue" && (
          <QueueView
            items={queueItems}
            current={activeQueue?.current_item?.queue_item_id}
            currentIndex={activeQueue?.current_index ?? 0}
            lockedIndex={activeQueue?.index_in_buffer ?? activeQueue?.current_index ?? -1}
            selectedIndex={selectedQueueIndex}
            serverUrl={config.serverUrl}
            onSelect={(index) => {
              setQueueSelectionTouched(true);
              setSelectedQueueIndex(index);
            }}
            onPlay={playQueueItem}
            onPlayNext={moveQueueItemNext}
            onRemove={removeQueueItem}
          />
        )}
        {view === "settings" && (
          <SettingsView
            config={config}
            state={connection}
            error={error}
            presets={presets}
            displaySize={displaySize}
            nowPlayingTextSize={nowPlayingTextSize}
            brightness={brightness}
            brightnessAvailable={brightnessAvailable}
            onDisplaySize={(size) => {
              setDisplaySize(size);
              saveDisplaySize(size);
            }}
            onNowPlayingTextSize={(size) => {
              setNowPlayingTextSize(size);
              saveNowPlayingTextSize(size);
            }}
            onBrightness={updateBrightness}
            onConnect={(next, credentials) => void connect(next, credentials)}
            onClearPreset={(slot) => {
              const next = presets.filter((preset) => preset.slot !== slot);
              setPresets(next);
              savePresets(next);
            }}
          />
        )}
      </section>

      <nav className={sideBySide ? "navrail with-nocturne" : "navrail"}>
        <NavButton active={view === "now"} label="Now" icon={<Home />} onClick={() => setView("now")} />
        <NavButton active={view === "library"} label="Library" icon={<Disc3 />} onClick={() => setView("library")} />
        <NavButton active={view === "players"} label="Players" icon={<Speaker />} onClick={() => setView("players")} />
        <NavButton active={view === "queue"} label="Queue" icon={<ListMusic />} onClick={openQueueView} />
        <NavButton active={view === "settings"} label="Setup" icon={<Settings />} onClick={() => setView("settings")} />
        {sideBySide && <NavButton active={false} label="Nocturne" icon={<ArrowLeft />} onClick={returnToNocturne} />}
      </nav>

      {notice && <div className="notice">{notice}</div>}
      {volumePreview !== undefined && <VolumeOverlay volume={volumePreview} />}
    </main>
  );
}

function VolumeOverlay({ volume }: { volume: number }) {
  const safeVolume = Math.max(0, Math.min(100, volume));
  return (
    <div className="volume-overlay" role="status" aria-label={`Volume ${safeVolume}`}>
      <Volume2 size={28} />
      <div className="volume-slider" aria-hidden="true">
        <div className="volume-slider-fill" style={{ height: `${safeVolume}%` }} />
      </div>
      <strong>{safeVolume}</strong>
    </div>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <div className={`connection ${state}`} title={state}>
      {state === "connecting" ? <LoaderCircle className="spin" size={15} /> : state === "connected" ? <Usb size={15} /> : <Bluetooth size={15} />}
      <span>{state === "connected" ? "ON" : state}</span>
    </div>
  );
}

function NavButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function NowPlaying({ item, serverUrl, playing, queue, shuffleEnabled, repeatMode, onPrevious, onPlayPause, onNext, onShuffle, onRepeat }: {
  item?: QueueItem; serverUrl: string; playing: boolean; queue?: PlayerQueue; shuffleEnabled: boolean; repeatMode: RepeatMode;
  onPrevious: () => void; onPlayPause: () => void; onNext: () => void; onShuffle: () => void; onRepeat: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [playing]);

  // The Car Thing runs Chromium 69. Keep this at the same image-proxy size as
  // the library thumbnails, which is known to decode reliably on the device.
  const image = imageUrl(serverUrl, itemImage(item), 256, artworkCacheKey(item));
  const media = item?.media_item;
  const title = media?.name || item?.name || "Nothing playing";
  const artist = media ? itemSubtitle(media) : "Select something from your library";
  const album = media?.album?.name;
  const elapsedBase = queue?.elapsed_time ?? 0;
  const elapsedAt = queue?.elapsed_time_last_updated;
  const liveElapsed = playing && elapsedAt ? elapsedBase + Math.max(0, now / 1000 - elapsedAt) : elapsedBase;
  const elapsed = item?.duration ? Math.min(item.duration, liveElapsed) : liveElapsed;
  const progress = item?.duration ? Math.max(0, Math.min(100, (elapsed / item.duration) * 100)) : 0;
  return (
    <div className="now-playing">
      <div className="artwork">{image ? <img src={image} alt="" /> : <Music2 size={64} />}</div>
      <div className="track-panel">
        <div className="track-copy">
          <ScrollingTitle title={title} />
          <p className="track-artist">{artist}</p>
          {album && <p className="track-album">{album}</p>}
        </div>
        <div className="progress"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
        <div className="times"><span>{formatTime(elapsed)}</span><span>{formatTime(item?.duration)}</span></div>
        <div className="transport">
          <button className={shuffleEnabled ? "mode active" : "mode"} onClick={onShuffle} aria-label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}><Shuffle /></button>
          <button onClick={onPrevious} aria-label="Previous"><SkipBack /></button>
          <button className="play" onClick={onPlayPause} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
          <button onClick={onNext} aria-label="Next"><SkipForward /></button>
          <button className={repeatMode !== "off" ? "mode active" : "mode"} onClick={onRepeat} aria-label={`Repeat ${repeatMode}`}>{repeatMode === "one" ? <Repeat1 /> : <Repeat />}</button>
        </div>
      </div>
    </div>
  );
}

function ScrollingTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const titleElement = titleRef.current;
      const viewport = titleElement?.parentElement;
      if (!titleElement || !viewport) return;
      setScrollDistance(Math.max(0, titleElement.scrollWidth - viewport.clientWidth));
    };
    const frame = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    if (titleRef.current) {
      observer.observe(titleRef.current);
      if (titleRef.current.parentElement) observer.observe(titleRef.current.parentElement);
    }
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [title]);

  const duration = Math.max(7, scrollDistance / 24 + 4);
  return (
    <div className={scrollDistance ? "track-title-window scrolling" : "track-title-window"}>
      <h1
        ref={titleRef}
        style={{
          "--title-scroll-distance": `-${scrollDistance}px`,
          animationDuration: `${duration}s`,
        } as React.CSSProperties}
      >
        {title}
      </h1>
    </div>
  );
}

function LibraryView({ kind, items, busy, query, serverUrl, selected, hasMore, onKind, onQuery, onSearch, onSelect, onPlay, onLoadMore }: {
  kind: LibraryKind; items: MediaItem[]; busy: boolean; query: string; serverUrl: string; selected?: string; hasMore: boolean;
  onKind: (kind: LibraryKind) => void; onQuery: (query: string) => void; onSearch: (event: FormEvent) => void;
  onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onLoadMore: () => void;
}) {
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div><h2>Your library</h2><p>Long-press 1–4 to save the selected item</p></div>
        <form className="search-box" onSubmit={onSearch}><Search size={17} /><input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search" /></form>
      </div>
      <div className="filter-row">
        {(["recent", "playlists", "albums", "artists", "radio"] as LibraryKind[]).map((value) => (
          <button className={kind === value ? "active" : ""} key={value} onClick={() => onKind(value)}>{value}</button>
        ))}
      </div>
      {busy ? <div className="center-state"><LoaderCircle className="spin" /> Loading library…</div> : (
        <div className="media-grid">
          {items.map((item) => {
            const image = imageUrl(serverUrl, itemImage(item), 256);
            return (
              <article className={selected === item.uri ? "media-card selected" : "media-card"} key={item.uri} onClick={() => onSelect(item)} onDoubleClick={() => onPlay(item)}>
                <div className="media-image">{image ? <img src={image} alt="" /> : <Album />}</div>
                <div className="media-copy"><strong>{item.name}</strong><span>{itemSubtitle(item)}</span></div>
                <button onClick={(event) => { event.stopPropagation(); onPlay(item); }} aria-label={`Play ${item.name}`}><Play fill="currentColor" /></button>
              </article>
            );
          })}
          {!items.length && <div className="center-state">No library items found</div>}
          {hasMore && <button className="load-more" onClick={onLoadMore} disabled={busy}>{busy ? "Loading…" : `Load more (${items.length} shown)`}</button>}
        </div>
      )}
    </div>
  );
}

function PlayersView({ players, selected, onSelect }: { players: Player[]; selected?: string; onSelect: (player: Player) => void }) {
  return (
    <div className="page"><div className="page-heading"><div><h2>Choose a player</h2><p>All available Music Assistant outputs</p></div></div>
      <div className="player-grid">{players.map((player) => (
        <button key={player.player_id} className={selected === player.player_id ? "player-card selected" : "player-card"} onClick={() => onSelect(player)}>
          <span className="speaker-icon"><Speaker /></span><span><strong>{player.display_name || player.name}</strong><small>{player.state || (player.powered ? "idle" : "off")}</small></span><span className="player-volume"><Volume2 size={16} /> {player.volume_level}</span>
        </button>
      ))}</div>
    </div>
  );
}

function QueueView({ items, current, currentIndex, lockedIndex, selectedIndex, serverUrl, onSelect, onPlay, onPlayNext, onRemove }: {
  items: QueueItem[];
  current?: string;
  currentIndex: number;
  lockedIndex: number;
  selectedIndex: number;
  serverUrl: string;
  onSelect: (index: number) => void;
  onPlay: (item: QueueItem) => void;
  onPlayNext: (item: QueueItem) => void;
  onRemove: (item: QueueItem) => void;
}) {
  const selectedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="page"><div className="page-heading"><div><h2>Up next</h2><p>Turn dial to choose, press to play • {items.length} items</p></div><span className="queue-position">{items.length ? currentIndex + 1 : 0}/{items.length}</span></div>
      <div className="queue-list">{items.map((item, index) => {
        const image = imageUrl(serverUrl, itemImage(item), 128);
        const isCurrent = current === item.queue_item_id;
        const isSelected = selectedIndex === index;
        const locked = index <= lockedIndex;
        const className = ["queue-row", isCurrent ? "current" : "", isSelected ? "selected" : ""].filter(Boolean).join(" ");
        return (
          <article
            className={className}
            key={item.queue_item_id}
            onClick={() => onSelect(index)}
            onDoubleClick={() => onPlay(item)}
            ref={isSelected ? selectedRef : undefined}
          >
            <span className="queue-index">{isCurrent ? <Volume2 size={16} /> : index + 1}</span>
            <span className="queue-art">{image ? <img src={image} alt="" /> : <Music2 />}</span>
            <span className="queue-copy"><strong>{item.name}</strong><small>{item.media_item ? itemSubtitle(item.media_item) : ""}</small></span>
            <time>{formatTime(item.duration)}</time>
            <span className="queue-actions">
              <button onClick={(event) => { event.stopPropagation(); onPlay(item); }} disabled={isCurrent} aria-label={`Play ${item.name}`}><Play fill="currentColor" /></button>
              <button onClick={(event) => { event.stopPropagation(); onPlayNext(item); }} disabled={locked} aria-label={`Play ${item.name} next`}><SkipForward /></button>
              <button className="danger" onClick={(event) => { event.stopPropagation(); onRemove(item); }} disabled={locked} aria-label={`Remove ${item.name}`}><Trash2 /></button>
            </span>
          </article>
        );
      })}</div>
      {!items.length && <div className="center-state">Queue is empty</div>}
    </div>
  );
}

function SettingsView({ config, state, error, presets, displaySize, nowPlayingTextSize, brightness, brightnessAvailable, onConnect, onClearPreset, onDisplaySize, onNowPlayingTextSize, onBrightness }: {
  config: ConnectionConfig; state: ConnectionState; error: string; presets: Preset[]; displaySize: DisplaySize; nowPlayingTextSize: NowPlayingTextSize; brightness: BrightnessPreference; brightnessAvailable: boolean;
  onConnect: (config: ConnectionConfig, credentials?: { username: string; password: string }) => void;
  onClearPreset: (slot: number) => void;
  onDisplaySize: (size: DisplaySize) => void;
  onNowPlayingTextSize: (size: NowPlayingTextSize) => void;
  onBrightness: (preference: BrightnessPreference) => void;
}) {
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [transport, setTransport] = useState<ConnectionConfig["transport"]>(config.transport ?? "direct");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  const showLoginFields = transport !== "homeassistant";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateConnectionUrl(serverUrl, transport);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError("");
    onConnect(
      { serverUrl: serverUrl.trim(), token: serverUrl.trim() === config.serverUrl ? config.token : undefined, transport },
      showLoginFields && username ? { username, password } : undefined,
    );
  };
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div><h2>Connection and presets</h2><p>Music Assistant or Home Assistant setup</p></div>
        <ConnectionBadge state={state} />
      </div>
      <div className="settings-columns">
        <form className="connection-form" onSubmit={submit}>
          <label>{urlLabel(transport)}<input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={urlPlaceholder(transport)} /></label>
          <label>Connection path<select value={transport ?? "direct"} onChange={(e) => setTransport(e.target.value as ConnectionConfig["transport"])}>
            <option value="homeassistant">Home Assistant / Nabu Casa</option>
            <option value="direct">Direct browser connection</option>
            <option value="bridgething">BridgeThing companion network</option>
          </select></label>
          {showLoginFields ? (
            <div className="credential-row"><label>Username <small>(if enabled)</small><input value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label></div>
          ) : (
            <div className="token-note">Home Assistant uses the access token saved in BridgeThing settings.</div>
          )}
          <button className="primary" type="submit" disabled={state === "connecting"}>{state === "connecting" ? <LoaderCircle className="spin" /> : <RefreshCw />} Connect</button>
          {(formError || error) && <div className="error-box"><CircleAlert /> <span>{formError || error}</span></div>}
        </form>
        <div className="preset-list">
          <div className="display-setting"><strong>Display size</strong><div>{(["standard", "large", "xlarge"] as DisplaySize[]).map((size) => <button type="button" className={displaySize === size ? "active" : ""} onClick={() => onDisplaySize(size)} key={size}>{size === "xlarge" ? "Extra large" : size}</button>)}</div></div>
          <div className="display-setting text-size-setting"><strong>Now Playing text</strong><div>{(["small", "medium", "large", "xlarge"] as NowPlayingTextSize[]).map((size) => <button type="button" className={nowPlayingTextSize === size ? "active" : ""} onClick={() => onNowPlayingTextSize(size)} key={size}>{size === "xlarge" ? "XL" : size}</button>)}</div></div>
          <div className="display-setting brightness-setting">
            <strong><Sun size={15} /> Brightness <span>{brightnessAvailable ? `${Math.round(brightness.level * 100)}%` : "Unavailable"}</span></strong>
            <div className="brightness-mode">
              <button type="button" className={brightness.mode === "auto" ? "active" : ""} onClick={() => onBrightness({ ...brightness, mode: "auto" })}>Auto</button>
              <button type="button" className={brightness.mode === "manual" ? "active" : ""} onClick={() => onBrightness({ ...brightness, mode: "manual" })}>Manual</button>
            </div>
            <label className="brightness-slider">
              <input
                type="range"
                min="5"
                max="100"
                value={Math.round(brightness.level * 100)}
                onChange={(event) => onBrightness({ mode: "manual", level: Number(event.target.value) / 100 })}
              />
            </label>
          </div>
          {[1, 2, 3, 4].map((slot) => {
            const preset = presets.find((entry) => entry.slot === slot);
            return <div className="preset-row" key={slot}><b>{slot}</b><span><strong>{preset?.name || "Not assigned"}</strong><small>{preset ? preset.mediaType : "Long-press while a library item is selected"}</small></span>{preset && <button onClick={() => onClearPreset(slot)}>Clear</button>}</div>;
          })}
        </div>
      </div>
    </div>
  );
}

function validateConnectionUrl(serverUrl: string, transport: ConnectionConfig["transport"]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    return "Enter a Music Assistant URL, not a Remote ID";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Music Assistant URL must start with http:// or https://";
  }
  if ((transport === "bridgething" || transport === "homeassistant") && parsed.protocol !== "https:") {
    return "BridgeThing Android requires an https:// URL";
  }
  return undefined;
}
