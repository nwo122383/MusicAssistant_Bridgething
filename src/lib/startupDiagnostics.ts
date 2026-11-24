export type StartupPhase = "app_started" | "gateway_connected" | "gateway_disconnected" |
  "connection_started" | "server_connected" | "phone_snapshot_ready" | "home_players_ready" |
  "home_warmup_failed" | "screen_ready" | "connection_failed" | "refresh_failed" |
  "server_probe_ok" | "server_probe_failed" | "socket_closed" | "reconnect_requested" |
  "waiting_for_gateway" | "settings_changed";

export type StartupTiming = { phase: StartupPhase; elapsedMs: number; attempt: number };
export const STARTUP_TIMINGS_KEY = "carthing-ma-startup-v1";

export class StartupTrace {
  private readonly startedAt: number;
  private attempt = 0;
  private events: StartupTiming[] = [];

  constructor(private readonly now: () => number = Date.now, private readonly write: (events: StartupTiming[]) => void = events => {
    try { window.sessionStorage.setItem(STARTUP_TIMINGS_KEY, JSON.stringify(events)); } catch { /* Diagnostics must never block playback. */ }
  }) {
    this.startedAt = now();
    this.mark("app_started");
  }

  startAttempt(): number {
    this.attempt += 1;
    this.mark("connection_started");
    return this.attempt;
  }

  mark(phase: StartupPhase, attempt = this.attempt): void {
    this.events.push({ phase, elapsedMs: Math.max(0, this.now() - this.startedAt), attempt });
    this.events = this.events.slice(-48);
    try { this.write(this.events.map(event => ({ ...event }))); } catch { /* Storage can be unavailable. */ }
  }
}
