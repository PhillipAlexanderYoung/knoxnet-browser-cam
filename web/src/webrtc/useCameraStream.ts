import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildVideoConstraints,
  type FrameRate,
  isManualResolution,
  MANUAL_RESOLUTION_OPTIONS,
  resolutionFromHeight,
  type ResolutionMode,
  type ResolutionKey,
} from "./constraints";
import { CameraPeer, type StreamStats } from "./peer";
import {
  SignalingClient,
  type CameraCapabilities,
  type ConnectionState,
  type SignalingStateDetail,
} from "./signaling-client";

export const CAMERA_PERMISSION_REQUIRED_MESSAGE =
  "Camera permission is required. Use the browser permission prompt or Settings to allow camera access.";
const INSECURE_CAMERA_ORIGIN_MESSAGE =
  "Camera access is blocked because this page is not a secure context. Browser camera access requires HTTPS or localhost; http://<LAN-IP> will not prompt for camera permission on most mobile browsers.";
const MAX_RECONNECT_DELAY_MS = 30_000;
const NEGOTIATION_TIMEOUT_MS = 20_000;
const AUTO_DOWNGRADE_COOLDOWN_MS = 30_000;
const AUTO_UPGRADE_COOLDOWN_MS = 120_000;
const AUTO_STABLE_MS = 180_000;
const AUTO_UNSTABLE_SAMPLES = 3;
const AUTO_LOW_BITRATE_KBPS = 350;

export interface ReconnectInfo {
  active: boolean;
  attempt: number;
  delayMs: number | null;
  reason: string | null;
  nextAt: number | null;
}

export type StreamErrorKind =
  | "camera"
  | "certificate"
  | "connection"
  | "pairing"
  | "receiver"
  | null;

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

export function isCameraPermissionDeniedError(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  return (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError"
  );
}

function receiverUsesSecureWs(receiverUrl: string): boolean {
  try {
    const url = new URL(receiverUrl);
    return url.protocol === "wss:";
  } catch {
    return false;
  }
}

function signalingLooksLikeTrustIssue(
  receiverUrl: string,
  detail?: SignalingStateDetail,
  attempt = 1,
): boolean {
  if (!receiverUsesSecureWs(receiverUrl)) return false;
  if (detail?.opened) return false;

  const message = detail?.message?.toLowerCase() ?? "";
  if (/\b(cert|certificate|tls|ssl|security|secure|origin)\b/.test(message)) {
    return true;
  }

  const secureContext =
    typeof window === "undefined" ? true : window.isSecureContext;
  const noUsableCloseCode = detail?.code == null || detail.code === 1006;
  const immediateFailure = detail?.elapsedMs == null || detail.elapsedMs < 1500;
  return secureContext && noUsableCloseCode && immediateFailure && attempt >= 2;
}

function describeRecoverableFailure(
  kind: StreamErrorKind,
  fallback?: string,
): string {
  if (kind === "certificate") {
    return "Secure receiver connection could not be opened.";
  }
  return fallback ?? "Receiver disconnected. Reconnecting.";
}

export interface StreamQualityInfo {
  mode: ResolutionMode;
  requestedResolution: ResolutionMode;
  currentResolution: ResolutionKey;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrateKbps?: number;
  message: string | null;
}

function chooseInitialAutoResolution(): ResolutionKey {
  const supported =
    typeof navigator !== "undefined" && navigator.mediaDevices?.getSupportedConstraints
      ? navigator.mediaDevices.getSupportedConstraints()
      : null;
  return supported?.width === false || supported?.height === false ? "480p" : "720p";
}

function nextLowerResolution(resolution: ResolutionKey): ResolutionKey | null {
  const index = MANUAL_RESOLUTION_OPTIONS.indexOf(resolution);
  return index > 0 ? MANUAL_RESOLUTION_OPTIONS[index - 1] : null;
}

function nextHigherResolution(resolution: ResolutionKey): ResolutionKey | null {
  const index = MANUAL_RESOLUTION_OPTIONS.indexOf(resolution);
  if (index < 0 || index >= MANUAL_RESOLUTION_OPTIONS.length - 1) return null;
  return MANUAL_RESOLUTION_OPTIONS[index + 1];
}

