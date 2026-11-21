/**
 * Signaling Client
 *
 * Handles WebRTC signaling for establishing peer connections.
 * Connects to a signaling server to exchange SDP offers/answers and ICE candidates.
 */

export enum SignalingState {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  ERROR = "error",
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SignalingMessage {
  type:
    | "offer"
    | "answer"
    | "ice-candidate"
    | "error"
    | "connected"
    | "peer-disconnected";
  remoteId?: string;
  sessionId?: string;
  data?: RTCSessionDescriptionInit | RTCIceCandidateInit;
  error?: string;
  iceServers?: IceServerConfig[];
}

export interface SignalingConfig {
  serverUrl: string;
  reconnect?: boolean;
  reconnectDelay?: number;
}

type SignalingEventHandler = {
  offer: (offer: RTCSessionDescriptionInit, sessionId: string) => void;
  answer: (answer: RTCSessionDescriptionInit) => void;
  "ice-candidate": (candidate: RTCIceCandidateInit) => void;
  connected: (remoteId: string, iceServers?: IceServerConfig[]) => void;
  "peer-disconnected": () => void;
  error: (error: string) => void;
  stateChange: (state: SignalingState) => void;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private config: Required<SignalingConfig>;
  private _state: SignalingState = SignalingState.DISCONNECTED;
  private eventHandlers: Map<
    keyof SignalingEventHandler,
    Set<(...args: unknown[]) => void>
  > = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private currentRemoteId: string | null = null;
  private currentSessionId: string | null = null;
  private cancelConnect?: (error: Error) => void;
  private cancelRequest?: (error: Error) => void;

  constructor(config: SignalingConfig) {
    this.config = {
      serverUrl: config.serverUrl,
      reconnect: config.reconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? 3000,
    };
  }

  get state(): SignalingState {
    return this._state;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Connect to the signaling server
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    this.intentionalClose = false;
    this.setState(SignalingState.CONNECTING);

    return new Promise((resolve, reject) => {
      this.cancelConnect = reject;
      try {
        this.ws = new WebSocket(this.config.serverUrl);

        this.ws.onopen = () => {
          this.cancelConnect = undefined;
          this.setState(SignalingState.CONNECTED);
          resolve();
        };

        this.ws.onclose = () => {
          this.cancelConnect?.(new Error("Signaling connection closed"));
          this.cancelConnect = undefined;
          this.cancelRequest?.(new Error("Signaling connection closed"));
          this.setState(SignalingState.DISCONNECTED);
          if (!this.intentionalClose) this.emit("peer-disconnected");

          if (!this.intentionalClose && this.config.reconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = () => {
          this.setState(SignalingState.ERROR);
          reject(new Error("Signaling connection failed"));
        };

        this.ws.onmessage = (event) => {
          try {
            const message: SignalingMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error("[Signaling] Failed to parse message:", error);
          }
        };
      } catch (error) {
        this.setState(SignalingState.ERROR);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the signaling server
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.cancelConnect?.(new Error("Connection cancelled"));
    this.cancelConnect = undefined;
    this.cancelRequest?.(new Error("Connection cancelled"));
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.currentRemoteId = null;
    this.currentSessionId = null;
    this.setState(SignalingState.DISCONNECTED);
  }

  /**
   * Request connection to a remote Music Assistant instance
   * Returns the remote ID and ICE servers provided by the server
   */
  async requestConnection(
    remoteId: string,
  ): Promise<{ remoteId: string; iceServers?: IceServerConfig[] }> {
    if (this._state !== SignalingState.CONNECTED) {
      await this.connect();
    }

    this.currentRemoteId = remoteId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        handleError("Connection request timeout");
      }, 30000);

      const handleConnected = (id: string, iceServers?: IceServerConfig[]) => {
        clearTimeout(timeout);
        this.off("connected", handleConnected);
        this.off("error", handleError);
        this.cancelRequest = undefined;
        resolve({ remoteId: id, iceServers });
      };

      const handleError = (error: string) => {
        clearTimeout(timeout);
        this.off("connected", handleConnected);
        this.off("error", handleError);
        this.cancelRequest = undefined;
        reject(new Error(error));
      };

      this.on("connected", handleConnected);
      this.on("error", handleError);
      this.cancelRequest = error => handleError(error.message);

      this.send({
        type: "connect-request",
        remoteId: remoteId,
      });
    });
  }

  /**
   * Send an SDP offer to the remote peer
   */
  sendOffer(offer: RTCSessionDescriptionInit): void {
    this.send({
      type: "offer",
      remoteId: this.currentRemoteId,
      sessionId: this.currentSessionId,
      data: offer,
    });
  }

  /**
   * Send an SDP answer to the remote peer
   */
  sendAnswer(answer: RTCSessionDescriptionInit): void {
    this.send({
      type: "answer",
      remoteId: this.currentRemoteId,
      sessionId: this.currentSessionId,
      data: answer,
    });
  }

  /**
   * Send an ICE candidate to the remote peer
   */
  sendIceCandidate(candidate: RTCIceCandidateInit): void {
    this.send({
      type: "ice-candidate",
      remoteId: this.currentRemoteId,
      sessionId: this.currentSessionId,
      data: candidate,
    });
  }

  on<K extends keyof SignalingEventHandler>(
    event: K,
    handler: SignalingEventHandler[K],
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<K extends keyof SignalingEventHandler>(
    event: K,
    handler: SignalingEventHandler[K],
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler as (...args: unknown[]) => void);
    }
  }

  private emit<K extends keyof SignalingEventHandler>(
    event: K,
    ...args: Parameters<SignalingEventHandler[K]>
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(...args);
        } catch (error) {
          console.error(
            `[Signaling] Error in event handler for '${event}':`,
            error,
          );
        }
      });
    }
  }

  private handleMessage(message: SignalingMessage): void {
    switch (message.type) {
      case "connected":
        this.currentSessionId = message.sessionId || null;
        this.emit("connected", message.remoteId || "", message.iceServers);
        break;

      case "offer":
        this.emit(
          "offer",
          message.data as RTCSessionDescriptionInit,
          message.sessionId || "",
        );
        break;

      case "answer":
        this.emit("answer", message.data as RTCSessionDescriptionInit);
        break;

      case "ice-candidate":
        this.emit("ice-candidate", message.data as RTCIceCandidateInit);
        break;

      case "peer-disconnected":
        this.emit("peer-disconnected");
        break;

      case "error":
        this.emit("error", message.error || "Unknown error");
        break;
    }
  }

  private send(message: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error("[Signaling] Cannot send message - not connected");
    }
  }

  private setState(newState: SignalingState): void {
    if (this._state !== newState) {
      this._state = newState;
      this.emit("stateChange", newState);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error("[Signaling] Reconnect failed:", error);
      });
    }, this.config.reconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
