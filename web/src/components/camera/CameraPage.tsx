import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Flashlight,
  Mic,
  MicOff,
  ShieldCheck,
  Video,
  Square,
} from "lucide-react";
import {
  CAMERA_PERMISSION_REQUIRED_MESSAGE,
  isCameraPermissionDeniedError,
  type CameraStreamApi,
} from "../../webrtc/useCameraStream";
import {
  resolutionModeLabel,
  type ResolutionMode,
} from "../../webrtc/constraints";
import type { CameraSettings } from "../../storage/storage";
import { Header } from "../Header";
import "./CameraPage.css";

interface CameraPageProps {
  api: CameraStreamApi;
  settings: CameraSettings;
  receiverName: string | null;
  onChangeAudio: (next: boolean) => void;
  autoStart: boolean;
  clientDeviceId: string;
  onDirectCamera: () => void;
  onDirectViewer: () => void;
}

function formatTrackBadge(settings: MediaTrackSettings | null): string | null {
  if (!settings) return null;
  const h = settings.height;
  if (typeof h !== "number") return null;
  if (h >= 1080) return "FHD";
  if (h >= 720) return "HD";
  if (h >= 480) return "SD";
  return `${h}p`;
}

function statusDotClass(state: CameraStreamApi["state"]): string {
  switch (state) {
    case "streaming":
      return "dot dot--green";
    case "paired":
    case "negotiating":
    case "searching":
    case "connecting":
      return "dot dot--amber";
    case "error":
      return "dot dot--red";
    case "disconnected":
      return "dot dot--red";
    default:
      return "dot dot--grey";
  }
}

function statusLabel(
  state: CameraStreamApi["state"],
  receiverName: string | null,
): string {
  switch (state) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting…";
    case "searching":
      return "Searching for receiver…";
    case "paired":
      return receiverName
        ? `Paired with ${receiverName} — waiting for operator…`
        : "Paired — waiting for operator…";
    case "negotiating":
      return receiverName
        ? `Negotiating media with ${receiverName}…`
        : "Negotiating media…";
    case "streaming":
      return receiverName ? `Streaming to ${receiverName}` : "Streaming";
    case "error":
      return "Connection error";
    case "disconnected":
      return "Disconnected";
    default:
      return state;
  }
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

function SignalBars({ strength }: { strength: number }) {
  const heights = [6, 9, 12, 15, 18];
  return (
    <span className="sigbars" aria-label={`Signal strength ${strength} of 5`}>
      {heights.map((h, idx) => (
        <span
          key={idx}
          className={`sigbars__bar ${idx < strength ? "sigbars__bar--on" : ""}`}
          style={{ height: `${h}px` }}
        />
      ))}
    </span>
  );
}