function effectiveAutoBitrateCap(resolution: ResolutionKey, requestedKbps: number): number {
  const cap = resolution === "480p" ? 1000 : resolution === "720p" ? 2000 : requestedKbps;
  return Math.min(requestedKbps, cap);
}

export interface StartParams {
  receiverUrl: string;
  pairingCode: string;
  name: string;
  clientDeviceId: string;
  resolution: ResolutionMode;
  frameRate: FrameRate;
  audioEnabled: boolean;
  facingMode: "user" | "environment";
  deviceId?: string;
  maxBitrateKbps: number;
}

export interface CameraStreamApi {
  state: ConnectionState;
  shouldStream: boolean;
  reconnect: ReconnectInfo;
  errorKind: StreamErrorKind;
  error: string | null;
  stream: MediaStream | null;
  stats: StreamStats | null;
  quality: StreamQualityInfo;
  trackSettings: MediaTrackSettings | null;
  trackCapabilities: MediaTrackCapabilities | null;
  torchSupported: boolean;
  torchOn: boolean;
  sessionId: string | null;
  cameraAccessError: string | null;
  start(params: StartParams): Promise<void>;
  stop(opts?: { preserveError?: boolean }): Promise<void>;
  toggleTorch(): Promise<void>;
  applyTrackConstraints(opts: {
    resolution?: ResolutionMode;
    frameRate?: FrameRate;
  }): Promise<void>;
  applyMaxBitrate(kbps: number): Promise<void>;
  acquirePreview(opts: {
    facingMode: "user" | "environment";
    deviceId?: string;
    resolution: ResolutionMode;
    frameRate: FrameRate;
    audioEnabled: boolean;
  }): Promise<MediaStream>;
  releasePreview(): void;
}

