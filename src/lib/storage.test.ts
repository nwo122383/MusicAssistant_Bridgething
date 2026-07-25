import { beforeEach, describe, expect, it } from "vitest";
import {
  loadBrightnessPreference,
  loadConfig,
  loadNowPlayingTextSize,
  loadPlayerId,
  loadPresets,
  saveBrightnessPreference,
  saveConfig,
  saveNowPlayingTextSize,
  savePlayerId,
  savePresets,
} from "./storage";

describe("device-local settings", () => {
  beforeEach(() => localStorage.clear());

  it("persists connection settings", () => {
    saveConfig({ serverUrl: "http://ma.local:8095", token: "device-token" });
    expect(loadConfig()).toEqual({ serverUrl: "http://ma.local:8095", token: "device-token" });
  });

  it("persists the active player and presets", () => {
    savePlayerId("sonos-kitchen");
    savePresets([{ slot: 1, uri: "library://playlist/1", name: "Morning", mediaType: "playlist" }]);
    expect(loadPlayerId()).toBe("sonos-kitchen");
    expect(loadPresets()[0]?.name).toBe("Morning");
  });

  it("persists the Now Playing text size", () => {
    expect(loadNowPlayingTextSize()).toBe("medium");
    saveNowPlayingTextSize("xlarge");
    expect(loadNowPlayingTextSize()).toBe("xlarge");
  });

  it("persists the brightness preference", () => {
    expect(loadBrightnessPreference()).toBeUndefined();
    saveBrightnessPreference({ mode: "manual", level: 0.32 });
    expect(loadBrightnessPreference()).toEqual({ mode: "manual", level: 0.32 });
  });
});
