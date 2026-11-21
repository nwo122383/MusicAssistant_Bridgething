import { normalizeRemoteId, validRemoteId } from "./connection";
import { WebRTCTransport } from "./ma-remote/webrtc-transport";

export function createWebRtcSocket(remoteId: string, onMessage: (data: string) => void, onClose: () => void, onError: (error: Error) => void, tcpRelayOnly = true) {
  if (!validRemoteId(remoteId)) throw new Error("Invalid Music Assistant Remote ID");
  if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC is not available in this browser");
  const transport = new WebRTCTransport({
    remoteId: normalizeRemoteId(remoteId),
    signalingServerUrl: "wss://signaling.music-assistant.io/ws",
    reconnect: false,
    tcpRelayOnly,
  });
  let closed = false;
  transport.on("message", data => { if (!closed) onMessage(data); });
  transport.on("close", () => { if (!closed) onClose(); });
  transport.on("error", error => { if (!closed) onError(error); });
  return {
    ready: Promise.resolve().then(() => { if (!closed) return transport.connect(); }),
    isOpen: () => !closed && transport.isConnected,
    send: (data: string) => transport.send(data),
    close: () => { closed = true; transport.disconnect(); },
    fetchImage: async (path: string, token?: string) => {
      const response = await transport.sendHttpProxyRequest("GET", path, token ? { Authorization: `Bearer ${token}` } : {});
      if (response.status !== 200) throw new Error("Remote artwork unavailable");
      const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "image/jpeg";
      if (!type.startsWith("image/")) throw new Error("Invalid remote artwork response");
      return new Blob([new Uint8Array(response.body)], { type });
    },
  };
}
