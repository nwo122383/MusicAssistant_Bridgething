import { describe, expect, it } from "vitest";
import { base32nopad } from "@scure/base";
import { connectionTarget, normalizeRemoteId, tcpRelayServers, validRemoteId, validateConnection } from "./connection";
import { verifyAndSanitizeSdp } from "./ma-remote/crypto-utils";

const remoteId = base32nopad.encode(new Uint8Array(16).fill(17)).replace(/2/g, "9");
const fingerprint = Array(32).fill("11").join(":");

describe("WebRTC connection configuration", () => {
  it("accepts formatted Remote IDs without requiring a server URL", () => {
    const formatted = `${remoteId.slice(0, 8)}-${remoteId.slice(8)}`.toLowerCase();
    expect(normalizeRemoteId(formatted)).toBe(remoteId);
    expect(validRemoteId(formatted)).toBe(true);
    expect(validateConnection({ serverUrl: "", remoteId: formatted, transport: "webrtc" })).toBeUndefined();
    expect(connectionTarget({ serverUrl: "https://old.example.com", remoteId: formatted, transport: "webrtc" })).toBe(remoteId);
  });
  it("rejects malformed IDs, URLs and incorrect decoded lengths", () => {
    for (const value of ["", "MA-1234", "https://ma.example.com", "A".repeat(24), "A".repeat(25) + "8"]) {
      expect(validRemoteId(value)).toBe(false);
    }
  });
  it("keeps existing HTTPS requirements for phone-backed URL connections", () => {
    expect(validateConnection({ serverUrl: "http://ma.local", transport: "homeassistant" })).toMatch(/https/);
    expect(validateConnection({ serverUrl: "http://ma.local", transport: "direct" })).toBeUndefined();
  });
  it("uses only TCP/TLS TURN and retains credentials without mutating the server list", () => {
    const servers = [{ urls: ["stun:stun.example.com", "turn:turn.example.com?transport=udp", "turn:turn.example.com?transport=tcp", "turns:turn.example.com:443"], username: "user", credential: "test-only" }];
    const filtered = tcpRelayServers(servers);
    expect(filtered).toEqual([{ ...servers[0], urls: ["turn:turn.example.com?transport=tcp", "turns:turn.example.com:443"] }]);
    expect(servers[0].urls).toHaveLength(4);
    expect(() => tcpRelayServers([{ urls: "stun:stun.example.com" }])).toThrow(/Home Assistant Cloud/);
    expect(() => tcpRelayServers([{ urls: "turns:turn.example.com?transport=udp" }])).toThrow();
  });
});

describe("Music Assistant server identity verification", () => {
  it("accepts the pinned SHA-256 fingerprint and removes other fingerprint algorithms", () => {
    const sdp = `v=0\r\na=fingerprint:sha-512 AA:BB\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
    expect(verifyAndSanitizeSdp(sdp, remoteId)).not.toContain("sha-512");
  });
  it("rejects a mismatched server, missing fingerprint, and per-media fingerprint substitution", () => {
    expect(() => verifyAndSanitizeSdp(`a=fingerprint:sha-256 ${fingerprint.replace(/^11/, "22")}\r\n`, remoteId)).toThrow(/mismatch/);
    expect(() => verifyAndSanitizeSdp("v=0\r\n", remoteId)).toThrow(/fingerprint/);
    expect(() => verifyAndSanitizeSdp(`a=fingerprint:sha-256 ${fingerprint}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fingerprint.replace(/^11/, "22")}\r\n`, remoteId)).toThrow(/mismatch/);
  });
});
