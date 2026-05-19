import type { CameraRecord } from "./pairing.js";

export interface BridgeAllocation {
  cameraId: string;
  name: string;
  path: string;
  rtspUrl: string;
  whipUrl?: string;
  ingestStatus?: "allocated" | "publishing" | "recovering" | "offline" | "error";
  lastError?: string;
  quality?: CameraRecord["quality"];
}

export interface BridgePublishResult {
  answer?: { type: "answer"; sdp: string };
  camera?: BridgeAllocation;
  error?: string;
}

export interface BridgeClient {
  allocateCamera: (camera: CameraRecord) => Promise<BridgeAllocation | null>;
  publishOffer: (
    camera: CameraRecord,
    offerSdp: string,
  ) => Promise<BridgePublishResult>;
  markCameraOffline: (camera: CameraRecord, reason?: string) => Promise<void>;
  removeCamera: (camera: CameraRecord | string, permanent?: boolean) => Promise<void>;
  health: () => Promise<{ ok: boolean; mediamtx?: unknown; error?: string }>;
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

    async health() {
      const result = await requestJson<{ ok: boolean; mediamtx?: unknown }>(
        "/api/health",
        { method: "GET" },
      );
      return {
        ok: result.ok && Boolean(result.body?.ok),
        mediamtx: result.body?.mediamtx,
        error: result.error,
      };
    },
  };
}
