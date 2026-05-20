export interface Env {
  ROOMS: DurableObjectNamespace;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  ROOM_TTL_SECONDS?: string;
  ROOM_JOIN_TTL_SECONDS?: string;
  ACTIVE_ROOM_IDLE_TTL_SECONDS?: string;
  HEARTBEAT_INTERVAL_SECONDS?: string;
  PEER_GRACE_SECONDS?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_FAILED_JOINS?: string;
  APP_ORIGIN?: string;
}

export interface RoomDurableObject {
  fetch(request: Request): Promise<Response>;
}

export type PeerRole = "camera" | "viewer";

export type RoomState =
  | "created"
  | "camera_connected"
  | "viewer_waiting"
  | "viewer_approved"
  | "negotiating"
  | "connected"
  | "camera_reconnecting"
  | "viewer_reconnecting"
  | "ended"
  | "expired";

export interface RoomCreateRequest {
  expiresAt: number;
}

export interface RoomCreateResponse {
  roomToken: string;
  joinUrl: string;
  wsUrl: string;
  expiresAt: string;
}

export interface PeerInfo {
  label: string;
  userAgent: string;
  platform?: string;
  language?: string;
}

export interface RelaySessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface RelayIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}

export type ClientMessage =
  | { type: "camera-hello"; device: PeerInfo; audio: boolean }
  | { type: "viewer-hello"; device: PeerInfo }
  | { type: "approve-viewer"; allow: boolean }
  | { type: "offer"; sdp: RelaySessionDescription }
  | { type: "answer"; sdp: RelaySessionDescription }
  | { type: "ice"; candidate: RelayIceCandidate | null }
  | { type: "connected" }
  | { type: "bye" }
  | { type: "ping" };

export type ServerMessage =
  | { type: "room-ready"; state: RoomState; expiresAt: string; heartbeatSeconds?: number }
  | { type: "session"; clientId: string; reconnectToken: string }
  | { type: "viewer-request"; device: PeerInfo }
  | { type: "waiting-approval" }
  | { type: "approved" }
  | { type: "peer-reconnecting"; role: PeerRole; graceSeconds: number }
  | { type: "peer-reconnected"; role: PeerRole }
  | { type: "denied"; reason: string }
  | { type: "offer"; sdp: RelaySessionDescription }
  | { type: "answer"; sdp: RelaySessionDescription }
  | { type: "ice"; candidate: RelayIceCandidate | null }
  | { type: "peer-left"; reason?: string }
  | { type: "ended"; reason?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "pong" };
