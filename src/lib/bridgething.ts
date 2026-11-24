import type { ConnectionConfig } from "../types";
import type { BrightnessPreference, DisplaySize, NowPlayingTextSize } from "./storage";
import type { VoiceActivity, VoiceIntent } from "@bridgething/client";

export type BridgeThingPreferences = {
  config?: ConnectionConfig;
  displaySize?: DisplaySize;
  nowPlayingTextSize?: NowPlayingTextSize;
  brightness?: BrightnessPreference;
  phoneVolumePlayerId?: string;
};

export type BridgeThingConfigChange = {
  key: string;
  value?: string | null;
};

export type BridgeThingDocChange = {
  key: string;
  value: string | null;
};

export type BridgeThingVoiceHandlers = {
  activity?: (activity: VoiceActivity) => void;
  intent?: (intent: VoiceIntent) => void;
};

export type BridgeThingBluetoothHandler = (connected: boolean) => void;

export function isBridgeThingRuntime(sideBySide: boolean): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("transport") === "bridgething" || params.get("bridgething") === "1") return true;
  if (sideBySide || window.location.port === "4173") return false;
  return window.location.protocol === "file:" || window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

export async function loadBridgeThingConfig(): Promise<ConnectionConfig | undefined> {
  const preferences = await loadBridgeThingPreferences();
  return preferences?.config;
}

export async function subscribeBridgeThingConfig(
  handler: (change: BridgeThingConfigChange) => void,
): Promise<() => void> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  const unsubscribe = client.config.onChanged((change) => handler(change));
  return () => {
    unsubscribe();
    client.close();
  };
}

export async function subscribeBridgeThingDocs(
  handler: (change: BridgeThingDocChange) => void,
): Promise<() => void> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  const unsubscribe = client.doc.onChanged((change) => handler(change));
  return () => {
    unsubscribe();
    client.close();
  };
}

export async function subscribeBridgeThingVoice(handlers: BridgeThingVoiceHandlers): Promise<() => void> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  const unsubscribers = [
    handlers.activity ? client.voice.onActivity(handlers.activity) : undefined,
    handlers.intent ? client.voice.onIntent(handlers.intent) : undefined,
  ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
  return () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    client.close();
  };
}

export async function subscribeBridgeThingBluetooth(handler: BridgeThingBluetoothHandler): Promise<() => void> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  let closed = false;
  let probing = false;
  let revision = 0;
  let connected: boolean | undefined;
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  const scheduleProbe = () => {
    window.clearTimeout(timer);
    if (!closed) timer = window.setTimeout(() => void probe(), connected === true ? 10_000 : 2_000);
  };
  const report = (connected: boolean) => {
    revision += 1;
    if (!closed) {
      reportState(connected);
      scheduleProbe();
    }
  };
  const reportState = (value: boolean) => { connected = value; if (!closed) handler(value); };
  const unsubscribers = [
    client.bluetooth.onStatus((status) => report(status.connected)),
    client.bluetooth.onConnectedDevice(() => report(true)),
  ];
  const probe = async () => {
    if (closed || probing) return;
    probing = true;
    const startedAt = revision;
    // A fresh SDK connection also detects recovery after a missed daemon event.
    const probeClient = new BridgethingClient();
    try {
      const result = await probeClient.capabilities.get({ timeoutMs: 3_000 });
      if (!closed && startedAt === revision && result.ok) reportState(!!result.response.capabilities.gateway);
    } catch {
      // An unanswered local RPC is unknown state, not proof the phone disconnected.
    } finally {
      probeClient.close();
      probing = false;
      scheduleProbe();
    }
  };
  void probe();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    client.close();
  };
}

export type PhoneVolumeControl = { adjust: (direction: number) => Promise<void>; close: () => void };

export async function connectBridgeThingPhoneVolume(onVolume: (percent: number) => void, onError: () => void): Promise<PhoneVolumeControl> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  let lastCommand = 0;
  const offVolume = client.audio.onVolumeChanged(event => {
    if (Number.isFinite(event.level)) onVolume(Math.round(Math.max(0, Math.min(1, event.level)) * 100));
  });
  const offError = client.audio.onErrorEvent(() => { if (Date.now() - lastCommand < 3000) onError(); });
  return {
    adjust: async direction => {
      lastCommand = Date.now();
      if (direction > 0) await client.audio.volumeUp();
      else if (direction < 0) await client.audio.volumeDown();
    },
    close: () => { offVolume(); offError(); client.close(); },
  };
}

