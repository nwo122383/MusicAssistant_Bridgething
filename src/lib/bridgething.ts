import type { ConnectionConfig } from "../types";
import type { BrightnessPreference, DisplaySize, NowPlayingTextSize } from "./storage";

export type BridgeThingPreferences = {
  config?: ConnectionConfig;
  displaySize?: DisplaySize;
  nowPlayingTextSize?: NowPlayingTextSize;
  brightness?: BrightnessPreference;
};

export type BridgeThingConfigChange = {
  key: string;
  value?: string | null;
};

export type BridgeThingDocChange = {
  key: string;
  value: string | null;
};

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
      displaySize: parseDisplaySize(docEntries.displaySize ?? configEntries.displaySize),
      nowPlayingTextSize: parseNowPlayingTextSize(docEntries.nowPlayingTextSize ?? configEntries.nowPlayingTextSize),
      brightness: brightnessMode ? { mode: brightnessMode, level: brightnessLevel } : undefined,
    };
    if (!serverUrl) return preferences;
    preferences.config = {
      serverUrl,
      token: configEntries.token?.trim() || undefined,
      transport:
        configEntries.transport === "homeassistant" || configEntries.transport === "direct"
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
