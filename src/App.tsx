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
  Maximize2,
  Minimize2,
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
import { usePlayerVolume } from "./hooks/usePlayerVolume";
import { PlayersView } from "./components/PlayersView";
import {
  applyBridgeThingBrightness,
  connectBridgeThingPhoneVolume,
  setBridgeThingPhoneVolumePlayer,
  isBridgeThingRuntime,
  loadBridgeThingPreferences,
  readBridgeThingBrightness,
  subscribeBridgeThingBluetooth,
  subscribeBridgeThingConfig,
  subscribeBridgeThingDocs,
  subscribeBridgeThingVoice,
} from "./lib/bridgething";
import { imageUrl, itemImage } from "./lib/images";
import { MassClient } from "./lib/MassClient";
import { connectionTarget, connectionTimings, normalizeRemoteId, validateConnection } from "./lib/connection";
import { REMOTE_ARTWORK_BASE, useArtworkUrl } from "./lib/remoteArtwork";
import { fetchLibraryPage, LibraryCache, libraryKey, type LibraryKind } from "./lib/library";
import { currentPlayer, nextPlayerId } from "./lib/phonePlayer";
import type { VolumeControl } from "./lib/playerVolume";
import {
  loadBrightnessPreference,
  loadConfig,
  loadDisplaySize,
  loadNowPlayingTextSize,
  loadPlayerId,
  loadPhoneVolumePlayerId,
  loadPresets,
  saveBrightnessPreference,
  saveConfig,
  saveDisplaySize,
  saveNowPlayingTextSize,
  savePlayerId,
  savePhoneVolumePlayerId,
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
import type { VoiceActivity, VoiceIntent } from "@bridgething/client";

type View = "now" | "library" | "players" | "queue" | "settings";
type MediaLibraryKind = Exclude<LibraryKind, "recent" | "ai_radio">;
type RepeatMode = "off" | "all" | "one";
type PlayMediaOptions = {
  shuffle?: boolean;
  radioMode?: boolean;
  replaceAiRadio?: boolean;
};
const VOLUME_OVERLAY_HIDE_MS = 3_000;
const PLAYING_POSITION_FRESH_MS = 15_000;
const BRIDGETHING_RELOAD_AFTER_STALE_MS = 75_000;
const SIDE_BY_SIDE_PATH = "/music-assistant";
const AUTO_RELOAD_STORAGE_KEY = "carthing-ma-last-auto-reload";
const VOICE_COMMAND_FRESH_MS = 12_000;
const VOICE_DEBUG_STORAGE_KEY = "carthing-ma-last-voice-debug";
const VOICE_ARTIST_TRACK_LIMIT = 25;

function isSideBySideInstall(): boolean {
  return window.location.pathname === SIDE_BY_SIDE_PATH || window.location.pathname.startsWith(`${SIDE_BY_SIDE_PATH}/`);
}

function isLocalRelayUrl(serverUrl: string): boolean {
  return serverUrl.includes("127.0.0.1:4173") || serverUrl.includes("localhost:4173");
}

function saveVoiceDebug(payload: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(
      VOICE_DEBUG_STORAGE_KEY,
      JSON.stringify({
        at: new Date().toISOString(),
        ...payload,
      }),
    );
  } catch {
    // Debug storage is best effort only.
  }
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

const libraryCommands: Record<MediaLibraryKind, string> = {
  playlists: "music/playlists/library_items",
  albums: "music/albums/library_items",
  artists: "music/artists/library_items",
  radio: "music/radios/library_items",
};

const voiceLibraryOrder: MediaLibraryKind[] = ["radio", "artists", "playlists", "albums"];

function itemSubtitle(item: MediaItem): string {
  if (item.media_type === "ai_radio") return "AI Radio show";
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

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function scoreMatch(query: string, candidate: string): number {
  const normalizedQuery = normalizeMatchText(query);
  const normalizedCandidate = normalizeMatchText(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedCandidate === normalizedQuery) return 100;
  if (normalizedCandidate.includes(normalizedQuery)) return 85;
  if (normalizedQuery.includes(normalizedCandidate)) return 70;
  const queryWords = new Set(normalizedQuery.split(" "));
  const candidateWords = new Set(normalizedCandidate.split(" "));
  let overlap = 0;
  queryWords.forEach((word) => {
    if (candidateWords.has(word)) overlap += 1;
  });
  return Math.round((overlap / Math.max(1, queryWords.size)) * 60);
}

function findBestPlayer(players: Player[], query: string): Player | undefined {
  const ranked = players
    .map((player) => ({
      player,
      score: Math.max(scoreMatch(query, player.display_name || ""), scoreMatch(query, player.name)),
    }))
    .filter((entry) => entry.score >= 45)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.player;
}

function rankBestMedia(items: MediaItem[], query: string): { item: MediaItem; score: number } | undefined {
  const ranked = items
    .map((item) => ({
      item,
      score: scoreMatch(query, item.name) + (item.media_type === "radio" ? 8 : 0),
    }))
    .filter((entry) => entry.score >= 45)
    .sort((a, b) => b.score - a.score);
  return ranked[0];
}

function findBestMedia(items: MediaItem[], query: string): MediaItem | undefined {
  return rankBestMedia(items, query)?.item;
}

function artistMatches(item: MediaItem, artistName: string): boolean {
  const query = normalizeMatchText(artistName);
  if (!query) return false;
  return (item.artists ?? []).some((artist) => {
    const name = normalizeMatchText(artist.name);
    return name === query || name.includes(query) || query.includes(name);
  });
}

function voiceLibraryKinds(targetType?: string): MediaLibraryKind[] {
  if (targetType === "station") return ["radio"];
  if (targetType === "artist") return ["artists"];
  if (targetType === "playlist") return ["playlists"];
  if (targetType === "album") return ["albums"];
  return voiceLibraryOrder;
}

function splitPlayerTarget(value: string): { mediaQuery: string; playerQuery?: string } {
  const parts = value.split(/\s+on\s+/i);
  if (parts.length < 2) return { mediaQuery: value.trim() };
  return {
    mediaQuery: parts[0].trim(),
    playerQuery: parts.slice(1).join(" on ").replace(/\s+and\s+.+$/i, "").trim(),
  };
}

function voiceMediaAlias(value: string): string {
  const normalized = normalizeMatchText(value);
  if (["rock bar", "rock band", "rock bark", "rock bard"].includes(normalized)) return "RockBar";
  if (["joe bonemasa", "joe bonamasa", "joe bonamassa"].includes(normalized)) return "Joe Bonamassa";
  if (["eric johansson", "eric johanson"].includes(normalized)) return "Eric Johanson";
  return value;
}

function voiceTargetType(value: string | null | undefined): string | undefined {
  const normalized = normalizeMatchText(value || "");
  if (normalized === "playlist" || normalized === "playlists") return "playlist";
  if (normalized === "album" || normalized === "albums") return "album";
  if (normalized === "artist" || normalized === "artists") return "artist";
  if (normalized === "radio" || normalized === "station" || normalized === "stations") return "station";
  return undefined;
}

function parseVoicePlayCommand(input: VoiceIntent | VoiceActivity): { mediaQuery: string; playerQuery?: string; targetType?: string } | undefined {
  const slots = input.slots ?? {};
  const transcript = input.transcript?.trim() || "";
  const slotTarget = slots.target || slots.playlist || "";
  const transcriptMatch =
    transcript.match(/\b(?:play|clay|plan)\s+(.+)$/i) ??
    transcript.match(/^\s*((?:playlist|album|artist|radio|station)\b.+)$/i);
  const fromTranscript = transcriptMatch?.[1]?.trim() || "";
  const splitTarget = splitPlayerTarget(fromTranscript);
  const playerTarget = fromTranscript ? splitTarget.playerQuery : undefined;
  const rawMediaQuery = slotTarget || splitTarget.mediaQuery;
  const leadingType = rawMediaQuery.match(/^(?:the\s+)?(radio|station|playlist|album|artist)s?\s*[:,]?\s+(.+)$/i);
  const trailingType = rawMediaQuery.match(/^(.+?)\s+(radio|station|playlist|album|artist)s?$/i);
  const targetType = voiceTargetType(slots.targetType) ?? voiceTargetType(leadingType?.[1]) ?? voiceTargetType(trailingType?.[2]);
  const mediaQuery = leadingType?.[2] ?? trailingType?.[1] ?? rawMediaQuery;
  const cleanedMediaQuery = mediaQuery
    .replace(/^(the\s+)?(radio|station|playlist|album|artist)s?\s*[:,]?\s+/i, "")
    .replace(/\s+(radio|station|playlist|album|artist)s?$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleanedMediaQuery) return undefined;
  return { mediaQuery: voiceMediaAlias(cleanedMediaQuery), playerQuery: playerTarget, targetType };
}

function voiceViewTarget(view: string | null | undefined): { view: View; libraryKind?: LibraryKind } | undefined {
  if (view === "nowPlaying") return { view: "now" };
  if (view === "queue") return { view: "queue" };
  if (view === "library") return { view: "library" };
  if (view === "playlists") return { view: "library", libraryKind: "playlists" };
  if (view === "artist") return { view: "library", libraryKind: "artists" };
  if (view === "album") return { view: "library", libraryKind: "albums" };
  if (view === "presets") return { view: "settings" };
  return undefined;
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
  const { refreshMs, staleMs } = connectionTimings(config.transport);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("now");
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const fullPlayer = playerFullscreen && view === "now";
  useEffect(() => { if (view !== "now") setPlayerFullscreen(false); }, [view]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [queues, setQueues] = useState<PlayerQueue[]>([]);
  const [activePlayerId, setActivePlayerId] = useState(loadPlayerId);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [selectedQueueIndex, setSelectedQueueIndex] = useState(0);
  const [queueSelectionTouched, setQueueSelectionTouched] = useState(false);
  const [libraryKind, setLibraryKind] = useState<LibraryKind>("recent");
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [aiRadioSwitch, setAiRadioSwitch] = useState<{ media: MediaItem | Preset; player: Player }>();
  const aiRadioStarting = useRef(false);
  const [libraryHasMore, setLibraryHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [presetCandidate, setPresetCandidate] = useState<MediaItem>();
  const [notice, setNotice] = useState("");
  const [volumePreview, setVolumePreview] = useState<number>();
  const [volumeControl, setVolumeControl] = useState<VolumeControl>();
  const [phoneVolumePlayerId, setPhoneVolumePlayerId] = useState(loadPhoneVolumePlayerId);
  const [phoneVolumePercent, setPhoneVolumePercent] = useState<number>();
  const phoneVolumeControl = useRef<Awaited<ReturnType<typeof connectBridgeThingPhoneVolume>> | undefined>(undefined);
  const phoneVolumeRoute = useRef(false);
  const [displaySize, setDisplaySize] = useState<DisplaySize>(loadDisplaySize);
  const [nowPlayingTextSize, setNowPlayingTextSize] = useState<NowPlayingTextSize>(loadNowPlayingTextSize);
  const [brightness, setBrightness] = useState<BrightnessPreference>(() => loadBrightnessPreference() ?? { mode: "auto", level: 0.55 });
  const [brightnessAvailable, setBrightnessAvailable] = useState(false);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const volumeOverlayTimer = useRef<number | undefined>(undefined);
  const configReconnectTimer = useRef<number | undefined>(undefined);
  const volumePreviewRef = useRef<number | undefined>(undefined);
  const libraryRequestId = useRef(0);
  const libraryCache = useRef(new LibraryCache());
  const reconnectFailures = useRef(0);
  const hadSuccessfulConnection = useRef(false);
  const connectInFlight = useRef<Promise<void> | undefined>(undefined);
  const coreRefreshInFlight = useRef(false);
  const lastSuccessfulContact = useRef(Date.now());
  const lastBluetoothReconnect = useRef(0);
  const connectionStateRef = useRef<ConnectionState>("idle");
  const connectionStateChangedAt = useRef(Date.now());
  const configRef = useRef(config);
  const handledVoiceStreams = useRef(new Map<string, number>());
  const voiceActivityHandlerRef = useRef<(activity: VoiceActivity) => void>(() => undefined);
  const voiceIntentHandlerRef = useRef<(intent: VoiceIntent) => void>(() => undefined);

  const activePlayer = currentPlayer(players, activePlayerId, phoneVolumePlayerId);
  phoneVolumeRoute.current = !volumeControl && !!phoneVolumePlayerId && activePlayer?.player_id === phoneVolumePlayerId;
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

  const markConnectionHealthy = useCallback(() => {
    lastSuccessfulContact.current = Date.now();
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
    markConnectionHealthy();
    const visiblePlayers = nextPlayers.filter((player) => player.available);
    setPlayers(visiblePlayers);
    setQueues(nextQueues);
    setActivePlayerId((current) => {
      const selected = nextPlayerId(visiblePlayers, current, loadPhoneVolumePlayerId());
      if (selected) savePlayerId(selected);
      return selected;
    });
  }, [client, markConnectionHealthy]);

  const connect = useCallback(
    async (nextConfig = config, credentials?: { username: string; password: string }) => {
      if (connectInFlight.current) return connectInFlight.current;
      const run = (async () => {
      if (!connectionTarget(nextConfig)) {
        setView("settings");
        return;
      }
      clearTimeout(reconnectTimer.current);
      setConnection("connecting");
      setError("");
      try {
        await client.connect(
          connectionTarget(nextConfig),
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
        markConnectionHealthy();
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
    [client, config, markConnectionHealthy, refreshCore, sideBySide],
  );

  const scheduleReconnect = useCallback(
    (delay = 2_000) => {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = window.setTimeout(() => {
        const nextConfig = configRef.current;
        if (connectionTarget(nextConfig)) void connect(nextConfig);
      }, delay);
    },
    [connect],
  );

  const forceReconnect = useCallback(
    (delay = 750) => {
      const nextConfig = configRef.current;
      if (!connectionTarget(nextConfig)) return;
      client.disconnect();
      setConnection((current) => (current === "idle" ? current : "error"));
      scheduleReconnect(delay);
    },
    [client, scheduleReconnect],
  );

  const ensureConnected = useCallback(async () => {
    if (connectionStateRef.current === "connected" && client.isConnected()) return true;
    const nextConfig = configRef.current;
    if (!connectionTarget(nextConfig)) {
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
      if (key === "phoneVolumePlayerId") {
        setPhoneVolumePlayerId(value || "");
        savePhoneVolumePlayerId(value || "");
        return true;
      }
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
      if (change.key !== "serverUrl" && change.key !== "remoteId" && change.key !== "token" && change.key !== "transport") return;
      setConfig((current) => {
        const next: ConnectionConfig = {
          ...current,
          ...(change.key === "serverUrl" ? { serverUrl: change.value?.trim() || "" } : {}),
          ...(change.key === "remoteId" ? { remoteId: change.value?.trim() || "" } : {}),
          ...(change.key === "token" ? { token: change.value?.trim() || undefined } : {}),
          ...(change.key === "transport"
            ? {
                transport:
                  change.value === "homeassistant" || change.value === "direct" || change.value === "webrtc"
                    ? change.value
                    : "bridgething",
              }
            : {}),
        };
        saveConfig(next);
        window.clearTimeout(configReconnectTimer.current);
        if (connectionTarget(next)) {
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
      markConnectionHealthy();
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
          if (!cancelled && bridgePreferences?.phoneVolumePlayerId !== undefined) {
            setPhoneVolumePlayerId(bridgePreferences.phoneVolumePlayerId);
            savePhoneVolumePlayerId(bridgePreferences.phoneVolumePlayerId);
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
      const configUrls = connectionTarget(nextConfig)
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
      if (connectionTarget(nextConfig)) void connect(nextConfig);
      else setView("settings");
    };
    void bootstrap();
    return () => {
      cancelled = true;
      removeEvent();
      removeClose();
      clearTimeout(reconnectTimer.current);
      client.disconnect();
      clearTimeout(volumeOverlayTimer.current);
    };
    // Initial connection is intentionally performed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

	  useEffect(() => {
	    if (connection === "error") {
	      const localRelay = isLocalRelayUrl(config.serverUrl);
	      const bridgeRuntime = isBridgeThingRuntime(sideBySide);
	      const retryDelay = localRelay ? 4_000 : 8_000;
      reconnectTimer.current = window.setTimeout(() => {
        const nextConfig = configRef.current;
        if (connectionTarget(nextConfig)) void connect(nextConfig);
      }, localRelay ? 2_000 : 5_000);
      const interval = window.setInterval(() => {
        if (connectionStateRef.current !== "error") return;
        const nextConfig = configRef.current;
        if (connectionTarget(nextConfig)) void connect(nextConfig);
      }, retryDelay);
	      const reload = (localRelay && sideBySide) || (bridgeRuntime && hadSuccessfulConnection.current)
	        ? window.setTimeout(() => {
	            const lastReload = Number(window.sessionStorage.getItem(AUTO_RELOAD_STORAGE_KEY) || "0");
	            const reloadAfter = localRelay ? 45_000 : BRIDGETHING_RELOAD_AFTER_STALE_MS;
	            if (Date.now() - lastReload > reloadAfter) {
	              window.sessionStorage.setItem(AUTO_RELOAD_STORAGE_KEY, String(Date.now()));
	              window.location.reload();
	            }
	          }, localRelay ? 18_000 : BRIDGETHING_RELOAD_AFTER_STALE_MS)
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
      const staleFor = Date.now() - lastSuccessfulContact.current;
      if (volumeControl) {
        if (!client.isConnected() || staleFor > staleMs) forceReconnect();
        return;
      }
      if (coreRefreshInFlight.current) {
        if (staleFor > staleMs) forceReconnect();
        return;
      }
      if (!client.isConnected()) {
        forceReconnect();
        return;
      }
      coreRefreshInFlight.current = true;
      void refreshCore()
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          forceReconnect();
        })
        .finally(() => {
          coreRefreshInFlight.current = false;
        });
    }, refreshMs);
    return () => window.clearInterval(interval);
  }, [client, connection, forceReconnect, refreshCore, refreshMs, staleMs, volumeControl]);

  useEffect(() => {
    const reconnectIfNeeded = () => {
      const nextConfig = configRef.current;
      if (!connectionTarget(nextConfig)) return;
      const staleFor = Date.now() - lastSuccessfulContact.current;
      if (connectionStateRef.current === "connected" && client.isConnected()) {
        if (staleFor > staleMs) {
          forceReconnect(250);
          return;
        }
        void refreshCore().catch(() => {
          forceReconnect(750);
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
  }, [client, forceReconnect, refreshCore, scheduleReconnect, staleMs]);

  useEffect(() => {
    if (!isBridgeThingRuntime(sideBySide)) return;
    let unsubscribeBluetooth: (() => void) | undefined;
    let cancelled = false;
    void subscribeBridgeThingBluetooth((connected) => {
      const nextConfig = configRef.current;
      if (!connectionTarget(nextConfig)) return;
      if (connected) {
        const now = Date.now();
        const staleFor = now - lastSuccessfulContact.current;
        if (connectionStateRef.current === "connected" && client.isConnected() && staleFor < staleMs) return;
        if (now - lastBluetoothReconnect.current < 10_000) return;
        lastBluetoothReconnect.current = now;
        forceReconnect(1_000);
        return;
      }
      client.disconnect();
      setConnection((current) => (current === "idle" ? current : "error"));
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else unsubscribeBluetooth = unsubscribe;
      })
      .catch(() => {
        // Older BridgeThing versions may not emit Bluetooth status events.
      });
    return () => {
      cancelled = true;
      unsubscribeBluetooth?.();
    };
  }, [client, forceReconnect, sideBySide, staleMs]);

  useEffect(() => {
    if (!sideBySide || !isLocalRelayUrl(config.serverUrl)) return;
    const watchdog = window.setInterval(() => {
      if (connectionStateRef.current === "connected") return;
      if (Date.now() - connectionStateChangedAt.current < 22_000) return;
      window.location.reload();
    }, 5_000);
    return () => window.clearInterval(watchdog);
  }, [config.serverUrl, sideBySide]);

  const libraryScope = JSON.stringify([config.transport, connectionTarget(config), config.token]);
  useEffect(() => {
    libraryCache.current.setScope(libraryScope);
    libraryRequestId.current += 1;
    setLibrary([]);
    setLibraryHasMore(false);
    setLibraryError("");
    setLibraryBusy(false);
  }, [libraryScope]);

  const loadLibrary = useCallback(
    async (kind: LibraryKind, query = "", append = false, force = false) => {
      const requestId = ++libraryRequestId.current;
      const trimmedQuery = query.trim();
      const key = libraryKey(kind, trimmedQuery);
      libraryCache.current.setScope(libraryScope);
      const cached = libraryCache.current.read(key);
      setLibraryKind(kind);
      setLibraryError("");
      if (!append) {
        setLibrary(cached?.items || []);
        setLibraryHasMore(cached?.hasMore || false);
      }
      const maxAge = kind === "recent" ? 15_000 : 60_000;
      if (!append && !force && cached && Date.now() - cached.updatedAt < maxAge) {
        setLibraryBusy(false);
        return;
      }
      setLibraryBusy(true);
      try {
        if (connection !== "connected" || !client.isConnected()) {
          if (!(await ensureConnected())) return;
        }
        if (requestId !== libraryRequestId.current) return;
        const page = await libraryCache.current.load(key, offset => fetchLibraryPage(client, kind, trimmedQuery, offset), append);
        if (requestId !== libraryRequestId.current) return;
        setLibrary(page.items);
        setLibraryHasMore(page.hasMore);
      } catch (reason) {
        if (requestId !== libraryRequestId.current) return;
        const message = reason instanceof Error ? reason.message : "Library request failed";
        setLibraryError(message);
        showNotice(message);
      } finally {
        if (requestId === libraryRequestId.current) setLibraryBusy(false);
      }
    },
    [client, connection, ensureConnected, libraryScope, showNotice],
  );

  useEffect(() => {
    if (view === "library" && connection === "connected") void loadLibrary(libraryKind, searchQuery);
    // Load on entry or reconnect; an empty/error result must not trigger repeated requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, connection]);

  useEffect(() => {
    if (connection !== "connected") return;
    const timers = (["recent", "playlists"] as LibraryKind[]).map((kind, index) => window.setTimeout(() => {
      if (!client.isConnected()) return;
      const key = libraryKey(kind);
      const cached = libraryCache.current.read(key);
      if (cached && Date.now() - cached.updatedAt < 60_000) return;
      void libraryCache.current.load(key, offset => fetchLibraryPage(client, kind, "", offset)).catch(() => {});
    }, 800 + index * 1200));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [client, connection, libraryScope]);

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

  const playMediaOnPlayer = useCallback(
    async (media: MediaItem | Preset | MediaItem[], targetPlayer: Player, options: PlayMediaOptions = {}) => {
      let startingAiRadio = false;
      try {
        if (!(await ensureConnected())) return;
        const primaryMedia = Array.isArray(media) ? media[0] : media;
        if (!primaryMedia) return showNotice("No playable items found");
        const targetQueue =
          queues.find((queue) => queue.queue_id === targetPlayer.player_id) ??
          queues.find((queue) => queue.queue_id === targetPlayer.active_source);
        const queueId = targetQueue?.queue_id || targetPlayer.player_id;
        const mediaType = "media_type" in primaryMedia ? primaryMedia.media_type : primaryMedia.mediaType;
        if (mediaType === "ai_radio") {
          if (aiRadioStarting.current) return;
          aiRadioStarting.current = true;
          startingAiRadio = true;
          const status = await client.command<{ sessions: Array<{ session_id: string; status: string }> }>("ai_radio/status");
          const running = status.sessions.filter((session) => session.status === "running");
          if (running.length && !options.replaceAiRadio) {
            setAiRadioSwitch({ media: primaryMedia, player: targetPlayer });
            return;
          }
          for (const session of running) await client.command("ai_radio/stop", { session_id: session.session_id });
          showNotice(`Starting ${primaryMedia.name}...`);
          await client.command("ai_radio/start", {
            station_id: decodeURIComponent(primaryMedia.uri.split("/show/")[1] || ""),
            player_id_override: targetPlayer.player_id,
          });
        } else await client.command("player_queues/play_media", {
          queue_id: queueId,
          media: Array.isArray(media) ? media.map((item) => item.uri) : media.uri,
          media_type: "media_type" in primaryMedia ? primaryMedia.media_type : primaryMedia.mediaType,
          option: "replace",
          radio_mode: options.radioMode,
        });
        if (options.shuffle) {
          await client.command("player_queues/shuffle", {
            queue_id: queueId,
            shuffle_enabled: true,
          });
        }
        setActivePlayerId(targetPlayer.player_id);
        savePlayerId(targetPlayer.player_id);
        setView("now");
        window.setTimeout(() => void refreshCore(), 350);
        window.setTimeout(() => void refreshCore(), 1_200);
      } catch (reason) {
        showNotice(reason instanceof Error ? reason.message : "Unable to play item");
      } finally {
        if (startingAiRadio) aiRadioStarting.current = false;
      }
    },
    [client, ensureConnected, queues, refreshCore, showNotice],
  );

  const playMedia = useCallback(
    async (media: MediaItem | Preset) => {
      if (!activePlayer) return showNotice(activePlayerId === phoneVolumePlayerId && phoneVolumePlayerId ? "Waiting for phone audio" : "Select a player first");
      await playMediaOnPlayer(media, activePlayer);
    },
    [activePlayer, activePlayerId, phoneVolumePlayerId, playMediaOnPlayer, showNotice],
  );

  const findVoiceMedia = useCallback(
    async (query: string, targetType?: string) => {
      const libraryMatches: Array<{ item: MediaItem; score: number }> = [];
      for (const kind of voiceLibraryKinds(targetType)) {
        const libraryItems = await client.command<MediaItem[]>(libraryCommands[kind], {
          limit: 20,
          offset: 0,
          favorite: null,
          search: query,
        });
        const libraryMatch = rankBestMedia(libraryItems, query);
        if (libraryMatch && (kind !== "radio" || scoreMatch(query, libraryMatch.item.name) >= 70)) {
          libraryMatches.push(libraryMatch);
        }
      }
      libraryMatches.sort((a, b) => b.score - a.score);
      if (libraryMatches[0]) return libraryMatches[0].item;

      const search = await client.command<Record<string, MediaItem[]>>("music/search", {
        search_query: query,
        limit: 20,
      });
      const searchItems = Object.values(search).flat();
      const preferredTypes =
        targetType === "station"
          ? ["radio"]
          : targetType === "playlist"
          ? ["playlist"]
          : targetType === "album"
          ? ["album"]
          : targetType === "artist"
          ? ["artist"]
          : [];
      const preferredSearchItems = preferredTypes.length
        ? searchItems.filter((item) => preferredTypes.includes(item.media_type))
        : searchItems;
      const searchMatch = findBestMedia(preferredSearchItems, query) ?? findBestMedia(searchItems, query);
      if (searchMatch && (searchMatch.media_type !== "radio" || scoreMatch(query, searchMatch.name) >= 70)) {
        return searchMatch;
      }
      return findBestMedia(searchItems, query);
    },
    [client],
  );

  const findVoiceArtistTracks = useCallback(
    async (query: string, artist: MediaItem) => {
      const artistName = artist.name || query;
      const libraryTracks = await client.command<MediaItem[]>("music/tracks/library_items", {
        limit: VOICE_ARTIST_TRACK_LIMIT,
        offset: 0,
        favorite: null,
        search: artistName,
        order_by: "random",
      });
      const matchingLibraryTracks = libraryTracks.filter((track) => artistMatches(track, artistName));
      const playableLibraryTracks = matchingLibraryTracks.length
        ? matchingLibraryTracks
        : libraryTracks.filter((track) => track.media_type === "track");
      if (playableLibraryTracks.length) return playableLibraryTracks.slice(0, VOICE_ARTIST_TRACK_LIMIT);

      const search = await client.command<Record<string, MediaItem[]>>("music/search", {
        search_query: artistName,
        limit: VOICE_ARTIST_TRACK_LIMIT,
      });
      const searchTracks = (search.tracks ?? []).filter((track) => track.media_type === "track");
      const matchingSearchTracks = searchTracks.filter((track) => artistMatches(track, artistName));
      return matchingSearchTracks.slice(0, VOICE_ARTIST_TRACK_LIMIT);
    },
    [client],
  );

  const resolveVoicePlayer = useCallback(
    (playerQuery?: string) => {
      if (playerQuery) return findBestPlayer(players, playerQuery);
      return activePlayer;
    },
    [activePlayer, players],
  );

  const handleVoicePlay = useCallback(
    async (input: VoiceIntent | VoiceActivity) => {
      const command = parseVoicePlayCommand(input);
      saveVoiceDebug({
        stage: "play-parse",
        transcript: input.transcript,
        intent: input.intent,
        command,
      });
      if (!command) return false;
      const targetPlayer = resolveVoicePlayer(command.playerQuery);
      if (!targetPlayer) {
        saveVoiceDebug({
          stage: "play-no-player",
          transcript: input.transcript,
          command,
          playerQuery: command.playerQuery,
        });
        showNotice(command.playerQuery ? `No player matched ${command.playerQuery}` : "Select a player first");
        return true;
      }
      try {
        if (!(await ensureConnected())) return true;
        const media = await findVoiceMedia(command.mediaQuery, command.targetType);
        if (!media) {
          saveVoiceDebug({
            stage: "play-no-media",
            transcript: input.transcript,
            command,
            player: targetPlayer.display_name || targetPlayer.name,
          });
          showNotice(`No match for ${command.mediaQuery}`);
          return true;
        }
        const artistTracks = media.media_type === "artist" ? await findVoiceArtistTracks(command.mediaQuery, media) : [];
        const playTarget = artistTracks.length ? artistTracks : media;
        const shuffle = media.media_type === "artist";
        const radioMode = media.media_type === "artist" && artistTracks.length === 0;
        saveVoiceDebug({
          stage: "play-match",
          transcript: input.transcript,
          command,
          media: { name: media.name, media_type: media.media_type, uri: media.uri },
          tracks: artistTracks.map((track) => ({ name: track.name, artists: track.artists?.map((artist) => artist.name) })),
          player: targetPlayer.display_name || targetPlayer.name,
          shuffle,
          radioMode,
        });
        showNotice(`Playing ${media.name}${shuffle ? " shuffled" : ""} on ${targetPlayer.display_name || targetPlayer.name}`);
        await playMediaOnPlayer(playTarget, targetPlayer, { shuffle, radioMode });
        return true;
      } catch (reason) {
        saveVoiceDebug({
          stage: "play-error",
          transcript: input.transcript,
          command,
          error: reason instanceof Error ? reason.message : String(reason),
        });
        showNotice(reason instanceof Error ? reason.message : "Voice command failed");
        return true;
      }
    },
    [ensureConnected, findVoiceArtistTracks, findVoiceMedia, playMediaOnPlayer, resolveVoicePlayer, showNotice],
  );

  const handleVoiceIntent = useCallback(
    (intent: VoiceIntent) => {
      saveVoiceDebug({ stage: "intent", transcript: intent.transcript, intent: intent.intent, slots: intent.slots });
      if (intent.intent === "showView") {
        const target = voiceViewTarget(intent.slots.view);
        if (!target) return;
        if (target.libraryKind) {
          setView("library");
          void loadLibrary(target.libraryKind);
        } else {
          setView(target.view);
        }
        return;
      }
      if (intent.intent === "search") {
        const query = intent.slots.target || intent.transcript.replace(/\b(search|find|show)\b/gi, "").trim();
        if (!query) return;
        setSearchQuery(query);
        setView("library");
        void loadLibrary(libraryKind, query);
        return;
      }
      void handleVoicePlay(intent);
    },
    [handleVoicePlay, libraryKind, loadLibrary],
  );

  const handleVoiceActivity = useCallback(
    (activity: VoiceActivity) => {
      if (activity.phase !== "done" && activity.phase !== "failed") return;
      const transcript = activity.transcript?.trim();
      saveVoiceDebug({
        stage: "activity",
        phase: activity.phase,
        transcript,
        intent: activity.intent,
        nluStage: activity.stage,
        target: activity.target,
        error: activity.error,
        slots: activity.slots,
      });
      if (transcript) showNotice(`Voice: ${transcript}`);
      if (activity.error && !transcript) return;
      const now = Date.now();
      handledVoiceStreams.current.forEach((handledAt, streamId) => {
        if (now - handledAt > VOICE_COMMAND_FRESH_MS) handledVoiceStreams.current.delete(streamId);
      });
      if (activity.streamId) {
        if (handledVoiceStreams.current.has(activity.streamId)) return;
        handledVoiceStreams.current.set(activity.streamId, now);
      }
      void handleVoicePlay(activity);
    },
    [handleVoicePlay, showNotice],
  );

  useEffect(() => {
    voiceActivityHandlerRef.current = handleVoiceActivity;
    voiceIntentHandlerRef.current = handleVoiceIntent;
  }, [handleVoiceActivity, handleVoiceIntent]);

  useEffect(() => {
    if (!isBridgeThingRuntime(sideBySide)) return;
    let unsubscribeVoice: (() => void) | undefined;
    let cancelled = false;
    void subscribeBridgeThingVoice({
      activity: (activity) => voiceActivityHandlerRef.current(activity),
      intent: (intent) => voiceIntentHandlerRef.current(intent),
    })
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else unsubscribeVoice = unsubscribe;
      })
      .catch(() => {
        // Voice is only available on newer BridgeThing firmware.
      });
    return () => {
      cancelled = true;
      unsubscribeVoice?.();
    };
  }, [sideBySide]);

  useEffect(() => {
    if (!isBridgeThingRuntime(sideBySide)) return;
    let cancelled = false;
    let control: Awaited<ReturnType<typeof connectBridgeThingPhoneVolume>> | undefined;
    void connectBridgeThingPhoneVolume(percent => {
      setPhoneVolumePercent(percent);
      if (phoneVolumeRoute.current && volumePreviewRef.current !== undefined) {
        volumePreviewRef.current = percent;
        setVolumePreview(percent);
      }
    }, () => { if (phoneVolumeRoute.current) showNotice("Phone media volume is unavailable"); }).then(next => {
      control = next;
      if (cancelled) next.close();
      else phoneVolumeControl.current = next;
    }).catch(() => showNotice("Phone volume connection unavailable"));
    return () => { cancelled = true; control?.close(); phoneVolumeControl.current = undefined; };
  }, [sideBySide, showNotice]);

  useEffect(() => {
    window.clearTimeout(volumeOverlayTimer.current);
    volumePreviewRef.current = undefined;
    setVolumePreview(undefined);
  }, [activePlayer?.player_id, phoneVolumePlayerId, volumeControl]);

  const playerVolume = usePlayerVolume({
    client,
    player: volumeControl?.player ?? activePlayer,
    players,
    enabled: !phoneVolumeRoute.current,
    individual: volumeControl?.individual,
    nativeId: !!volumeControl,
    connectionKey: JSON.stringify([config.transport, connectionTarget(config), config.token, client.volumeRevision]),
    ensureConnected,
    onError: showNotice,
  });

  const changeVolume = useCallback(
    (change: number) => {
      if (!activePlayer && !volumeControl) return;
      if (phoneVolumeRoute.current) {
        if (!phoneVolumeControl.current) return showNotice("Phone volume connection unavailable");
        volumePreviewRef.current = phoneVolumePercent ?? 0;
        setVolumePreview(phoneVolumePercent ?? 0);
        void phoneVolumeControl.current.adjust(change).catch(() => showNotice("Unable to change phone volume"));
        window.clearTimeout(volumeOverlayTimer.current);
        volumeOverlayTimer.current = window.setTimeout(() => { volumePreviewRef.current = undefined; setVolumePreview(undefined); }, VOLUME_OVERLAY_HIDE_MS);
        return;
      }
      playerVolume.changeVolume(change);
    },
    [activePlayer, volumeControl, playerVolume.changeVolume, phoneVolumePercent, showNotice],
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

  const scrollPlayers = (delta: number) => {
    const dialog = document.querySelector(".players-page [role=dialog]");
    const area = dialog ? dialog.querySelector(".group-members-list") : document.querySelector(".players-page");
    area?.scrollBy({ top: delta, behavior: "auto" });
  };

  useHardware({
    dialLeft: () => (view === "players" && !volumeControl ? scrollPlayers(-72) : view === "queue" ? selectQueueDelta(-1) : changeVolume(-2)),
    dialRight: () => (view === "players" && !volumeControl ? scrollPlayers(72) : view === "queue" ? selectQueueDelta(1) : changeVolume(2)),
    dialPress: () => (view === "queue" ? playSelectedQueueItem() : void playerCommand("play_pause")),
    presetPress: pressPreset,
    presetLongPress: savePreset,
    back: () => {
      if (fullPlayer) setPlayerFullscreen(false);
      else if (sideBySide && view === "now") returnToNocturne();
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

  const artworkBase = config.transport === "webrtc" ? REMOTE_ARTWORK_BASE : config.serverUrl;
  const ambientArtwork = useArtworkUrl(imageUrl(artworkBase, itemImage(currentItem), 256, artworkCacheKey(currentItem)));
  return (
    <main className={`device-shell${fullPlayer ? " player-fullscreen" : ""}`} data-display-size={displaySize} data-now-playing-text-size={nowPlayingTextSize}>
      <div className="ambient" style={{ backgroundImage: ambientArtwork ? `url(${ambientArtwork})` : undefined }} />

      <section className="content">
        {view === "now" && <button className="player-fullscreen-toggle" aria-label={fullPlayer ? "Show navigation" : "Expand player"} title={fullPlayer ? "Show navigation" : "Expand player"} aria-pressed={fullPlayer} onClick={() => setPlayerFullscreen(current => !current)}>{fullPlayer ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>}
        {view === "now" && (
          <NowPlaying
            item={currentItem}
            serverUrl={artworkBase}
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
            error={libraryError}
            query={searchQuery}
            serverUrl={artworkBase}
            onKind={(kind) => { setSearchQuery(""); void loadLibrary(kind); }}
            onRefresh={() => void loadLibrary(libraryKind, searchQuery, false, true)}
            onQuery={setSearchQuery}
            onSearch={submitSearch}
            onSelect={(item) => setPresetCandidate(item)}
            onPlay={(item) => void playMedia(item)}
            selected={presetCandidate?.uri}
            hasMore={libraryHasMore}
            onLoadMore={() => void loadLibrary(libraryKind, searchQuery, true)}
          />
        )}
        {view === "players" && <PlayersView client={client} fallbackPlayers={players} selected={activePlayer?.player_id} onSelect={selectPlayer} onChanged={refreshCore} onVolumeControl={setVolumeControl} onVolumeData={markConnectionHealthy} volumeLevel={playerVolume.volume} phoneVolumePlayerId={phoneVolumePlayerId} phoneVolumePercent={phoneVolumePercent} onPhoneVolumePlayer={isBridgeThingRuntime(sideBySide) ? id => {
          setPhoneVolumePlayerId(id);
          savePhoneVolumePlayerId(id);
          void setBridgeThingPhoneVolumePlayer(id).catch(() => showNotice("Phone volume saved on this device only"));
        } : undefined} />}
        {view === "queue" && (
          <QueueView
            items={queueItems}
            current={activeQueue?.current_item?.queue_item_id}
            currentIndex={activeQueue?.current_index ?? 0}
            lockedIndex={activeQueue?.index_in_buffer ?? activeQueue?.current_index ?? -1}
            selectedIndex={selectedQueueIndex}
            serverUrl={artworkBase}
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

      {!fullPlayer && <nav className={sideBySide ? "navrail with-nocturne" : "navrail"}>
        <NavButton active={view === "now"} label="Now" icon={<Home />} onClick={() => setView("now")} />
        <NavButton active={view === "library"} label="Library" icon={<Disc3 />} onClick={() => setView("library")} />
        <NavButton active={view === "players"} label="Players" icon={<Speaker />} onClick={() => setView("players")} />
        <NavButton active={view === "queue"} label="Queue" icon={<ListMusic />} onClick={openQueueView} />
        <NavButton active={view === "settings"} label="Setup" icon={<Settings />} onClick={() => setView("settings")} />
        {sideBySide && <NavButton active={false} label="Nocturne" icon={<ArrowLeft />} onClick={returnToNocturne} />}
      </nav>}

      {aiRadioSwitch && (
        <div className="ai-radio-backdrop">
          <div className="ai-radio-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-radio-switch-title">
            <h2 id="ai-radio-switch-title">Switch AI Radio show?</h2>
            <p>An AI Radio show is already on air. Stop it and play {aiRadioSwitch.media.name} on {aiRadioSwitch.player.display_name || aiRadioSwitch.player.name}?</p>
            <div className="ai-radio-actions">
              <button onClick={() => setAiRadioSwitch(undefined)}>Cancel</button>
              <button className="primary" onClick={() => {
                const pending = aiRadioSwitch;
                setAiRadioSwitch(undefined);
                void playMediaOnPlayer(pending.media, pending.player, { replaceAiRadio: true });
              }}>Switch show</button>
            </div>
          </div>
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      {!volumeControl && (volumePreview ?? playerVolume.volume) !== undefined && <VolumeOverlay volume={(volumePreview ?? playerVolume.volume)!} />}
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
  const image = useArtworkUrl(imageUrl(serverUrl, itemImage(item), 256, artworkCacheKey(item)));
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

function LibraryView({ kind, items, busy, error, query, serverUrl, selected, hasMore, onKind, onRefresh, onQuery, onSearch, onSelect, onPlay, onLoadMore }: {
  kind: LibraryKind; items: MediaItem[]; busy: boolean; error: string; query: string; serverUrl: string; selected?: string; hasMore: boolean;
  onKind: (kind: LibraryKind) => void; onQuery: (query: string) => void; onSearch: (event: FormEvent) => void;
  onSelect: (item: MediaItem) => void; onPlay: (item: MediaItem) => void; onLoadMore: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div><h2>Your library</h2><p>Long-press 1–4 to save the selected item</p></div>
        <button onClick={onRefresh} disabled={busy} title="Refresh library" aria-label="Refresh library"><RefreshCw size={18} className={busy ? "spin" : ""} /></button>
        <form className="search-box" onSubmit={onSearch}><Search size={17} /><input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search" /></form>
      </div>
      <div className="filter-row">
        {(["recent", "playlists", "albums", "artists", "radio", "ai_radio"] as LibraryKind[]).map((value) => (
          <button className={kind === value ? "active" : ""} key={value} onClick={() => onKind(value)}>{value === "ai_radio" ? "AI Radio" : value}</button>
        ))}
      </div>
      {busy && !items.length ? <div className="center-state"><LoaderCircle className="spin" /> Loading library…</div> : (
        <div className="media-grid">
          {items.map((item) => {
            const image = imageUrl(serverUrl, itemImage(item), 256);
            return (
              <article className={selected === item.uri ? "media-card selected" : "media-card"} key={item.uri} onClick={() => onSelect(item)} onDoubleClick={() => onPlay(item)}>
                <div className="media-image"><Artwork url={image} fallback={item.media_type === "ai_radio" ? <Radio /> : <Album />} /></div>
                <div className="media-copy"><strong>{item.name}</strong><span>{itemSubtitle(item)}</span></div>
                <button onClick={(event) => { event.stopPropagation(); onPlay(item); }} aria-label={`Play ${item.name}`}><Play fill="currentColor" /></button>
              </article>
            );
          })}
          {!items.length && <div className="center-state">{error || (kind === "ai_radio" ? "No AI Radio shows found" : "No library items found")}</div>}
          {!!error && <button onClick={onRefresh} aria-label="Retry library"><RefreshCw size={18} /></button>}
          {hasMore && <button className="load-more" onClick={onLoadMore} disabled={busy}>{busy ? "Loading…" : `Load more (${items.length} shown)`}</button>}
        </div>
      )}
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
            <span className="queue-art"><Artwork url={image} fallback={<Music2 />} /></span>
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
  const [remoteId, setRemoteId] = useState(config.remoteId || "");
  const [transport, setTransport] = useState<ConnectionConfig["transport"]>(config.transport ?? "direct");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState("");
  const showLoginFields = transport !== "homeassistant";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateConnection({ serverUrl, remoteId, transport });
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setFormError("");
    onConnect(
      { serverUrl: serverUrl.trim(), remoteId: normalizeRemoteId(remoteId), token: transport === config.transport && (transport === "webrtc" ? normalizeRemoteId(remoteId) === normalizeRemoteId(config.remoteId || "") : serverUrl.trim() === config.serverUrl) ? config.token : undefined, transport },
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
          {transport === "webrtc" ? <label>Music Assistant Remote ID<input value={remoteId} onChange={e => setRemoteId(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} /></label> : <label>{urlLabel(transport)}<input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={urlPlaceholder(transport)} /></label>}
          <label>Connection path<select value={transport ?? "direct"} onChange={(e) => setTransport(e.target.value as ConnectionConfig["transport"])}>
            <option value="homeassistant">Home Assistant / Nabu Casa</option>
            <option value="webrtc">Music Assistant WebRTC</option>
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

function Artwork({ url, fallback }: { url: string; fallback: React.ReactNode }) {
  const image = useArtworkUrl(url);
  return image ? <img src={image} alt="" /> : fallback;
}
