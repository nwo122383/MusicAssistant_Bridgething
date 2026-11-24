import { beforeEach, describe, expect, it } from "vitest";
import {
  loadBrightnessPreference,
  loadConfig,
  loadCompanionPhoneId,
  loadNowPlayingTextSize,
  loadPlayerId,
  loadPresets,
  saveBrightnessPreference,
  saveConfig,
  saveCompanionPhoneId,
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

  it("remembers verified companion identity without changing connection settings or selection", () => {
    saveConfig({ serverUrl: "https://example.com", transport: "homeassistant", token: "test-token" });
    savePlayerId("home-speaker");
    expect(loadCompanionPhoneId()).toBe("");
    saveCompanionPhoneId("verified-phone");
    expect(loadCompanionPhoneId()).toBe("verified-phone");
    expect(loadPlayerId()).toBe("home-speaker");
    expect(loadConfig()).toEqual({ serverUrl: "https://example.com", transport: "homeassistant", token: "test-token" });
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
