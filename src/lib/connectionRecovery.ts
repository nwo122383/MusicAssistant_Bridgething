import type { ConnectionConfig, ConnectionState } from "../types";
import { normalizeRemoteId } from "./connection";

export function sameConnection(a: ConnectionConfig, b: ConnectionConfig): boolean {
  return a.serverUrl === b.serverUrl && (a.remoteId || "") === (b.remoteId || "") &&
    (a.token || "") === (b.token || "") && (a.transport || "direct") === (b.transport || "direct");
}

export function connectionNeedsReconnect(a: ConnectionConfig, b: ConnectionConfig): boolean {
  const transport = a.transport || "direct";
  if (transport !== (b.transport || "direct") || (a.token || "") !== (b.token || "")) return true;
  if (transport === "webrtc") return normalizeRemoteId(a.remoteId || "") !== normalizeRemoteId(b.remoteId || "");
  const endpoint = (value: string) => {
    if (transport === "homeassistant") {
      try { return new URL(value.trim()).origin; } catch { /* Compare incomplete settings as entered. */ }
    }
    return value.trim().replace(/\/$/, "");
  };
  return endpoint(a.serverUrl) !== endpoint(b.serverUrl);
}

export function shouldWaitForGateway(config: ConnectionConfig, embedded: boolean, gateway?: boolean): boolean {
  return embedded && gateway === false && !!config.transport && config.transport !== "direct";
}

type HealthVerdict = "healthy" | "suspect" | "dead" | "superseded";

// Old timeouts must not invalidate a replacement connection or a newer successful response.
export class ServerHealthGuard {
  private generation = -1;
  private failures = 0;
  private successRevision = 0;
  private flight?: { generation: number; result: Promise<HealthVerdict> };

  recordSuccess(generation: number): void {
    if (generation < this.generation) return;
    this.generation = generation;
    this.failures = 0;
    this.successRevision += 1;
  }

  verify(generation: number, probe: () => Promise<boolean>): Promise<HealthVerdict> {
    if (generation < this.generation) return Promise.resolve("superseded");
    if (this.flight?.generation === generation) return this.flight.result;
    if (generation !== this.generation) {
      this.generation = generation;
      this.failures = 0;
    }
    const revision = this.successRevision;
    const result = (async (): Promise<HealthVerdict> => {
      let healthy = false;
      try { healthy = await probe(); } catch { /* A transport failure counts as one failed probe. */ }
      if (generation !== this.generation) return "superseded";
      if (healthy || revision !== this.successRevision) {
        this.recordSuccess(generation);
        return "healthy";
      }
      return ++this.failures >= 2 ? "dead" : "suspect";
    })();
    const flight = { generation, result };
    this.flight = flight;
    void result.then(() => { if (this.flight === flight) this.flight = undefined; });
    return result;
  }
}

export function shouldRecoverGateway(state: ConnectionState, socketOpen: boolean, connecting: boolean, staleFor: number, staleMs: number): boolean {
  return !connecting && state !== "connecting" && !(state === "connected" && socketOpen && staleFor < staleMs);
}

export function recoverAfterGatewayAttempt(flight: Promise<void>, needed: () => boolean, recover: () => void): void {
  const settled = () => { if (needed()) recover(); };
  void flight.then(settled, settled);
}

export function shouldReloadBridgeApp(options: {
  now: number; lastHealthy: number; lastReload: number; gatewayConnected: boolean;
  configured: boolean; state: ConnectionState; editingSettings: boolean;
}): boolean {
  return options.configured && options.gatewayConnected && !options.editingSettings &&
    options.state !== "connected" && options.now - options.lastHealthy >= 150_000 &&
    options.now - options.lastReload >= 300_000;
}
