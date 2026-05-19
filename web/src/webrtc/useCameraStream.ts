import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildVideoConstraints,
  type FrameRate,
  type ResolutionKey,
} from "./constraints";
import { CameraPeer, type StreamStats } from "./peer";
import {
  SignalingClient,
  type CameraCapabilities,
  type ConnectionState,
  type SignalingStateDetail,
} from "./signaling-client";

const INSECURE_CAMERA_ORIGIN_MESSAGE =
  "Camera access is blocked because this page is not a secure context. Browser camera access requires HTTPS or localhost; http://<LAN-IP> will not prompt for camera permission on most mobile browsers.";

export function getCameraAccessErrorMessage(): string | null {
  if (typeof navigator === "undefined") {
    return "Camera APIs are unavailable in this browser.";
  }

  const mediaDevices = navigator.mediaDevices;
  const hasGetUserMedia =
    Boolean(mediaDevices) && typeof mediaDevices.getUserMedia === "function";

  if (!hasGetUserMedia && typeof window !== "undefined" && !window.isSecureContext) {
    return INSECURE_CAMERA_ORIGIN_MESSAGE;
  }

  if (!hasGetUserMedia) {
    return "Camera APIs are unavailable in this browser. Use a browser/device that supports navigator.mediaDevices.getUserMedia.";
  }

  return null;
}

function receiverTrustUrl(receiverUrl: string): string | null {
  try {
    const url = new URL(receiverUrl);
    if (url.protocol !== "wss:") return null;
    return `https://${url.host}/`;
  } catch {
    return null;
  }
}

function describeSignalingFailure(
  receiverUrl: string,
  detail?: SignalingStateDetail,
): string {
  const parts = [`Signaling connection failed for ${receiverUrl}.`];
  const details: string[] = [];
  if (detail?.code != null) details.push(`close code ${detail.code}`);
  if (detail?.reason) details.push(`reason "${detail.reason}"`);
  if (detail?.wasClean != null) {
    details.push(detail.wasClean ? "clean close" : "unclean close");
  }
  if (detail?.message) details.push(detail.message);
  if (details.length > 0) {
    parts.push(`Details: ${details.join(", ")}.`);
  }
  const trustUrl = receiverTrustUrl(receiverUrl);
  if (trustUrl) {
    parts.push(
      `If this receiver uses the local self-signed dev certificate, open ${trustUrl} on this iPhone once and accept the certificate, then return here and start streaming again.`,
    );
  }
  return parts.join(" ");
}

export interface StartParams {
  receiverUrl: string;
  pairingCode: string;
  name: string;
  clientDeviceId: string;
  resolution: ResolutionKey;
  frameRate: FrameRate;
  audioEnabled: boolean;
  facingMode: "user" | "environment";
  deviceId?: string;
  maxBitrateKbps: number;
}

export interface CameraStreamApi {
  state: ConnectionState;
  error: string | null;
  stream: MediaStream | null;
  stats: StreamStats | null;
  trackSettings: MediaTrackSettings | null;
  trackCapabilities: MediaTrackCapabilities | null;
  torchSupported: boolean;
  torchOn: boolean;
  sessionId: string | null;
  cameraAccessError: string | null;
  start(params: StartParams): Promise<void>;
  stop(): Promise<void>;
  toggleTorch(): Promise<void>;
  applyTrackConstraints(opts: {
    resolution?: ResolutionKey;
    frameRate?: FrameRate;
  }): Promise<void>;
  applyMaxBitrate(kbps: number): Promise<void>;
  acquirePreview(opts: {
    facingMode: "user" | "environment";
    deviceId?: string;
    resolution: ResolutionKey;
    frameRate: FrameRate;
    audioEnabled: boolean;
  }): Promise<MediaStream>;
  releasePreview(): void;
}

