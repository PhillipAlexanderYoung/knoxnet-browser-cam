export type PeerInfo = {
  label: string;
  userAgent: string;
  platform?: string;
  language?: string;
};

export type DirectMessage =
  | { type: "room-ready"; state: string; expiresAt: string; heartbeatSeconds?: number }
  | { type: "session"; clientId: string; reconnectToken: string }
  | { type: "viewer-request"; device: PeerInfo }
  | { type: "waiting-approval" }
  | { type: "approved" }
  | { type: "peer-reconnecting"; role: "camera" | "viewer"; graceSeconds: number }
  | { type: "peer-reconnected"; role: "camera" | "viewer" }
  | { type: "denied"; reason: string }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit | null }
  | { type: "peer-left"; reason?: string }
  | { type: "ended"; reason?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "pong" };

export type DirectOutgoing =
  | { type: "camera-hello"; device: PeerInfo; audio: boolean }
  | { type: "viewer-hello"; device: PeerInfo }
  | { type: "approve-viewer"; allow: boolean }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit | null }
  | { type: "connected" }
  | { type: "bye" }
  | { type: "ping" };

export interface DirectRoom {
  roomToken: string;
  joinUrl: string;
  wsUrl: string;
  expiresAt: string;
}

export interface DirectSessionIdentity {
  clientId: string;
  reconnectToken?: string | null;
  onReconnectToken?: (token: string) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
}

export function directApiBase(): string {
  const configured = import.meta.env.VITE_DIRECT_SIGNAL_BASE as string | undefined;
  return configured?.replace(/\/+$/, "") || window.location.origin;
}

export async function createDirectRoom(): Promise<DirectRoom> {
  const response = await fetch(`${directApiBase()}/api/direct/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Could not create room (${response.status})`);
  }
  return (await response.json()) as DirectRoom;
}

export function wsUrlForToken(token: string): string {
  const base = directApiBase();
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/direct/ws/${encodeURIComponent(token)}`;
  url.search = "";
  return url.toString();
}

export function describeThisDevice(): PeerInfo {
  const ua = navigator.userAgent || "Unknown browser";
  const platform = navigator.platform || undefined;
  const vendor = navigator.vendor || "";
  const browser =
    /CriOS|Chrome/i.test(ua) || /Google/i.test(vendor)
      ? "Chrome"
      : /Safari/i.test(ua)
        ? "Safari"
        : /Firefox/i.test(ua)
          ? "Firefox"
          : /Edg/i.test(ua)
            ? "Edge"
            : "Browser";
  const phone =
    /iPhone/i.test(ua) ? "iPhone" : /Android/i.test(ua) ? "Android phone" : "Device";
  return {
    label: `${phone} ${browser}`,
    userAgent: ua,
    platform,
    language: navigator.language,
  };
}

export function getOrCreateDirectClientId(): string {
  const key = "knoxnet-direct-client-id";
  const existing = localStorage.getItem(key);
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  const next = randomBase64Url(18);
  localStorage.setItem(key, next);
  return next;
}

export function directReconnectTokenKey(role: "camera" | "viewer", roomToken: string): string {
  return `knoxnet-direct-reconnect:${role}:${roomToken}`;
}

function randomBase64Url(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class DirectSignalingClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private role: "camera" | "viewer" | null = null;
  private identity: DirectSessionIdentity | null = null;
  private attempts = 0;
  private heartbeatSeconds = 20;

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: DirectMessage) => void,
    private readonly onClose: (reason?: string) => void,
    private readonly onError: (message: string) => void,
  ) {}

  connect(role: "camera" | "viewer", identity: DirectSessionIdentity): void {
    this.role = role;
    this.identity = identity;
    this.open();
  }

  private open(): void {
    if (!this.role || !this.identity) return;
    const url = new URL(this.url);
    url.searchParams.set("role", this.role);
    url.searchParams.set("clientId", this.identity.clientId);
    if (this.identity.reconnectToken) {
      url.searchParams.set("reconnectToken", this.identity.reconnectToken);
    }
    this.closedByUs = false;
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.identity?.onReconnected?.();
      this.heartbeat = window.setInterval(() => this.send({ type: "ping" }), this.heartbeatSeconds * 1000);
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as DirectMessage;
        if (message.type === "room-ready" && message.heartbeatSeconds) {
          this.heartbeatSeconds = message.heartbeatSeconds;
        }
        if (message.type === "session") {
          this.identity = {
            ...this.identity!,
            reconnectToken: message.reconnectToken,
          };
          this.identity.onReconnectToken?.(message.reconnectToken);
        }
        this.onMessage(message);
      } catch {
        this.onError("Received malformed signaling message.");
      }
    };
    ws.onerror = () => {
      this.onError("Direct View signaling connection failed.");
    };
    ws.onclose = (event) => {
      this.clearHeartbeat();
      this.ws = null;
      if (!this.closedByUs) this.scheduleReconnect(event.reason || undefined);
    };
  }

  send(message: DirectOutgoing): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close(sendBye = true): void {
    this.closedByUs = true;
    this.clearHeartbeat();
    this.clearReconnect();
    if (sendBye) this.send({ type: "bye" });
    this.ws?.close();
    this.ws = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeat != null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(reason?: string): void {
    if (this.attempts >= 5) {
      this.onClose(reason);
      return;
    }
    this.identity?.onReconnecting?.();
    const delay = Math.min(1000 * 2 ** this.attempts, 8000);
    this.attempts += 1;
    this.clearReconnect();
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
