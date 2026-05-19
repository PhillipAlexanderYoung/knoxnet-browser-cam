export type ConnectionState =
  | "idle"
  | "connecting"
  | "searching"
  | "paired"
  | "negotiating"
  | "streaming"
  | "error"
  | "disconnected";

export type CameraCapabilities = {
  resolutions?: string[];
  frameRates?: number[];
  torch?: boolean;
  audio?: boolean;
  facingModes?: string[];
};

export type IncomingMessage =
  | { type: "hello-ack"; paired: boolean; sessionId?: string; reason?: string }
  | { type: "accepted"; sessionId: string; bridge?: BridgeAllocation }
  | { type: "rejected"; sessionId: string; reason?: string }
  | { type: "answer"; sessionId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; sessionId: string; candidate: RTCIceCandidateInit | null }
  | { type: "bye"; sessionId: string }
  | { type: "error"; message: string }
  | { type: "pong" };

export interface BridgeAllocation {
  cameraId: string;
  name: string;
  path: string;
  rtspUrl: string;
  whipUrl?: string;
  ingestStatus?: "allocated" | "publishing" | "error";
  lastError?: string;
}

export type OutgoingMessage =
  | {
      type: "hello";
      role: "camera";
      name: string;
      deviceId: string;
      pairingCode: string;
      capabilities: CameraCapabilities;
    }
  | {
      type: "announce";
      name: string;
      deviceId: string;
      pairingCode: string;
      discoverable: boolean;
    }
  | { type: "offer"; sessionId: string; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; sessionId: string; candidate: RTCIceCandidateInit | null }
  | { type: "bye"; sessionId: string }
  | { type: "ping" };

export interface SignalingStateDetail {
  url: string;
  eventType?: string;
  message?: string;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  closedByClient?: boolean;
}

export interface SignalingClientOptions {
  url: string;
  onMessage: (msg: IncomingMessage) => void;
  onStateChange: (
    state: "connecting" | "open" | "closed" | "error",
    detail?: SignalingStateDetail,
  ) => void;
  onLog?: (...args: unknown[]) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly onMessage: SignalingClientOptions["onMessage"];
  private readonly onStateChange: SignalingClientOptions["onStateChange"];
  private readonly onLog: NonNullable<SignalingClientOptions["onLog"]>;
  private closedByUs = false;

  constructor(opts: SignalingClientOptions) {
    this.url = opts.url;
    this.onMessage = opts.onMessage;
    this.onStateChange = opts.onStateChange;
    this.onLog = opts.onLog ?? (() => {});
  }

  connect(): void {
    this.closedByUs = false;
    this.onStateChange("connecting", { url: this.url });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.onLog("ws ctor failed", err);
      this.onStateChange("error", {
        url: this.url,
        message: (err as Error)?.message ?? "WebSocket constructor failed",
      });
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.onStateChange("open", { url: this.url });
    ws.onerror = (ev) => {
      this.onLog("ws error", ev);
      this.onStateChange("error", {
        url: this.url,
        eventType: ev.type,
        message:
          "message" in ev && typeof ev.message === "string"
            ? ev.message
            : undefined,
      });
    };
    ws.onclose = (ev) => {
      this.onStateChange("closed", {
        url: this.url,
        eventType: ev.type,
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
        closedByClient: this.closedByUs,
      });
      this.ws = null;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as IncomingMessage;
        this.onMessage(msg);
      } catch (err) {
        this.onLog("invalid message", err);
      }
    };
  }

  send(msg: OutgoingMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.onLog("send failed", err);
      return false;
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
