import type { CameraRecord } from "./pairing.js";

export interface BridgeAllocation {
  cameraId: string;
  name: string;
  path: string;
  rtspUrl: string;
  rtspUrlRedacted?: string;
  whipUrl?: string;
  ingestStatus?: "allocated" | "publishing" | "recovering" | "offline" | "error";
  lastError?: string;
  quality?: CameraRecord["quality"];
}

export interface BridgePublishResult {
  answer?: { type: "answer"; sdp: string };
  camera?: BridgeAllocation;
  error?: string;
  diagnostics?: unknown;
}

export interface BridgeClient {
  allocateCamera: (camera: CameraRecord) => Promise<BridgeAllocation | null>;
  publishOffer: (
    camera: CameraRecord,
    offerSdp: string,
  ) => Promise<BridgePublishResult>;
  markCameraOffline: (camera: CameraRecord, reason?: string) => Promise<void>;
  removeCamera: (camera: CameraRecord | string, permanent?: boolean) => Promise<void>;
  listCameras: () => Promise<BridgeAllocation[]>;
  health: () => Promise<{ ok: boolean; mediamtx?: unknown; rtspAuth?: unknown; error?: string }>;
  logs: () => Promise<unknown>;
  rtspAuth: () => Promise<unknown>;
  rotateRtspAuth: () => Promise<unknown>;
  rtspUrl: (cameraId: string, includeCredentials?: boolean) => Promise<unknown>;
}

export function createBridgeClient(
  bridgeUrl: string | undefined,
  log: (...args: unknown[]) => void,
): BridgeClient | null {
  const baseUrl = bridgeUrl?.replace(/\/+$/, "");
  if (!baseUrl) return null;

  function bridgeCameraId(camera: CameraRecord): string {
    return camera.deviceId ? `device-${camera.deviceId}` : `session-${camera.sessionId}`;
  }

  async function requestJson<T>(
    path: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: T | null; error?: string }> {
    try {
      const res = await fetch(`${baseUrl}${path}`, init);
      const text = await res.text();
      const body = text
        ? (JSON.parse(text) as T & { error?: string; detail?: string })
        : null;
      if (!res.ok) {
        const error =
          [body?.error, body?.detail].filter(Boolean).join(": ") ||
          `bridge-http-${res.status}`;
        log("bridge request failed", path, res.status, error);
        return { ok: false, status: res.status, body, error };
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      const error = (err as Error)?.message ?? String(err);
      log("bridge request error", path, error);
      return { ok: false, status: 0, body: null, error };
    }
  }

  return {
    async allocateCamera(camera) {
      const stableCameraId = bridgeCameraId(camera);
      const result = await requestJson<{ ok: boolean; camera: BridgeAllocation }>(
        "/api/cameras",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cameraId: stableCameraId,
            sessionId: camera.sessionId,
            deviceId: camera.deviceId,
            name: camera.name,
            pathHint: camera.name || camera.deviceId || camera.sessionId,
            quality: camera.quality,
          }),
        },
      );
      return result.ok ? (result.body?.camera ?? null) : null;
    },

    async publishOffer(camera, offerSdp) {
      const cameraId = camera.bridge?.cameraId ?? bridgeCameraId(camera);
      const result = await requestJson<{
        ok: boolean;
        sdp: { type: "answer"; sdp: string };
        camera?: BridgeAllocation;
      }>(`/api/cameras/${encodeURIComponent(cameraId)}/whip`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sdp: offerSdp, quality: camera.quality }),
      });
      if (result.body?.camera) {
        camera.bridge = result.body.camera;
      }
      return {
        answer: result.ok ? result.body?.sdp : undefined,
        camera: result.body?.camera,
        error: result.ok ? undefined : result.error,
        diagnostics: (result.body as { diagnostics?: unknown } | null)?.diagnostics,
      };
    },

    async markCameraOffline(camera, reason = "receiver-disconnect") {
      const cameraId = camera.bridge?.cameraId ?? bridgeCameraId(camera);
      await requestJson<{ ok: boolean }>(
        `/api/cameras/${encodeURIComponent(cameraId)}/offline`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
    },

    async removeCamera(cameraOrId, permanent = false) {
      const cameraId =
        typeof cameraOrId === "string"
          ? cameraOrId
          : cameraOrId.bridge?.cameraId ?? bridgeCameraId(cameraOrId);
      const suffix = permanent ? "?permanent=1" : "";
      await requestJson<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(cameraId)}${suffix}`, {
        method: "DELETE",
      });
    },

    async listCameras() {
      const result = await requestJson<{ cameras: BridgeAllocation[] }>(
        "/api/cameras",
        { method: "GET" },
      );
      return result.ok ? (result.body?.cameras ?? []) : [];
    },

    async health() {
      const result = await requestJson<{ ok: boolean; mediamtx?: unknown; rtspAuth?: unknown }>(
        "/api/health",
        { method: "GET" },
      );
      return {
        ok: result.ok && Boolean(result.body?.ok),
        mediamtx: result.body?.mediamtx,
        rtspAuth: result.body?.rtspAuth,
        error: result.error,
      };
    },

    async logs() {
      const result = await requestJson<unknown>("/api/logs", { method: "GET" });
      return result.body ?? { ok: false, error: result.error };
    },

    async rtspAuth() {
      const result = await requestJson<unknown>("/api/rtsp-auth", { method: "GET" });
      return result.body ?? { ok: false, error: result.error };
    },

    async rotateRtspAuth() {
      const result = await requestJson<unknown>("/api/rtsp-auth/rotate", { method: "POST" });
      return result.body ?? { ok: false, error: result.error };
    },

    async rtspUrl(cameraId, includeCredentials = false) {
      const suffix = includeCredentials ? "?credentials=1" : "";
      const result = await requestJson<unknown>(
        `/api/cameras/${encodeURIComponent(cameraId)}/rtsp-url${suffix}`,
        { method: "GET" },
      );
      return result.body ?? { ok: false, error: result.error };
    },
  };
}
