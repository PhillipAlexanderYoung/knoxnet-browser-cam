export type PeerInfo = {
  label: string;
  userAgent: string;
  platform?: string;
  language?: string;
};

export type DirectMessage =
  | { type: "room-ready"; state: string; expiresAt: string }
  | { type: "viewer-request"; device: PeerInfo }
  | { type: "waiting-approval" }
  | { type: "approved" }
  | { type: "denied"; reason: string }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit | null }
  | { type: "peer-left"; reason?: string }
  | { type: "ended"; reason?: string }
  | { type: "error"; message: string }
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

export class DirectSignalingClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private heartbeat: number | null = null;

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: DirectMessage) => void,
    private readonly onClose: (reason?: string) => void,
    private readonly onError: (message: string) => void,
  ) {}

  connect(role: "camera" | "viewer"): void {
    const url = new URL(this.url);
    url.searchParams.set("role", role);
    this.closedByUs = false;
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    ws.onopen = () => {
      this.heartbeat = window.setInterval(() => this.send({ type: "ping" }), 20_000);
    };
    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data) as DirectMessage);
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
      if (!this.closedByUs) this.onClose(event.reason || undefined);
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
    if (sendBye) this.send({ type: "bye" });
    this.ws?.close();
    this.ws = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeat != null) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
