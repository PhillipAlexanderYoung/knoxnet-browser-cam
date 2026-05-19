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
} from "./signaling-client";

export interface StartParams {
  receiverUrl: string;
  pairingCode: string;
  name: string;
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

  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<CameraPeer | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const statsIntervalRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startParamsRef = useRef<StartParams | null>(null);

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
        throw err;
      }
      streamRef.current = media;
      setStream(media);
      refreshTrackInfo(media);
      return media;
    },
    [releasePreview, refreshTrackInfo],
  );

  const stop = useCallback(async (): Promise<void> => {
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
        onStateChange: (s) => {
          if (s === "open") {
            setState("searching");
            client.send({
              type: "hello",
              role: "camera",
              name: params.name,
              pairingCode: params.pairingCode,
              capabilities: caps,
            });
          } else if (s === "closed") {
            setState((prev) => (prev === "idle" ? "idle" : "disconnected"));
          } else if (s === "error") {
            setError("Signaling connection failed");
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
            const peer = new CameraPeer({
              sessionId: msg.sessionId,
              signaling: client,
              stream: streamRef.current!,
              maxBitrateKbps: params.maxBitrateKbps,
              onConnectionStateChange: (pcState) => {
                if (pcState === "connected") {
                  setState("streaming");
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
            await peerRef.current?.acceptAnswer(msg.sdp);
          } else if (msg.type === "ice") {
            await peerRef.current?.addRemoteIce(msg.candidate);
          } else if (msg.type === "bye") {
            await stop();
          } else if (msg.type === "error") {
            setError(msg.message);
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
    [acquirePreview, stop, torchSupported],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (statsIntervalRef.current != null) {
        window.clearInterval(statsIntervalRef.current);
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
    start,
    stop,
    toggleTorch,
    applyTrackConstraints,
    applyMaxBitrate,
    acquirePreview,
    releasePreview,
  };
}