export async function setBridgeThingPhoneVolumePlayer(playerId: string): Promise<void> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  try {
    const result = await client.doc.set({ key: "phoneVolumePlayerId", value: playerId }, { timeoutMs: 3000 });
    if (!result.ok) throw new Error("Unable to save phone volume player");
  } finally { client.close(); }
}

export async function loadBridgeThingPreferences(): Promise<BridgeThingPreferences | undefined> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  try {
    const [configResult, docResult] = await Promise.all([
      client.config.list({ timeoutMs: 3_000 }),
      client.doc.list({ timeoutMs: 3_000 }),
    ]);
    if (!configResult.ok && !docResult.ok) return undefined;
    const configEntries = configResult.ok
      ? Object.fromEntries(configResult.response.entries.map((entry) => [entry.key, entry.value]))
      : {};
    const docEntries = docResult.ok
      ? Object.fromEntries(docResult.response.entries.map((entry) => [entry.key, entry.value]))
      : {};
    const serverUrl = configEntries.serverUrl?.trim();
    const brightnessMode =
      docEntries.brightnessMode === "manual"
        ? "manual"
        : docEntries.brightnessMode === "auto"
        ? "auto"
        : configEntries.brightnessMode === "manual"
        ? "manual"
        : configEntries.brightnessMode === "auto"
        ? "auto"
        : undefined;
    const brightnessLevel = normalizeLevel(Number(docEntries.brightnessLevel ?? configEntries.brightnessLevel ?? "0.55"));
    const preferences: BridgeThingPreferences = {
      phoneVolumePlayerId: docEntries.phoneVolumePlayerId,
      displaySize: parseDisplaySize(docEntries.displaySize ?? configEntries.displaySize),
      nowPlayingTextSize: parseNowPlayingTextSize(docEntries.nowPlayingTextSize ?? configEntries.nowPlayingTextSize),
      brightness: brightnessMode ? { mode: brightnessMode, level: brightnessLevel } : undefined,
    };
    if (!serverUrl && !(configEntries.transport === "webrtc" && configEntries.remoteId?.trim())) return preferences;
    preferences.config = {
      serverUrl: serverUrl || "",
      remoteId: configEntries.remoteId?.trim() || undefined,
      token: configEntries.token?.trim() || undefined,
      transport:
        configEntries.transport === "homeassistant" || configEntries.transport === "direct" || configEntries.transport === "webrtc"
          ? configEntries.transport
          : "bridgething",
    };
    return preferences;
  } finally {
    client.close();
  }
}

function parseDisplaySize(value: string | null | undefined): DisplaySize | undefined {
  return value === "standard" || value === "large" || value === "xlarge" ? value : undefined;
}

function parseNowPlayingTextSize(value: string | null | undefined): NowPlayingTextSize | undefined {
  return value === "small" || value === "medium" || value === "large" || value === "xlarge" ? value : undefined;
}

export async function readBridgeThingBrightness(): Promise<BrightnessPreference | undefined> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  try {
    const result = await client.hardware.stateGet({ timeoutMs: 3_000 });
    if (!result.ok) return undefined;
    const brightness = result.response.state.brightness;
    return {
      mode: brightness.mode,
      level: normalizeLevel(brightness.mode === "manual" ? brightness.level : brightness.effectiveLevel),
    };
  } finally {
    client.close();
  }
}

export async function applyBridgeThingBrightness(preference: BrightnessPreference): Promise<void> {
  const { BridgethingClient } = await import("@bridgething/client");
  const client = new BridgethingClient();
  try {
    await client.hardware.displaySetMode({ mode: preference.mode });
    if (preference.mode === "manual") {
      await client.hardware.displaySetLevel({ level: normalizeLevel(preference.level) });
    }
  } finally {
    client.close();
  }
}

function normalizeLevel(level: number): number {
  if (!Number.isFinite(level)) return 0.55;
  return Math.max(0.05, Math.min(1, level));
}
