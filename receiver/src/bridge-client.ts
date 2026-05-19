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

export interface BridgeClient {
  allocateCamera: (camera: CameraRecord) => Promise<BridgeAllocation | null>;
  publishOffer: (
    camera: CameraRecord,
    offerSdp: string,
  ) => Promise<{ type: "answer"; sdp: string } | null>;
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
  ): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`, init);
      const body = (await res.json()) as T & { error?: string; detail?: string };
      if (!res.ok) {
        log("bridge request failed", path, res.status, body.error, body.detail);
        return null;
      }
      return body;
    } catch (err) {
      log("bridge request error", path, err);
      return null;
    }
  }

  return {
    async allocateCamera(camera) {
      const body = await requestJson<{ ok: boolean; camera: BridgeAllocation }>(
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
      return body?.camera ?? null;
    },

    async publishOffer(camera, offerSdp) {
      const body = await requestJson<{
        ok: boolean;
        sdp: { type: "answer"; sdp: string };
        camera?: BridgeAllocation;
      }>(`/api/cameras/${encodeURIComponent(camera.sessionId)}/whip`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", Accept: "application/json" },
        body: offerSdp,
      });
      if (body?.camera) {
        camera.bridge = body.camera;
      }
      return body?.sdp ?? null;
    },

    async removeCamera(cameraId) {
      await requestJson<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(cameraId)}`, {
        method: "DELETE",
      });
    },
  };
}