export function useCameraStream(): CameraStreamApi {
  const [state, setState] = useState<ConnectionState>("idle");
  const [shouldStream, setShouldStream] = useState(false);
  const [reconnect, setReconnect] = useState<ReconnectInfo>({
    active: false,
    attempt: 0,
    delayMs: null,
    reason: null,
    nextAt: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<StreamErrorKind>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [quality, setQuality] = useState<StreamQualityInfo>(() => {
    const initial = chooseInitialAutoResolution();
    return {
      mode: "auto",
      requestedResolution: "auto",
      currentResolution: initial,
      message: null,
    };
  });
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
  const reconnectTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startParamsRef = useRef<StartParams | null>(null);
  const shouldStreamRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectingRef = useRef(false);
  const effectiveResolutionRef = useRef<ResolutionKey>(chooseInitialAutoResolution());
  const userBitrateKbpsRef = useRef(2000);
  const autoUnstableSamplesRef = useRef(0);
  const autoStableSinceRef = useRef<number | null>(null);
  const autoLastAdjustAtRef = useRef(0);
  const lastQualitySentRef = useRef("");
  const startOnceRef = useRef<
    (params: StartParams, opts?: { isReconnect?: boolean }) => Promise<void>
  >(async () => {});
  const currentVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const handleRecoverableFailureRef = useRef<(reason: string, message?: string) => void>(
    () => {},
  );

  useEffect(() => {
    if (!cameraAccessError) return;
    setError(cameraAccessError);
    setErrorKind("camera");
    setState("error");
  }, [cameraAccessError]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearConnectionTimers = useCallback(() => {
    if (negotiationTimeoutRef.current != null) {
      window.clearTimeout(negotiationTimeoutRef.current);
      negotiationTimeoutRef.current = null;
    }
    if (statsIntervalRef.current != null) {
      window.clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
  }, []);

  const cleanupConnection = useCallback(
    (opts: { sendBye?: boolean } = {}): void => {
      clearConnectionTimers();
      const peer = peerRef.current;
      peerRef.current = null;
      if (peer) {
        if (opts.sendBye === false) {
          peer.close();
        } else {
          peer.destroy();
        }
      }
      signalingRef.current?.close();
      signalingRef.current = null;
      sessionIdRef.current = null;
      setSessionId(null);
      setStats(null);
    },
    [clearConnectionTimers],
  );

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

  const updateQualityFromTrack = useCallback(
    (message?: string | null, nextStats?: StreamStats | null): void => {
      const settings = streamRef.current?.getVideoTracks()?.[0]?.getSettings();
      const width = settings?.width;
      const height = settings?.height;
      const frameRate =
        typeof settings?.frameRate === "number"
          ? Math.round(settings.frameRate)
          : typeof nextStats?.framesPerSecond === "number"
            ? Math.round(nextStats.framesPerSecond)
            : undefined;
      const currentResolution =
        typeof height === "number"
          ? resolutionFromHeight(height)
          : effectiveResolutionRef.current;
      effectiveResolutionRef.current = currentResolution;
      const requestedResolution = startParamsRef.current?.resolution ?? currentResolution;
      setQuality({
        mode: requestedResolution === "auto" ? "auto" : currentResolution,
        requestedResolution,
        currentResolution,
        width,
        height,
        frameRate,
        bitrateKbps: nextStats?.bitrateKbps,
        message: message ?? null,
      });
    },
    [],
  );

  const sendQualityUpdate = useCallback((info: StreamQualityInfo): void => {
    const client = signalingRef.current;
    const sessionId = sessionIdRef.current;
    if (!client || !sessionId || !client.isOpen()) return;
    const signature = JSON.stringify(info);
    if (signature === lastQualitySentRef.current) return;
    lastQualitySentRef.current = signature;
    client.send({
      type: "quality",
      sessionId,
      quality: info,
    });
  }, []);

  useEffect(() => {
    sendQualityUpdate(quality);
  }, [quality, sendQualityUpdate]);

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
    currentVideoTrackRef.current = null;
    setStream(null);
    setTorchOn(false);
    refreshTrackInfo(null);
  }, [refreshTrackInfo]);

  const acquirePreview = useCallback(
    async (opts: {
      facingMode: "user" | "environment";
      deviceId?: string;
      resolution: ResolutionMode;
      frameRate: FrameRate;
      audioEnabled: boolean;
    }): Promise<MediaStream> => {
      const unsupportedReason =
        cameraAccessError ?? getCameraAccessErrorMessage();
      if (unsupportedReason) {
        setError(unsupportedReason);
        setErrorKind("camera");
        setState("error");
        throw new Error(unsupportedReason);
      }

      releasePreview();
      const requestedResolution = isManualResolution(opts.resolution)
        ? opts.resolution
        : chooseInitialAutoResolution();
      effectiveResolutionRef.current = requestedResolution;
      const video = buildVideoConstraints({
        facingMode: opts.facingMode,
        deviceId: opts.deviceId,
        resolution: requestedResolution,
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
        setError(
          isCameraPermissionDeniedError(err)
            ? CAMERA_PERMISSION_REQUIRED_MESSAGE
            : (err as Error)?.message ?? "Could not access camera",
        );
        setErrorKind("camera");
        setState("error");
        throw err;
      }
      streamRef.current = media;
      const videoTrack = media.getVideoTracks()[0] ?? null;
      currentVideoTrackRef.current = videoTrack;
      if (videoTrack) {
        videoTrack.onended = () => {
          if (currentVideoTrackRef.current !== videoTrack) return;
          handleRecoverableFailureRef.current(
            "camera-track-ended",
            "Camera track ended; reacquiring camera before reconnect.",
          );
        };
      }
      setStream(media);
      refreshTrackInfo(media);
      updateQualityFromTrack(null);
      return media;
    },
    [cameraAccessError, releasePreview, refreshTrackInfo, updateQualityFromTrack],
  );

  const stop = useCallback(async (opts: { preserveError?: boolean } = {}): Promise<void> => {
    shouldStreamRef.current = false;
    setShouldStream(false);
    reconnectAttemptRef.current = 0;
    reconnectingRef.current = false;
    clearReconnectTimer();
    setReconnect({
      active: false,
      attempt: 0,
      delayMs: null,
      reason: null,
      nextAt: null,
    });
    cleanupConnection();
    startParamsRef.current = null;
    setStats(null);
    autoUnstableSamplesRef.current = 0;
    autoStableSinceRef.current = null;
    autoLastAdjustAtRef.current = 0;
    lastQualitySentRef.current = "";
    if (!opts.preserveError) {
      setError(null);
      setErrorKind(null);
    }
    setState("idle");
    releasePreview();
  }, [cleanupConnection, clearReconnectTimer, releasePreview]);

  const applyTrackConstraints = useCallback(
    async (opts: {
      resolution?: ResolutionMode;
      frameRate?: FrameRate;
    }): Promise<void> => {
      const track = streamRef.current?.getVideoTracks()?.[0];
      if (!track) return;
      const next: MediaTrackConstraints = {};
      const previousResolution = effectiveResolutionRef.current;
      const params = startParamsRef.current;
      if (opts.resolution) {
        const requestedResolution = isManualResolution(opts.resolution)
          ? opts.resolution
          : chooseInitialAutoResolution();
        const v = buildVideoConstraints({
          resolution: requestedResolution,
          frameRate: opts.frameRate ?? params?.frameRate ?? 15,
        });
        next.width = v.width;
        next.height = v.height;
        effectiveResolutionRef.current = requestedResolution;
        if (params) {
          params.resolution = opts.resolution;
        }
      }
      if (opts.frameRate) {
        next.frameRate = { ideal: opts.frameRate };
        if (params) params.frameRate = opts.frameRate;
      }
      try {
        await track.applyConstraints(next);
        refreshTrackInfo(streamRef.current);
        updateQualityFromTrack(
          opts.resolution === "auto" ? `Auto using ${effectiveResolutionRef.current}` : null,
        );
      } catch (err) {
        effectiveResolutionRef.current = previousResolution;
        const message =
          (err as Error)?.message ??
          "This device cannot apply that constraint while streaming.";
        if (opts.resolution && opts.resolution !== "auto") {
          const fallback = nextLowerResolution(opts.resolution);
          if (fallback) {
            try {
              const v = buildVideoConstraints({
                resolution: fallback,
                frameRate: opts.frameRate ?? params?.frameRate ?? 15,
              });
              await track.applyConstraints({
                width: v.width,
                height: v.height,
                frameRate: next.frameRate,
              });
              effectiveResolutionRef.current = fallback;
              setError(
                `Could not apply ${opts.resolution}; using ${fallback} to keep the stream alive.`,
              );
              refreshTrackInfo(streamRef.current);
              updateQualityFromTrack(`Using ${fallback}; ${message}`);
              return;
            } catch {
              effectiveResolutionRef.current = previousResolution;
            }
          }
        }
        setError(message);
      }
    },
    [refreshTrackInfo, updateQualityFromTrack],
  );

  const applyMaxBitrate = useCallback(async (kbps: number): Promise<void> => {
    userBitrateKbpsRef.current = kbps;
    const params = startParamsRef.current;
    if (params) params.maxBitrateKbps = kbps;
    const effectiveKbps =
      params?.resolution === "auto"
        ? effectiveAutoBitrateCap(effectiveResolutionRef.current, kbps)
        : kbps;
    if (peerRef.current) {
      await peerRef.current.applyMaxBitrate(effectiveKbps);
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

  const applyAutoResolution = useCallback(
    async (resolution: ResolutionKey, reason: "stability" | "stable"): Promise<boolean> => {
      const track = streamRef.current?.getVideoTracks()?.[0];
      if (!track) return false;
      const params = startParamsRef.current;
      if (!params || params.resolution !== "auto") return false;
      const previousResolution = effectiveResolutionRef.current;
      const frameRate: FrameRate =
        reason === "stability" && params.frameRate > 15 ? 15 : params.frameRate;
      const constraints = buildVideoConstraints({
        resolution,
        frameRate,
      });
      try {
        await track.applyConstraints({
          width: constraints.width,
          height: constraints.height,
          frameRate: { ideal: frameRate },
        });
        effectiveResolutionRef.current = resolution;
        await peerRef.current?.applyMaxBitrate(
          effectiveAutoBitrateCap(resolution, userBitrateKbpsRef.current),
        );
        refreshTrackInfo(streamRef.current);
        const message =
          reason === "stability"
            ? `Auto adjusted to ${resolution} for stability`
            : `Auto adjusted to ${resolution}`;
        setError(message);
        updateQualityFromTrack(message, stats);
        return true;
      } catch (err) {
        effectiveResolutionRef.current = previousResolution;
        setError((err as Error)?.message ?? `Auto could not apply ${resolution}.`);
        return false;
      }
    },
    [refreshTrackInfo, stats, updateQualityFromTrack],
  );

  const handleAutoStats = useCallback(
    (next: StreamStats): void => {
      const params = startParamsRef.current;
      if (!params || params.resolution !== "auto") return;

      const now = Date.now();
      const unstable =
        next.bitrateKbps > 0 &&
        (next.bitrateKbps < AUTO_LOW_BITRATE_KBPS ||
          (next.rttMs != null && next.rttMs > 700) ||
          next.fractionLost > 0.08);

      if (unstable) {
        autoStableSinceRef.current = null;
        autoUnstableSamplesRef.current += 1;
      } else {
        autoUnstableSamplesRef.current = 0;
        autoStableSinceRef.current ??= now;
      }

      if (
        autoUnstableSamplesRef.current >= AUTO_UNSTABLE_SAMPLES &&
        now - autoLastAdjustAtRef.current >= AUTO_DOWNGRADE_COOLDOWN_MS
      ) {
        const lower = nextLowerResolution(effectiveResolutionRef.current);
        if (lower) {
          autoLastAdjustAtRef.current = now;
          autoUnstableSamplesRef.current = 0;
          void applyAutoResolution(lower, "stability");
          return;
        }
      }

      const stableFor = autoStableSinceRef.current ? now - autoStableSinceRef.current : 0;
      if (
        stableFor >= AUTO_STABLE_MS &&
        now - autoLastAdjustAtRef.current >= AUTO_UPGRADE_COOLDOWN_MS
      ) {
        const higher = nextHigherResolution(effectiveResolutionRef.current);
        if (higher && higher !== "1080p") {
          autoLastAdjustAtRef.current = now;
          autoStableSinceRef.current = now;
          void applyAutoResolution(higher, "stable");
        }
      }
    },
    [applyAutoResolution],
  );

  const scheduleReconnect = useCallback(
    (
      reason: string,
      message?: string,
      opts: { detail?: SignalingStateDetail; kind?: StreamErrorKind } = {},
    ): void => {
      if (!shouldStreamRef.current) return;
      const params = startParamsRef.current;
      if (!params) return;
      if (params.resolution === "auto" && reason !== "network-offline") {
        const lower = nextLowerResolution(effectiveResolutionRef.current);
        if (
          lower &&
          Date.now() - autoLastAdjustAtRef.current >= AUTO_DOWNGRADE_COOLDOWN_MS
        ) {
          autoLastAdjustAtRef.current = Date.now();
          void applyAutoResolution(lower, "stability");
        }
      }
      cleanupConnection({ sendBye: false });
      setState("disconnected");
      if (reconnectTimerRef.current != null || reconnectingRef.current) return;

      const attempt = reconnectAttemptRef.current + 1;
      const kind =
        opts.kind ??
        (opts.detail &&
        signalingLooksLikeTrustIssue(params.receiverUrl, opts.detail, attempt)
          ? "certificate"
          : "connection");
      setErrorKind(kind);
      setError(describeRecoverableFailure(kind, message));
      reconnectAttemptRef.current = attempt;
      const baseDelay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), MAX_RECONNECT_DELAY_MS);
      const offlineFloor =
        typeof navigator !== "undefined" && navigator.onLine === false ? 5000 : 0;
      const jitter = 0.8 + Math.random() * 0.4;
      const delayMs = Math.min(
        MAX_RECONNECT_DELAY_MS,
        Math.max(offlineFloor, Math.round(baseDelay * jitter)),
      );
      const nextAt = Date.now() + delayMs;
      setReconnect({ active: true, attempt, delayMs, reason, nextAt });
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!shouldStreamRef.current || !startParamsRef.current) return;
        reconnectingRef.current = true;
        void startOnceRef.current(startParamsRef.current, { isReconnect: true }).finally(() => {
          reconnectingRef.current = false;
        });
      }, delayMs);
    },
    [applyAutoResolution, cleanupConnection],
  );

  useEffect(() => {
    handleRecoverableFailureRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  const startOnce = useCallback(
    async (
      params: StartParams,
      _opts: { isReconnect?: boolean } = {},
    ): Promise<void> => {
      setError(null);
      setErrorKind(null);
      clearConnectionTimers();
      cleanupConnection({ sendBye: false });
      const unsupportedReason =
        cameraAccessError ?? getCameraAccessErrorMessage();
      if (unsupportedReason) {
        setError(unsupportedReason);
        setErrorKind("camera");
        setState("error");
        throw new Error(unsupportedReason);
      }

      startParamsRef.current = params;
      userBitrateKbpsRef.current = params.maxBitrateKbps;
      if (params.resolution === "auto" && !_opts.isReconnect) {
        effectiveResolutionRef.current = chooseInitialAutoResolution();
        autoUnstableSamplesRef.current = 0;
        autoStableSinceRef.current = null;
        autoLastAdjustAtRef.current = 0;
      } else if (isManualResolution(params.resolution)) {
        effectiveResolutionRef.current = params.resolution;
      }

      let media = streamRef.current;
      const videoTrack = media?.getVideoTracks()[0];
      if (!media || !videoTrack || videoTrack.readyState === "ended") {
        releasePreview();
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
        resolutions: ["auto", "480p", "720p", "1080p"],
        frameRates: [5, 10, 15, 30],
        torch: torchSupported,
        audio: params.audioEnabled,
        facingModes: ["user", "environment"],
        quality: {
          mode: params.resolution,
          requestedResolution: params.resolution,
          currentResolution: effectiveResolutionRef.current,
        },
      };

      setState("connecting");
      const client = new SignalingClient({
        url: params.receiverUrl,
        onStateChange: (s, detail) => {
          if (!shouldStreamRef.current) return;
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
            if (!detail?.closedByClient) {
              scheduleReconnect(
                "websocket-closed",
                undefined,
                { detail },
              );
              return;
            }
            setState((prev) =>
              prev === "idle" || prev === "error" ? prev : "disconnected",
            );
          } else if (s === "error") {
            scheduleReconnect(
              "websocket-error",
              undefined,
              { detail },
            );
          }
        },
        onMessage: async (msg) => {
          if (!shouldStreamRef.current) return;
          if (msg.type === "hello-ack") {
            if (!msg.paired) {
              setError(msg.reason ?? "Invalid pairing code or receiver rejected pairing.");
              setErrorKind("pairing");
              setState("error");
              await stop({ preserveError: true });
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
              scheduleReconnect(
                "negotiation-timeout",
                "WebRTC negotiation timed out. Check receiver bridge logs and MediaMTX health; RTSP is not live until WHIP publish succeeds.",
                { kind: "receiver" },
              );
            }, NEGOTIATION_TIMEOUT_MS);
            let peer: CameraPeer;
            peer = new CameraPeer({
              sessionId: msg.sessionId,
              signaling: client,
              stream: streamRef.current!,
              maxBitrateKbps:
                params.resolution === "auto"
                  ? effectiveAutoBitrateCap(
                      effectiveResolutionRef.current,
                      params.maxBitrateKbps,
                    )
                  : params.maxBitrateKbps,
              onConnectionStateChange: (pcState) => {
                if (peerRef.current !== peer) return;
                if (pcState === "connected") {
                  if (negotiationTimeoutRef.current != null) {
                    window.clearTimeout(negotiationTimeoutRef.current);
                    negotiationTimeoutRef.current = null;
                  }
                  setState("streaming");
                  reconnectAttemptRef.current = 0;
                  setReconnect({
                    active: false,
                    attempt: 0,
                    delayMs: null,
                    reason: null,
                    nextAt: null,
                  });
                  setError(null);
                  setErrorKind(null);
                  updateQualityFromTrack(null);
                } else if (pcState === "connecting") {
                  setState("negotiating");
                } else if (pcState === "failed") {
                  scheduleReconnect("webrtc-failed", "WebRTC connection failed; reconnecting.");
                } else if (pcState === "disconnected") {
                  scheduleReconnect(
                    "webrtc-disconnected",
                    "WebRTC connection disconnected; reconnecting.",
                  );
                } else if (pcState === "closed") {
                  scheduleReconnect("webrtc-closed", "WebRTC connection closed; reconnecting.");
                }
              },
              onIceConnectionStateChange: (iceState) => {
                if (peerRef.current !== peer) return;
                if (iceState === "failed" || iceState === "disconnected") {
                  scheduleReconnect(
                    `ice-${iceState}`,
                    `ICE connection ${iceState}; reconnecting.`,
                  );
                }
              },
            });
            peerRef.current = peer;
            try {
              await peer.createAndSendOffer();
            } catch (err) {
              scheduleReconnect(
                "offer-failed",
                (err as Error)?.message ?? "Failed to start WebRTC; reconnecting.",
              );
            }
            if (statsIntervalRef.current == null) {
              statsIntervalRef.current = window.setInterval(async () => {
                if (!peerRef.current) return;
                const next = await peerRef.current.pollStats();
                setStats(next);
                updateQualityFromTrack(null, next);
                handleAutoStats(next);
              }, 1000);
            }
          } else if (msg.type === "rejected") {
            setError(msg.reason ?? "Camera rejected by operator.");
            setErrorKind("pairing");
            setState("error");
            await stop({ preserveError: true });
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
            scheduleReconnect("receiver-error", msg.message, { kind: "receiver" });
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
    [
      acquirePreview,
      cameraAccessError,
      cleanupConnection,
      clearConnectionTimers,
      handleAutoStats,
      releasePreview,
      scheduleReconnect,
      stop,
      torchSupported,
      updateQualityFromTrack,
    ],
  );

  useEffect(() => {
    startOnceRef.current = startOnce;
  }, [startOnce]);

  const start = useCallback(
    async (params: StartParams): Promise<void> => {
      shouldStreamRef.current = true;
      setShouldStream(true);
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
      setReconnect({
        active: false,
        attempt: 0,
        delayMs: null,
        reason: null,
        nextAt: null,
      });
      startParamsRef.current = params;
      try {
        await startOnce(params);
      } catch (err) {
        if (!shouldStreamRef.current) throw err;
        if (isCameraPermissionDeniedError(err)) {
          shouldStreamRef.current = false;
          setShouldStream(false);
          startParamsRef.current = null;
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();
          setReconnect({
            active: false,
            attempt: 0,
            delayMs: null,
            reason: null,
            nextAt: null,
          });
          setError(CAMERA_PERMISSION_REQUIRED_MESSAGE);
          setErrorKind("camera");
          setState("error");
          throw err;
        }
        scheduleReconnect(
          "start-failed",
          (err as Error)?.message ?? "Failed to start stream; reconnecting.",
        );
      }
    },
    [clearReconnectTimer, scheduleReconnect, startOnce],
  );

  useEffect(() => {
    const reconnectNow = (reason: string) => {
      if (!shouldStreamRef.current || !startParamsRef.current) return;
      clearReconnectTimer();
      setReconnect((prev) => ({
        ...prev,
        active: true,
        delayMs: null,
        reason,
        nextAt: Date.now(),
      }));
      reconnectingRef.current = true;
      void startOnceRef.current(startParamsRef.current, { isReconnect: true }).finally(() => {
        reconnectingRef.current = false;
      });
    };
    const onOnline = () => reconnectNow("network-online");
    const onOffline = () => {
      if (shouldStreamRef.current) {
        scheduleReconnect("network-offline", "Network offline; reconnecting when available.");
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconnectNow("page-visible");
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [clearReconnectTimer, scheduleReconnect]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
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
    shouldStream,
    reconnect,
    errorKind,
    error,
    stream,
    stats,
    quality,
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
