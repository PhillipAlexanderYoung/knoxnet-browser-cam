import type {
  ClientMessage,
  Env,
  PeerRole,
  RelayIceCandidate,
  RelaySessionDescription,
} from "./types";

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_ALLOWED_ORIGINS = ["https://cam.knoxnetvms.com"];
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://localhost:5173",
];
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const RECONNECT_TOKEN_RE = /^[A-Za-z0-9_-]{24,96}$/;

export function getRoomTtlMs(env: Env): number {
  return getRoomJoinTtlMs(env);
}

export function getRoomJoinTtlMs(env: Env): number {
  const seconds = clampNumber(Number(env.ROOM_JOIN_TTL_SECONDS ?? env.ROOM_TTL_SECONDS ?? 300), 60, 1800);
  return seconds * 1000;
}

export function getActiveRoomIdleTtlMs(env: Env): number {
  const seconds = clampNumber(Number(env.ACTIVE_ROOM_IDLE_TTL_SECONDS ?? 120), 30, 1800);
  return seconds * 1000;
}

export function getHeartbeatIntervalSeconds(env: Env): number {
  return clampNumber(Number(env.HEARTBEAT_INTERVAL_SECONDS ?? 20), 5, 120);
}

export function getPeerGraceMs(env: Env): number {
  const seconds = clampNumber(Number(env.PEER_GRACE_SECONDS ?? 45), 10, 300);
  return seconds * 1000;
}

export function getMaxMessageBytes(env: Env): number {
  return clampNumber(Number(env.MAX_MESSAGE_BYTES ?? 16_384), 1024, 64 * 1024);
}

export function getMaxFailedJoins(env: Env): number {
  return clampNumber(Number(env.MAX_FAILED_JOINS ?? 8), 1, 50);
}

export function isProduction(env: Env): boolean {
  return (env.ENVIRONMENT ?? "production").toLowerCase() === "production";
}

export function createRoomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function isValidRoomToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export function createReconnectToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function validClientId(value: string | null): string | null {
  if (!value) return null;
  return CLIENT_ID_RE.test(value) ? value : null;
}

export function validReconnectToken(value: string | null): string | null {
  if (!value) return null;
  return RECONNECT_TOKEN_RE.test(value) ? value : null;
}

export function allowedOrigins(env: Env): Set<string> {
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
  if (!isProduction(env)) {
    for (const origin of DEV_ORIGINS) origins.push(origin);
  }
  return new Set(origins);
}

export function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return !isProduction(env);
  return allowedOrigins(env).has(origin);
}

export function enforceProductionHttps(request: Request, env: Env): boolean {
  if (!isProduction(env)) return true;
  return new URL(request.url).protocol === "https:";
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function parseRole(value: string | null): PeerRole | null {
  return value === "camera" || value === "viewer" ? value : null;
}

export function parseClientMessage(raw: string, maxBytes: number): ClientMessage {
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new Error("Message too large.");
  }
  const data = JSON.parse(raw) as Record<string, unknown>;
  const type = data.type;
  if (typeof type !== "string") throw new Error("Missing message type.");

  if (type === "ping" || type === "bye" || type === "connected") {
    return { type } as ClientMessage;
  }
  if (type === "camera-hello") {
    return {
      type,
      device: parsePeerInfo(data.device),
      audio: data.audio === true,
    };
  }
  if (type === "viewer-hello") {
    return { type, device: parsePeerInfo(data.device) };
  }
  if (type === "approve-viewer") {
    if (typeof data.allow !== "boolean") throw new Error("Invalid approval.");
    return { type, allow: data.allow };
  }
  if (type === "offer" || type === "answer") {
    return { type, sdp: parseSessionDescription(data.sdp) };
  }
  if (type === "ice") {
    return { type, candidate: parseIceCandidate(data.candidate) };
  }
  throw new Error("Unknown message type.");
}

function parsePeerInfo(value: unknown) {
  const obj = asRecord(value);
  return {
    label: boundedString(obj.label, 80, "Unknown device"),
    userAgent: boundedString(obj.userAgent, 180, "Unknown browser"),
    platform: optionalBoundedString(obj.platform, 80),
    language: optionalBoundedString(obj.language, 32),
  };
}

function parseSessionDescription(value: unknown): RelaySessionDescription {
  const obj = asRecord(value);
  if (obj.type !== "offer" && obj.type !== "answer") {
    throw new Error("Invalid SDP type.");
  }
  if (typeof obj.sdp !== "string" || obj.sdp.length < 1 || obj.sdp.length > 12_000) {
    throw new Error("Invalid SDP.");
  }
  return { type: obj.type, sdp: obj.sdp };
}

function parseIceCandidate(value: unknown): RelayIceCandidate | null {
  if (value === null) return null;
  const obj = asRecord(value);
  if (typeof obj.candidate !== "string" || obj.candidate.length > 4096) {
    throw new Error("Invalid ICE candidate.");
  }
  return {
    candidate: obj.candidate,
    sdpMid: optionalBoundedString(obj.sdpMid, 64),
    sdpMLineIndex:
      typeof obj.sdpMLineIndex === "number" && Number.isInteger(obj.sdpMLineIndex)
        ? obj.sdpMLineIndex
        : undefined,
    usernameFragment: optionalBoundedString(obj.usernameFragment, 256),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, max);
}

function optionalBoundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
