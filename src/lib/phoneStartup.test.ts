import { describe, expect, it } from "vitest";
import { phoneStartupTarget } from "./phonePlayer";

const id = "a".repeat(43);
describe("phone-first startup gating", () => {
  it("only prioritizes the selected assigned native phone on HA Cloud", () => {
    expect(phoneStartupTarget({ serverUrl: "https://example.com", transport: "homeassistant" }, id, id, id)).toBe(id);
    for (const transport of ["direct", "bridgething", "webrtc"] as const) {
      expect(phoneStartupTarget({ serverUrl: "https://example.com", transport }, id, id, id)).toBeUndefined();
    }
    expect(phoneStartupTarget({ serverUrl: "", transport: "homeassistant" }, "media_player.move", id, id)).toBeUndefined();
    expect(phoneStartupTarget({ serverUrl: "", transport: "homeassistant" }, "media_player.phone", "media_player.phone", "media_player.phone")).toBeUndefined();
    expect(phoneStartupTarget({ serverUrl: "", transport: "homeassistant" }, "", "", "")).toBeUndefined();
    expect(phoneStartupTarget({ serverUrl: "", transport: "homeassistant" }, id, id, "")).toBeUndefined();
    expect(phoneStartupTarget({ serverUrl: "", transport: "homeassistant" }, id, id, "another-verified-phone")).toBeUndefined();
  });
});
