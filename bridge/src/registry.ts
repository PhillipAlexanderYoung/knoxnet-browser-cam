import { rtspUrlForPath, type BridgeConfig } from "./config.js";

export interface BridgeCamera {
  id: string;
  cameraId: string;
  sessionId?: string;
  deviceId?: string;
  name: string;
  path: string;
  status: "allocated" | "publishing" | "recovering" | "offline" | "error";
  rtspUrl: string;
  rtspUrlRedacted?: string;
  whipUrl: string;
  previewAvailable: boolean;
  previewUrls: {
    webRtc?: string;
    hls?: string;
  };
  preview: {
    available: boolean;
    type: "webrtc" | "hls" | "none";
    webRtcUrl?: string;
    hlsUrl?: string;
    message?: string;
  };
  createdAt: string;
  updatedAt: string;
  lastSeen?: string;
  ingestStatus: "allocated" | "publishing" | "recovering" | "offline" | "error";
  lastError?: string;
  diagnostics?: unknown;
  quality?: CameraQualityInfo;
  whipSessionUrl?: string;
  offlineSince?: string;
  deleteAfter?: string;
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

export class CameraRegistry {
  private readonly cameras = new Map<string, BridgeCamera>();

  constructor(private readonly config: BridgeConfig) {}

  list(): BridgeCamera[] {
    return Array.from(this.cameras.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  get(cameraId: string): BridgeCamera | undefined {
    return this.cameras.get(cameraId);
  }

  allocate(params: {
    cameraId: string;
    sessionId?: string;
    deviceId?: string;
    name?: string;
    pathHint?: string;
    quality?: CameraQualityInfo;
  }): BridgeCamera {
    const existing = this.cameras.get(params.cameraId);
    if (existing) {
      existing.name = params.name || existing.name;
      existing.sessionId = params.sessionId ?? existing.sessionId;
      existing.deviceId = params.deviceId ?? existing.deviceId;
      existing.quality = params.quality ?? existing.quality;
      existing.updatedAt = new Date().toISOString();
      if (existing.ingestStatus !== "allocated") {
        existing.ingestStatus = "recovering";
        existing.status = "recovering";
        existing.lastError = "Publisher reconnecting; stable RTSP path preserved.";
        existing.diagnostics = undefined;
      }
      delete existing.deleteAfter;
      return existing;
    }

    const now = new Date().toISOString();
    const path = this.uniquePath(params.pathHint || params.name || params.cameraId);
    const preview = this.previewForPath(path);
    const camera: BridgeCamera = {
      id: params.cameraId,
      cameraId: params.cameraId,
      sessionId: params.sessionId,
      deviceId: params.deviceId,
      name: params.name || `phone-cam-${params.cameraId.slice(0, 6)}`,
      path,
      status: "allocated",
      rtspUrl: rtspUrlForPath(this.config, path),
      rtspUrlRedacted: rtspUrlForPath(this.config, path, { credentials: "redacted" }),
      whipUrl: `http://${this.config.mediaMtxInternalHost}:${this.config.mediaMtxWebRtcPort}/${path}/whip`,
      previewAvailable: preview.available,
      previewUrls: {
        webRtc: preview.webRtcUrl,
        hls: preview.hlsUrl,
      },
      preview,
      createdAt: now,
      updatedAt: now,
      ingestStatus: "allocated",
      quality: params.quality,
    };
    this.cameras.set(params.cameraId, camera);
    return camera;
  }

  remove(cameraId: string, opts: { permanent?: boolean } = {}): boolean {
    if (opts.permanent) {
      return this.cameras.delete(cameraId);
    }
    const camera = this.markOffline(cameraId, "RTSP path retained for reconnect grace period.");
    return Boolean(camera);
  }

  markOffline(cameraId: string, reason: string): BridgeCamera | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    const now = new Date();
    camera.ingestStatus = "offline";
    camera.status = "offline";
    camera.lastError = reason;
    camera.offlineSince = now.toISOString();
    camera.deleteAfter = new Date(now.getTime() + this.config.rtspPathGraceMs).toISOString();
    camera.updatedAt = camera.offlineSince;
    camera.whipSessionUrl = undefined;
    return camera;
  }

  cleanupExpired(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const camera of this.cameras.values()) {
      if (!camera.deleteAfter) continue;
      const deleteAt = Date.parse(camera.deleteAfter);
      if (Number.isFinite(deleteAt) && deleteAt <= now) {
        this.cameras.delete(camera.cameraId);
        removed.push(camera.cameraId);
      }
    }
    return removed;
  }

  removePermanent(cameraId: string): boolean {
    return this.cameras.delete(cameraId);
  }

  markPublishing(
    cameraId: string,
    params: { whipSessionUrl?: string; quality?: CameraQualityInfo },
  ): BridgeCamera | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    camera.ingestStatus = "publishing";
    camera.status = "publishing";
    camera.lastError = undefined;
    camera.diagnostics = undefined;
    camera.whipSessionUrl = params.whipSessionUrl;
    camera.quality = params.quality ?? camera.quality;
    delete camera.offlineSince;
    delete camera.deleteAfter;
    const now = new Date().toISOString();
    camera.updatedAt = now;
    camera.lastSeen = now;
    return camera;
  }

  markError(cameraId: string, error: string, diagnostics?: unknown): BridgeCamera | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    camera.ingestStatus = "error";
    camera.status = "error";
    camera.lastError = error;
    camera.diagnostics = diagnostics;
    camera.updatedAt = new Date().toISOString();
    return camera;
  }

  private previewForPath(path: string): BridgeCamera["preview"] {
    if (this.config.mediaMtxWebRtcPort > 0 && this.config.publicHost) {
      const webRtcUrl = `http://${this.config.publicHost}:${this.config.mediaMtxWebRtcPort}/${path}`;
      return {
        available: true,
        type: "webrtc",
        webRtcUrl,
      };
    }

    return {
      available: false,
      type: "none",
      message: "Preview unavailable until MediaMTX WebRTC or HLS egress is enabled.",
    };
  }

  private uniquePath(input: string): string {
    const base = slugify(input) || "phone-cam";
    let candidate = base;
    let suffix = 2;
    const paths = new Set(Array.from(this.cameras.values()).map((cam) => cam.path));
    while (paths.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
