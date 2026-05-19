import type { CameraRecord } from "./pairing.js";

export interface BridgeAllocation {
  cameraId: string;
  name: string;
  path: string;
  rtspUrl: string;
  whipUrl?: string;
  ingestStatus?: "allocated" | "publishing" | "error";
  lastError?: string;
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
  removeCamera: (cameraId: string) => Promise<void>;
}

export function createBridgeClient(
  bridgeUrl: string | undefined,
  log: (...args: unknown[]) => void,
): BridgeClient | null {
  const baseUrl = bridgeUrl?.replace(/\/+$/, "");
  if (!baseUrl) return null;

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
      const result = await requestJson<{ ok: boolean; camera: BridgeAllocation }>(
        "/api/cameras",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cameraId: camera.sessionId,
            name: camera.name,
            pathHint: camera.name || camera.sessionId,
          }),
        },
      );
      return result.ok ? (result.body?.camera ?? null) : null;
    },

    async publishOffer(camera, offerSdp) {
      const result = await requestJson<{
        ok: boolean;
        sdp: { type: "answer"; sdp: string };
        camera?: BridgeAllocation;
      }>(`/api/cameras/${encodeURIComponent(camera.sessionId)}/whip`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", Accept: "application/json" },
        body: offerSdp,
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

    async removeCamera(cameraId) {
      await requestJson<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(cameraId)}`, {
        method: "DELETE",
      });
    },
  };
}