export function CameraPage({
  api,
  settings,
  receiverName,
  onChangeAudio,
  autoStart,
  clientDeviceId,
  onDirectCamera,
  onDirectViewer,
}: CameraPageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [cameraPermissionBlocked, setCameraPermissionBlocked] = useState(false);
  const [retryingCamera, setRetryingCamera] = useState(false);
  const [previewActive, setPreviewActive] = useState(false);
  const cameraAccessError = api.cameraAccessError;

  useEffect(() => {
    if (videoRef.current && api.stream) {
      videoRef.current.srcObject = api.stream;
    }
    setPreviewActive(Boolean(api.stream));
  }, [api.stream]);

  const startStreaming = useCallback(async () => {
    if (!settings.receiverUrl || !settings.pairingCode) {
      setPermissionError(
        "Set receiver URL and pairing code on the Network tab first.",
      );
      return;
    }
    if (cameraAccessError) {
      setPermissionError(cameraAccessError);
      return;
    }
    setPermissionError(null);
    setCameraPermissionBlocked(false);
    try {
      await api.start({
        receiverUrl: settings.receiverUrl,
        pairingCode: settings.pairingCode,
        name: settings.cameraName,
        clientDeviceId,
        resolution: settings.resolution,
        frameRate: settings.frameRate,
        audioEnabled: settings.audioEnabled,
        facingMode: settings.preferredFacingMode,
        deviceId: settings.preferredDeviceId,
        maxBitrateKbps: settings.bitrateKbps,
      });
    } catch (err) {
      const blocked = isCameraPermissionDeniedError(err);
      setCameraPermissionBlocked(blocked);
      setPermissionError(
        blocked
          ? CAMERA_PERMISSION_REQUIRED_MESSAGE
          : (err as Error)?.message ?? "Failed to start stream",
      );
    }
  }, [api, cameraAccessError, clientDeviceId, settings]);

  const retryCameraAccess = useCallback(async () => {
    if (retryingCamera) return;
    setRetryingCamera(true);
    setPermissionError(null);
    setCameraPermissionBlocked(false);
    setPreviewActive(false);
    try {
      if (autoStart && settings.receiverUrl && settings.pairingCode) {
        await startStreaming();
        return;
      }
      await api.acquirePreview({
        facingMode: settings.preferredFacingMode,
        deviceId: settings.preferredDeviceId,
        resolution: settings.resolution,
        frameRate: settings.frameRate,
        audioEnabled: settings.audioEnabled,
      });
      setPreviewActive(true);
    } catch (err) {
      const blocked = isCameraPermissionDeniedError(err);
      setCameraPermissionBlocked(blocked);
      setPermissionError(
        blocked
          ? CAMERA_PERMISSION_REQUIRED_MESSAGE
          : (err as Error)?.message ?? "Could not access camera",
      );
      setPreviewActive(false);
    } finally {
      setRetryingCamera(false);
    }
  }, [api, autoStart, retryingCamera, settings, startStreaming]);

  const handleRecordToggle = useCallback(async () => {
    if (api.shouldStream) {
      await api.stop();
      return;
    }
    await startStreaming();
  }, [api, startStreaming]);

  const isStreaming = api.state === "streaming";
  const isBusy =
    api.state === "connecting" ||
    api.state === "searching" ||
    api.state === "negotiating" ||
    api.state === "paired";
  const reconnectDelayMs = api.reconnect.delayMs;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!api.reconnect.active || api.reconnect.nextAt == null) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [api.reconnect.active, api.reconnect.nextAt]);
  const trustReceiverUrl = useMemo(
    () => receiverTrustUrl(settings.receiverUrl),
    [settings.receiverUrl],
  );
  const reconnectSeconds = api.reconnect.nextAt
    ? Math.max(0, Math.ceil((api.reconnect.nextAt - nowMs) / 1000))
    : reconnectDelayMs
      ? Math.ceil(reconnectDelayMs / 1000)
      : null;
  const showReconnectStatus =
    api.shouldStream &&
    (api.state === "disconnected" || api.state === "error") &&
    api.errorKind !== "camera" &&
    api.errorKind !== "certificate";
  const showCertificateHelp =
    api.shouldStream &&
    api.errorKind === "certificate" &&
    Boolean(trustReceiverUrl) &&
    !cameraAccessError;
  const showPairingError =
    api.errorKind === "pairing" && Boolean(api.error) && !cameraAccessError;
  const showGenericError =
    Boolean(api.error) &&
    api.errorKind !== "camera" &&
    api.errorKind !== "connection" &&
    api.errorKind !== "certificate" &&
    api.errorKind !== "pairing";

  const settingsResolution: ResolutionMode = settings.resolution;
  const liveResolutionLabel = useMemo(() => {
    const w = api.trackSettings?.width;
    const h = api.trackSettings?.height;
    const current =
      typeof h === "number"
        ? h >= 1080
          ? "1080p"
          : h >= 720
            ? "720p"
            : h >= 480
              ? "480p"
              : `${h}p`
        : api.quality.currentResolution;
    if (settingsResolution === "auto") {
      const currentResolution =
        current === "480p" || current === "720p" || current === "1080p"
          ? current
          : api.quality.currentResolution;
      return resolutionModeLabel("auto", currentResolution);
    }
    if (typeof w === "number" && typeof h === "number") {
      if (h >= 1080) return "1080p";
      if (h >= 720) return "720p";
      if (h >= 480) return "480p";
      return `${h}p`;
    }
    return settingsResolution;
  }, [api.trackSettings, api.quality.currentResolution, settingsResolution]);

  const liveFpsLabel = useMemo(() => {
    const fps = api.trackSettings?.frameRate;
    if (typeof fps === "number") return `${Math.round(fps)}fps`;
    if (typeof api.stats?.framesPerSecond === "number") {
      return `${Math.round(api.stats.framesPerSecond)}fps`;
    }
    return `${settings.frameRate}fps`;
  }, [api.trackSettings, api.stats, settings.frameRate]);

  const badge = formatTrackBadge(api.trackSettings);

  // Derive 0..5 signal strength from RTT + loss.
  const signalStrength = useMemo(() => {
    if (!api.stats || !isStreaming) return 0;
    const rtt = api.stats.rttMs;
    const loss = api.stats.fractionLost;
    let s = 5;
    if (rtt != null) {
      if (rtt > 60) s -= 1;
      if (rtt > 120) s -= 1;
      if (rtt > 250) s -= 1;
      if (rtt > 500) s -= 1;
    }
    if (loss > 0.02) s -= 1;
    if (loss > 0.08) s -= 1;
    return Math.max(1, Math.min(5, s));
  }, [api.stats, isStreaming]);

  const bitrateLabel = useMemo(() => {
    if (!api.stats) return null;
    const k = api.stats.bitrateKbps;
    if (k <= 0) return null;
    if (k >= 1000) return `${(k / 1000).toFixed(1)} Mbps`;
    return `${k} Kbps`;
  }, [api.stats]);

  return (
    <div className="camera-page">
      <Header live={isStreaming} />

      {cameraAccessError && (
        <section
          className="camera-callout camera-callout--compact camera-callout--error"
          role="alert"
          aria-live="polite"
        >
          <div className="camera-callout__title">
            <AlertTriangle size={16} />
            Camera access needs HTTPS or localhost
          </div>
          <div className="camera-callout__body">
            <p>
              Camera access requires HTTPS or localhost. Open the phone app from
              the secure dev URL, for example{" "}
              <code>https://&lt;LAN-IP&gt;:5173</code>.
            </p>
          </div>
        </section>
      )}

      {cameraPermissionBlocked && !cameraAccessError && (
        <section
          className="camera-callout camera-callout--compact camera-callout--error"
          role="alert"
          aria-live="polite"
        >
          <div className="camera-callout__title">
            <AlertTriangle size={16} />
            Camera permission required
          </div>
          <div className="camera-callout__body">
            <p>{CAMERA_PERMISSION_REQUIRED_MESSAGE}</p>
          </div>
          <button
            type="button"
            className="camera-callout__button camera-callout__button--secondary"
            onClick={() => void retryCameraAccess()}
            disabled={retryingCamera}
          >
            {retryingCamera ? "Retrying..." : "Retry camera access"}
          </button>
        </section>
      )}

      {showReconnectStatus && (
        <section className="camera-callout camera-callout--compact" aria-live="polite">
          <div className="camera-callout__title">
            <Video size={16} />
            Receiver disconnected
          </div>
          <div className="camera-callout__body">
            <p>
              {reconnectSeconds != null && reconnectSeconds > 0
                ? `Receiver disconnected. Reconnecting in ${reconnectSeconds}s...`
                : "Receiver disconnected. Reconnecting now..."}
            </p>
            {api.reconnect.attempt >= 5 && (
              <p>Repeated failures: consider lowering FPS, bitrate, or resolution.</p>
            )}
          </div>
          <div className="camera-callout__actions">
            <button
              type="button"
              className="camera-callout__button camera-callout__button--secondary"
              onClick={() => void startStreaming()}
              disabled={Boolean(cameraAccessError)}
            >
              Reconnect now
            </button>
            <button
              type="button"
              className="camera-callout__button camera-callout__button--secondary"
              onClick={() => void api.stop()}
            >
              Stop
            </button>
          </div>
        </section>
      )}

      {showCertificateHelp && (
        <section
          className="camera-callout camera-callout--compact camera-callout--hint"
          role="alert"
          aria-live="polite"
        >
          <div className="camera-callout__title">
            <AlertTriangle size={16} />
            Secure receiver connection blocked?
          </div>
          <div className="camera-callout__body">
            <p>
              If this is the first time connecting, open the receiver dashboard once to trust its certificate.
            </p>
            <p>
              Tried <code>{settings.receiverUrl}</code>.
            </p>
          </div>
          <div className="camera-callout__actions">
            <button
              type="button"
              className="camera-callout__button camera-callout__button--secondary"
              onClick={() => {
                if (trustReceiverUrl) window.location.href = trustReceiverUrl;
              }}
            >
              Open dashboard
            </button>
            <button
              type="button"
              className="camera-callout__button camera-callout__button--secondary"
              onClick={() => void api.stop()}
            >
              Stop
            </button>
          </div>
        </section>
      )}

      {showPairingError && (
        <section
          className="camera-callout camera-callout--compact camera-callout--error"
          role="alert"
          aria-live="polite"
        >
          <div className="camera-callout__title">
            <AlertTriangle size={16} />
            Pairing rejected
          </div>
          <div className="camera-callout__body">
            <p>{api.error}</p>
            <p>Check the receiver pairing code, then start again.</p>
          </div>
        </section>
      )}

      <div className={`videoframe ${isStreaming ? "videoframe--live" : ""}`}>
        <video
          ref={videoRef}
          className="videoframe__video"
          autoPlay
          playsInline
          muted
        />
        {!previewActive && !permissionError && !cameraAccessError && (
          <div className="videoframe__placeholder">
            <Video size={32} strokeWidth={1.5} />
            <span>Tap Connect to start camera</span>
          </div>
        )}
        {(permissionError || cameraAccessError) && (
          <div className="videoframe__placeholder videoframe__placeholder--error">
            <AlertTriangle size={26} strokeWidth={1.75} />
            <span>{permissionError ?? cameraAccessError}</span>
          </div>
        )}
        {badge && (
          <span className="videoframe__badge">{badge}</span>
        )}
        {isStreaming && (
          <span className="videoframe__signal">
            <SignalBars strength={signalStrength} />
          </span>
        )}
      </div>

      <div className="statusrow">
        <span className="statusrow__left">
          <span className={statusDotClass(api.state)} />
          <span className="statusrow__text">
            {statusLabel(api.state, receiverName)}
          </span>
        </span>
        <span className="statusrow__right">
          {liveResolutionLabel} • {liveFpsLabel}
          {bitrateLabel ? ` • ${bitrateLabel}` : ""}
        </span>
      </div>

      <section className="mode-picker" aria-label="Camera mode">
        <div className="mode-picker__summary">
          <div className="mode-picker__title">
            <ShieldCheck size={14} />
            Mode
          </div>
          <p>
            Receiver mode keeps video direct/private on LAN or WireGuard.
            {autoStart ? " QR receiver detected; tap Connect to start." : ""}
          </p>
        </div>
        <div className="mode-picker__actions" role="group" aria-label="Mode options">
          <button type="button" className="mode-picker__button mode-picker__button--active">
            Receiver
          </button>
          <button type="button" className="mode-picker__button" onClick={onDirectCamera}>
            Share
          </button>
          <button type="button" className="mode-picker__button" onClick={onDirectViewer}>
            View
          </button>
        </div>
      </section>

      {showGenericError && (
        <div className="errorbar">
          <AlertTriangle size={14} /> {api.error}
        </div>
      )}

      {api.quality.message && (
        <div className="errorbar">
          <Video size={14} /> {api.quality.message}
        </div>
      )}

      <div className="controls">
        <button
          type="button"
          className={`ctrl ${settings.audioEnabled ? "ctrl--on" : ""}`}
          onClick={() => onChangeAudio(!settings.audioEnabled)}
          aria-pressed={settings.audioEnabled}
        >
          <span className="ctrl__icon">
            {settings.audioEnabled ? (
              <Mic size={26} strokeWidth={1.9} />
            ) : (
              <MicOff size={26} strokeWidth={1.9} />
            )}
          </span>
          <span className="ctrl__label">Audio</span>
        </button>

        <button
          type="button"
          className={`record ${isStreaming ? "record--on" : ""} ${isBusy ? "record--busy" : ""}`}
          onClick={handleRecordToggle}
          aria-pressed={api.shouldStream}
          disabled={Boolean(cameraAccessError)}
          title={
            cameraAccessError ??
            (api.shouldStream ? "Stop streaming" : "Start streaming")
          }
        >
          <span className="record__ring" aria-hidden="true" />
          <span className="record__icon">
            {isStreaming ? (
              <Square size={28} strokeWidth={2} fill="#0a0b0d" />
            ) : (
              <Video size={28} strokeWidth={2} />
            )}
          </span>
          <span className="record__label">
            {isStreaming
              ? "Tap to Stop"
              : api.shouldStream
                ? "Tap to Stop"
              : api.state === "negotiating"
                ? "Negotiating…"
              : isBusy
                ? "Connecting…"
                : "Connect"}
          </span>
        </button>

        <button
          type="button"
          className={`ctrl ${api.torchOn ? "ctrl--on" : ""}`}
          onClick={() => void api.toggleTorch()}
          disabled={!api.torchSupported}
          title={
            api.torchSupported
              ? "Toggle flashlight"
              : "Flashlight not supported on this device"
          }
          aria-pressed={api.torchOn}
        >
          <span className="ctrl__icon">
            <Flashlight size={26} strokeWidth={1.9} />
          </span>
          <span className="ctrl__label">Flash</span>
        </button>
      </div>
    </div>
  );
}
