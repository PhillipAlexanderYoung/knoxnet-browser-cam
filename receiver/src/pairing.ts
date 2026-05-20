import { customAlphabet } from "nanoid";

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateCode = customAlphabet(codeAlphabet, 6);
const generateSessionId = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  10,
);

export type CameraStatus =
  | "pending"
  | "accepted"
  | "negotiating"
  | "streaming"
  | "disconnected";

export interface CameraCapabilities {
  resolutions?: string[];
  frameRates?: number[];
  torch?: boolean;
  audio?: boolean;
  facingModes?: string[];
  quality?: CameraQualityInfo;
}

export interface CameraQualityInfo {
  mode: string;
  requestedResolution?: string;
  currentResolution?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrateKbps?: number;
  message?: string | null;
}

export interface CameraRecord {
  sessionId: string;
  deviceId?: string;
  name: string;
  status: CameraStatus;
  capabilities: CameraCapabilities;
  quality?: CameraQualityInfo;
  bridge?: {
    cameraId: string;
    name: string;
    path: string;
    rtspUrl: string;
    rtspUrlRedacted?: string;
    whipUrl?: string;
    ingestStatus?: "allocated" | "publishing" | "recovering" | "offline" | "error";
    lastError?: string;
    quality?: CameraQualityInfo;
  };
  createdAt: string;
  lastSeen: string;
  disconnectedAt?: string;
  disconnectReason?: string;
  trusted?: boolean;
  autoAccepted?: boolean;
  reconnectCount?: number;
  remoteAddress?: string;
}

export interface PairingState {
  code: string;
  cameras: Map<string, CameraRecord>;
}

export function createPairingState(envCode?: string): PairingState {
  const code = (envCode && envCode.trim().length > 0
    ? envCode.trim().toUpperCase()
    : generateCode()
  ).slice(0, 12);
  return {
    code,
    cameras: new Map(),
  };
}

export function newSessionId(): string {
  return generateSessionId();
}

export function redactCode(code: string): string {
  if (code.length <= 2) return "**";
  return `${code[0]}${"*".repeat(code.length - 2)}${code[code.length - 1]}`;
}

export function validatePairingCode(state: PairingState, given: string): boolean {
  if (!given) return false;
  return given.trim().toUpperCase() === state.code;
}

export function registerCamera(
  state: PairingState,
  params: {
    name: string;
    deviceId?: string;
    capabilities: CameraCapabilities;
    remoteAddress?: string;
    replaceSessionId?: string;
  },
): CameraRecord {
  const sessionId = newSessionId();
  const now = new Date().toISOString();
  const previous =
    params.replaceSessionId ? state.cameras.get(params.replaceSessionId) : undefined;
  if (previous) state.cameras.delete(previous.sessionId);
  const record: CameraRecord = {
    sessionId,
    deviceId: params.deviceId,
    name: params.name || previous?.name || `phone-cam-${sessionId.slice(0, 4)}`,
    status: "pending",
    capabilities: params.capabilities ?? {},
    quality: params.capabilities?.quality,
    createdAt: previous?.createdAt ?? now,
    lastSeen: now,
    reconnectCount: previous ? (previous.reconnectCount ?? 0) + 1 : 0,
    remoteAddress: params.remoteAddress,
  };
  if (previous?.bridge) {
    record.bridge = previous.bridge;
    record.bridge.ingestStatus = "recovering";
    record.bridge.lastError = "Known device reconnected; waiting for republish.";
  }
  state.cameras.set(sessionId, record);
  return record;
}

export function touchCamera(state: PairingState, sessionId: string): void {
  const cam = state.cameras.get(sessionId);
  if (!cam) return;
  cam.lastSeen = new Date().toISOString();
}

export function setCameraStatus(
  state: PairingState,
  sessionId: string,
  status: CameraStatus,
  reason?: string,
): CameraRecord | undefined {
  const cam = state.cameras.get(sessionId);
  if (!cam) return undefined;
  cam.status = status;
  cam.lastSeen = new Date().toISOString();
  if (status === "disconnected") {
    cam.disconnectedAt = cam.lastSeen;
    cam.disconnectReason = reason;
  } else {
    delete cam.disconnectedAt;
    delete cam.disconnectReason;
  }
  return cam;
}

export function removeCamera(
  state: PairingState,
  sessionId: string,
): boolean {
  return state.cameras.delete(sessionId);
}

export function listCameras(state: PairingState): CameraRecord[] {
  return Array.from(state.cameras.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}