export function useCameraStream(): CameraStreamApi {
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [trackSettings, setTrackSettings] = useState<MediaTrackSettings | null>(
    null,
  );
  const [trackCapabilities, setTrackCapabilities] =
    useState<MediaTrackCapabilities | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cameraAccessError] = useState<string | null>(() =>
    getCameraAccessErrorMessage(),
  );

  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<CameraPeer | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const statsIntervalRef = useRef<number | null>(null);
  const negotiationTimeoutRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startParamsRef = useRef<StartParams | null>(null);

  useEffect(() => {
    if (!cameraAccessError) return;
    setError(cameraAccessError);
    setState("error");
  }, [cameraAccessError]);

  const refreshTrackInfo = useCallback((s: MediaStream | null) => {
    const track = s?.getVideoTracks()?.[0] ?? null;
    if (!track) {
      setTrackSettings(null);
      setTrackCapabilities(null);
      setTorchSupported(false);
      return;
    }
    const settings = track.getSettings();
    setTrackSettings(settings);
    let caps: MediaTrackCapabilities | null = null;
    try {
      caps = track.getCapabilities ? track.getCapabilities() : null;
    } catch {
      caps = null;
    }
    setTrackCapabilities(caps);
    const supportsTorch = Boolean(
      caps && "torch" in caps && (caps as { torch?: boolean }).torch === true,
    );
    setTorchSupported(supportsTorch);
  }, []);

  const releasePreview = useCallback((): void => {
    const s = streamRef.current;
    if (s) {
      for (const t of s.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
    }
    streamRef.current = null;
    setStream(null);
    setTorchOn(false);
    refreshTrackInfo(null);
  }, [refreshTrackInfo]);

  const acquirePreview = useCallback(
    async (opts: {
      facingMode: "user" | "environment";
      deviceId?: string;
      resolution: ResolutionKey;
      frameRate: FrameRate;
      audioEnabled: boolean;
    }): Promise<MediaStream> => {
      const unsupportedReason =
        cameraAccessError ?? getCameraAccessErrorMessage();
      if (unsupportedReason) {
        setError(unsupportedReason);
        setState("error");
        throw new Error(unsupportedReason);
      }

      releasePreview();
      const video = buildVideoConstraints({
        facingMode: opts.facingMode,
        deviceId: opts.deviceId,
        resolution: opts.resolution,
        frameRate: opts.frameRate,
      });
      const audio = opts.audioEnabled
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        : false;
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ video, audio });
      } catch (err) {
        setError((err as Error)?.message ?? "Could not access camera");
        setState("error");
        throw err;
      }
      streamRef.current = media;
      setStream(media);
      refreshTrackInfo(media);
      return media;
    },
    [cameraAccessError, releasePreview, refreshTrackInfo],
  );

  const stop = useCallback(async (): Promise<void> => {
    if (negotiationTimeoutRef.current != null) {
      window.clearTimeout(negotiationTimeoutRef.current);
      negotiationTimeoutRef.current = null;
    }
    if (statsIntervalRef.current != null) {
      window.clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    if (signalingRef.current) {
      signalingRef.current.close();
      signalingRef.current = null;
    }
    sessionIdRef.current = null;
    setSessionId(null);
    setStats(null);
    setState("idle");
    releasePreview();
  }, [releasePreview]);

  const applyTrackConstraints = useCallback(
    async (opts: {
      resolution?: ResolutionKey;
      frameRate?: FrameRate;
    }): Promise<void> => {
      const track = streamRef.current?.getVideoTracks()?.[0];
      if (!track) return;
      const next: MediaTrackConstraints = {};
      if (opts.resolution) {
        const v = buildVideoConstraints({
          resolution: opts.resolution,
          frameRate: opts.frameRate ?? 15,
        });
        next.width = v.width;
        next.height = v.height;
      }
      if (opts.frameRate) {
        next.frameRate = { ideal: opts.frameRate };
      }
      try {
        await track.applyConstraints(next);
        refreshTrackInfo(streamRef.current);
      } catch (err) {
        setError(
          (err as Error)?.message ??
            "This device cannot apply that constraint while streaming.",
        );
      }
    },
    [refreshTrackInfo],
  );

  const applyMaxBitrate = useCallback(async (kbps: number): Promise<void> => {
    if (peerRef.current) {
      await peerRef.current.applyMaxBitrate(kbps);
    }
  }, []);

  const toggleTorch = useCallback(async (): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()?.[0];
    if (!track || !torchSupported) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        // The torch constraint is non-standard; cast through `any` only here.
        advanced: [{ torch: next } as MediaTrackConstraintSet & { torch: boolean }],
      } as MediaTrackConstraints);
      setTorchOn(next);
    } catch (err) {
      setError((err as Error)?.message ?? "Torch toggle failed");
    }
  }, [torchOn, torchSupported]);

  const start = useCallback(
    async (params: StartParams): Promise<void> => {
      setError(null);
      if (negotiationTimeoutRef.current != null) {
        window.clearTimeout(negotiationTimeoutRef.current);
        negotiationTimeoutRef.current = null;
      }
      if (statsIntervalRef.current != null) {
        window.clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
      peerRef.current?.destroy();
      peerRef.current = null;
      signalingRef.current?.close();
      signalingRef.current = null;
      const unsupportedReason =
        cameraAccessError ?? getCameraAccessErrorMessage();
      if (unsupportedReason) {
        setError(unsupportedReason);
        setState("error");
        throw new Error(unsupportedReason);
      }

      startParamsRef.current = params;

      let media = streamRef.current;
      if (!media) {
        media = await acquirePreview({
          facingMode: params.facingMode,
          deviceId: params.deviceId,
          resolution: params.resolution,
          frameRate: params.frameRate,
          audioEnabled: params.audioEnabled,
        });
      } else {
        // Make sure audio enabled state matches.
        const audioTrack = media.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = params.audioEnabled;
      }

      const caps: CameraCapabilities = {
        resolutions: ["480p", "720p", "1080p"],
        frameRates: [5, 10, 15, 30],
        torch: torchSupported,
        audio: params.audioEnabled,
        facingModes: ["user", "environment"],
      };

      setState("connecting");
      const client = new SignalingClient({
        url: params.receiverUrl,
        onStateChange: (s, detail) => {
          if (s === "open") {
            setState("searching");
            client.send({
              type: "hello",
              role: "camera",
              name: params.name,
              deviceId: params.clientDeviceId,
              pairingCode: params.pairingCode,
              capabilities: caps,
            });
          } else if (s === "closed") {
            if (!detail?.closedByClient && detail?.code === 1006) {
              setError(describeSignalingFailure(params.receiverUrl, detail));
              setState("error");
              return;
            }
            setState((prev) =>
              prev === "idle" || prev === "error" ? prev : "disconnected",
            );
          } else if (s === "error") {
            setError(describeSignalingFailure(params.receiverUrl, detail));
            setState("error");
          }
        },
        onMessage: async (msg) => {
          if (msg.type === "hello-ack") {
            if (!msg.paired) {
              setError(msg.reason ?? "Pairing rejected");
              setState("error");
              await stop();
              return;
            }
            if (msg.sessionId) {
              sessionIdRef.current = msg.sessionId;
              setSessionId(msg.sessionId);
              setState("paired");
            }
          } else if (msg.type === "accepted") {
            sessionIdRef.current = msg.sessionId;
            setSessionId(msg.sessionId);
            setState("negotiating");
            if (negotiationTimeoutRef.current != null) {
              window.clearTimeout(negotiationTimeoutRef.current);
            }
            negotiationTimeoutRef.current = window.setTimeout(() => {
              setError(
                "WebRTC negotiation timed out. Check receiver bridge logs and MediaMTX health; RTSP is not live until WHIP publish succeeds.",
              );
              setState("error");
            }, 20_000);
            const peer = new CameraPeer({
              sessionId: msg.sessionId,
              signaling: client,
              stream: streamRef.current!,
              maxBitrateKbps: params.maxBitrateKbps,
              onConnectionStateChange: (pcState) => {
                if (pcState === "connected") {
                  if (negotiationTimeoutRef.current != null) {
                    window.clearTimeout(negotiationTimeoutRef.current);
                    negotiationTimeoutRef.current = null;
                  }
                  setState("streaming");
                } else if (pcState === "connecting") {
                  setState("negotiating");
                } else if (pcState === "failed") {
                  setError("WebRTC connection failed");
                  setState("error");
                } else if (pcState === "disconnected") {
                  setState("paired");
                } else if (pcState === "closed") {
                  setState((p) => (p === "error" ? "error" : "disconnected"));
                }
              },
            });
            peerRef.current = peer;
            try {
              await peer.createAndSendOffer();
            } catch (err) {
              setError((err as Error)?.message ?? "Failed to start WebRTC");
              setState("error");
            }
            if (statsIntervalRef.current == null) {
              statsIntervalRef.current = window.setInterval(async () => {
                if (!peerRef.current) return;
                const next = await peerRef.current.pollStats();
                setStats(next);
              }, 1000);
            }
          } else if (msg.type === "rejected") {
            setError(msg.reason ?? "Camera rejected by operator");
            setState("error");
            await stop();
          } else if (msg.type === "answer") {
            if (negotiationTimeoutRef.current != null) {
              window.clearTimeout(negotiationTimeoutRef.current);
              negotiationTimeoutRef.current = null;
            }
            await peerRef.current?.acceptAnswer(msg.sdp);
          } else if (msg.type === "ice") {
            await peerRef.current?.addRemoteIce(msg.candidate);
          } else if (msg.type === "bye") {
            await stop();
          } else if (msg.type === "error") {
            setError(msg.message);
            setState("error");
          }
        },
        onLog: (...args) => {
          // eslint-disable-next-line no-console
          console.warn("[signaling]", ...args);
        },
      });
      signalingRef.current = client;
      client.connect();
    },
    [acquirePreview, cameraAccessError, stop, torchSupported],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (statsIntervalRef.current != null) {
        window.clearInterval(statsIntervalRef.current);
      }
      if (negotiationTimeoutRef.current != null) {
        window.clearTimeout(negotiationTimeoutRef.current);
      }
      peerRef.current?.destroy();
      signalingRef.current?.close();
      const s = streamRef.current;
      if (s) {
        for (const t of s.getTracks()) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
      }
    };
  }, []);

  return {
    state,
    error,
    stream,
    stats,
    trackSettings,
    trackCapabilities,
    torchSupported,
    torchOn,
    sessionId,
    cameraAccessError,
    start,
    stop,
    toggleTorch,
    applyTrackConstraints,
    applyMaxBitrate,
    acquirePreview,
    releasePreview,
  };
}
