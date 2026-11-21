import { base32nopad } from "@scure/base";
import type { ConnectionConfig } from "../types";

export function connectionTimings(transport?: ConnectionConfig["transport"]) {
  // Full player/queue snapshots can take seconds over Bluetooth-backed TURN.
  return transport === "webrtc"
    ? { commandMs: 30_000, refreshMs: 15_000, staleMs: 45_000 }
    : { commandMs: 15_000, refreshMs: 4_000, staleMs: 18_000 };
}

export function normalizeRemoteId(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "");
}

export function validRemoteId(value: string): boolean {
  try {
    return base32nopad.decode(normalizeRemoteId(value).replace(/9/g, "2")).length === 16;
  } catch {
    return false;
  }
}

export function connectionTarget(config: ConnectionConfig): string {
  return config.transport === "webrtc" ? normalizeRemoteId(config.remoteId || "") : config.serverUrl;
}

export function validateConnection(config: ConnectionConfig): string | undefined {
  if (config.transport === "webrtc") {
    return validRemoteId(config.remoteId || "") ? undefined : "Enter the Remote ID from Music Assistant Remote Access settings";
  }
  let url: URL;
  try { url = new URL(config.serverUrl.trim()); } catch {
    return "Enter a Music Assistant URL, not a Remote ID";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Music Assistant URL must start with http:// or https://";
  if ((config.transport === "bridgething" || config.transport === "homeassistant") && url.protocol !== "https:") {
    return "BridgeThing Android requires an https:// URL";
  }
}

export function tcpRelayServers(servers: RTCIceServer[]): RTCIceServer[] {
  const filtered = servers.flatMap(server => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url =>
      /^turns:/i.test(url) ? !/[?&]transport=udp(?:&|$)/i.test(url) : /^turn:/i.test(url) && /[?&]transport=tcp(?:&|$)/i.test(url));
    return urls.length ? [{ ...server, urls }] : [];
  });
  if (!filtered.length) throw new Error("WebRTC over BridgeThing needs a TCP/TLS TURN server. Enable WebRTC Connections in Home Assistant Cloud, then reconnect.");
  return filtered;
}
