import type { ConnectionConfig, Preset } from "../types";

const CONFIG_KEY = "carthing-ma-config-v1";
const PRESETS_KEY = "carthing-ma-presets-v1";
const PLAYER_KEY = "carthing-ma-player-v1";
const DISPLAY_SIZE_KEY = "carthing-ma-display-size-v1";
const NOW_PLAYING_TEXT_SIZE_KEY = "carthing-ma-now-playing-text-size-v1";
const BRIGHTNESS_KEY = "carthing-ma-brightness-v1";

export type DisplaySize = "standard" | "large" | "xlarge";
export type NowPlayingTextSize = "small" | "medium" | "large" | "xlarge";
export type BrightnessPreference = {
  mode: "auto" | "manual";
  level: number;
};

export const loadConfig = (): ConnectionConfig => {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") as ConnectionConfig;
  } catch {
    return { serverUrl: "" };
  }
};

export const saveConfig = (config: ConnectionConfig): void =>
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));

export const loadPresets = (): Preset[] => {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_KEY) || "[]") as Preset[];
  } catch {
    return [];
  }
};

export const savePresets = (presets: Preset[]): void =>
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));

export const loadPlayerId = (): string => localStorage.getItem(PLAYER_KEY) || "";
export const savePlayerId = (id: string): void => localStorage.setItem(PLAYER_KEY, id);
export const loadDisplaySize = (): DisplaySize => {
  const value = localStorage.getItem(DISPLAY_SIZE_KEY);
  return value === "large" || value === "xlarge" ? value : "standard";
};
export const saveDisplaySize = (size: DisplaySize): void => localStorage.setItem(DISPLAY_SIZE_KEY, size);
export const loadNowPlayingTextSize = (): NowPlayingTextSize => {
  const value = localStorage.getItem(NOW_PLAYING_TEXT_SIZE_KEY);
  return value === "small" || value === "large" || value === "xlarge" ? value : "medium";
};
export const saveNowPlayingTextSize = (size: NowPlayingTextSize): void =>
  localStorage.setItem(NOW_PLAYING_TEXT_SIZE_KEY, size);
export const loadBrightnessPreference = (): BrightnessPreference | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(BRIGHTNESS_KEY) || "null") as Partial<BrightnessPreference> | null;
    if (!value || (value.mode !== "auto" && value.mode !== "manual")) return undefined;
    return {
      mode: value.mode,
      level: normalizeBrightnessLevel(value.level),
    };
  } catch {
    return undefined;
  }
};
export const saveBrightnessPreference = (preference: BrightnessPreference): void =>
  localStorage.setItem(BRIGHTNESS_KEY, JSON.stringify({
    mode: preference.mode,
    level: normalizeBrightnessLevel(preference.level),
  }));

function normalizeBrightnessLevel(value: unknown): number {
  const level = typeof value === "number" ? value : 0.45;
  return Math.max(0.05, Math.min(1, level));
}
