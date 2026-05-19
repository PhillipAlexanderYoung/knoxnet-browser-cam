import type { BridgeConfig } from "./config.js";

export interface BridgeCamera {
  cameraId: string;
  name: string;
  path: string;
  rtspUrl: string;
  whipUrl: string;
  createdAt: string;
  updatedAt: string;
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
    const camera: BridgeCamera = {
      cameraId: params.cameraId,
      name: params.name || `phone-cam-${params.cameraId.slice(0, 6)}`,
      path,
      rtspUrl: `rtsp://${this.config.publicHost}:${this.config.mediaMtxRtspPort}/${path}`,
      whipUrl: `http://${this.config.mediaMtxInternalHost}:${this.config.mediaMtxWebRtcPort}/${path}/whip`,
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
    camera.lastError = undefined;
    camera.whipSessionUrl = params.whipSessionUrl;
    camera.updatedAt = new Date().toISOString();
    return camera;
  }

  markError(cameraId: string, error: string): BridgeCamera | undefined {
    const camera = this.cameras.get(cameraId);
    if (!camera) return undefined;
    camera.ingestStatus = "error";
    camera.lastError = error;
    camera.updatedAt = new Date().toISOString();
    return camera;
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
