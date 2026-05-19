import type { BridgeConfig } from "./config.js";

export interface BridgeCamera {
  id: string;
  cameraId: string;
  name: string;
  path: string;
  status: "allocated" | "publishing" | "error";
  rtspUrl: string;
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
  ingestStatus: "allocated" | "publishing" | "error";
  lastError?: string;
  whipSessionUrl?: string;
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

  allocate(params: { cameraId: string; name?: string; pathHint?: string }): BridgeCamera {
    const existing = this.cameras.get(params.cameraId);
    if (existing) {
      existing.name = params.name || existing.name;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const now = new Date().toISOString();
    const path = this.uniquePath(params.pathHint || params.name || params.cameraId);
    const preview = this.previewForPath(path);
    const camera: BridgeCamera = {
      id: params.cameraId,
      cameraId: params.cameraId,
      name: params.name || `phone-cam-${params.cameraId.slice(0, 6)}`,
      path,
      status: "allocated",
      rtspUrl: `rtsp://${this.config.publicHost}:${this.config.mediaMtxRtspPort}/${path}`,
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
    };
    this.cameras.set(params.cameraId, camera);
    return camera;
  }

  remove(cameraId: string): boolean {
    return this.cameras.delete(cameraId);
  }

  markPublishing(
    cameraId: string,
    params: { whipSessionUrl?: string },
  ): BridgeCamera | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    camera.ingestStatus = "publishing";
    camera.status = "publishing";
    camera.lastError = undefined;
    camera.whipSessionUrl = params.whipSessionUrl;
    const now = new Date().toISOString();
    camera.updatedAt = now;
    camera.lastSeen = now;
    return camera;
  }

  markError(cameraId: string, error: string): BridgeCamera | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    camera.ingestStatus = "error";
    camera.status = "error";
    camera.lastError = error;
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
