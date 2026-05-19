import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Flashlight,
  Mic,
  MicOff,
  Video,
  Square,
} from "lucide-react";
import type { CameraStreamApi } from "../../webrtc/useCameraStream";
import type { ResolutionKey } from "../../webrtc/constraints";
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
}: CameraPageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const previewedFor = useRef<string>("");
  const autoStartAttempted = useRef(false);
  const manualStopRef = useRef(false);
  const hadActiveStreamRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const [reconnectDelayMs, setReconnectDelayMs] = useState<number | null>(null);
  const cameraAccessError = api.cameraAccessError;

  useEffect(() => {
    if (videoRef.current && api.stream) {
      videoRef.current.srcObject = api.stream;
    }
  }, [api.stream]);

  // Acquire a local preview as soon as the page mounts, so the user can see
  // their camera even before pressing record.
  useEffect(() => {
    const key = `${settings.preferredFacingMode}|${settings.preferredDeviceId ?? ""}|${settings.resolution}|${settings.frameRate}|${settings.audioEnabled}`;
    if (previewedFor.current === key) return;
    if (api.state === "streaming" || api.state === "connecting") return;
    if (cameraAccessError) {
      setPreviewActive(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setPermissionError(null);
        await api.acquirePreview({
          facingMode: settings.preferredFacingMode,
          deviceId: settings.preferredDeviceId,
          resolution: settings.resolution,
          frameRate: settings.frameRate,
          audioEnabled: settings.audioEnabled,
        });
        if (!cancelled) {
          previewedFor.current = key;
          setPreviewActive(true);
        }
      } catch (err) {
        if (!cancelled) {
          setPermissionError(
            (err as Error)?.message ??
              "Camera permission denied. Allow camera access and reload.",
          );
          setPreviewActive(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally re-run when these settings change.
  }, [
    api,
    cameraAccessError,
    settings.preferredFacingMode,
    settings.preferredDeviceId,
    settings.resolution,
    settings.frameRate,
    settings.audioEnabled,
  ]);

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
    manualStopRef.current = false;
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectDelayMs(null);
    setPermissionError(null);
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
      setPermissionError((err as Error)?.message ?? "Failed to start stream");
    }
  }, [api, cameraAccessError, clientDeviceId, settings]);

  const handleRecordToggle = useCallback(async () => {
    if (api.state === "connecting" || api.state === "searching") return;
    if (api.state === "streaming" || api.state === "paired") {
      manualStopRef.current = true;
      reconnectAttemptRef.current = 0;
      setReconnectDelayMs(null);
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      await api.stop();
      return;
    }
    await startStreaming();
  }, [api, startStreaming]);

  useEffect(() => {
    if (api.state === "streaming") {
      hadActiveStreamRef.current = true;
      reconnectAttemptRef.current = 0;
      setReconnectDelayMs(null);
      return;
    }
    if (api.state !== "disconnected" && api.state !== "error") return;
    if (!hadActiveStreamRef.current || manualStopRef.current) return;
    if (!settings.receiverUrl || !settings.pairingCode) return;
    if (reconnectTimerRef.current != null) return;
    const attempt = reconnectAttemptRef.current + 1;
    if (attempt > 5) {
      setReconnectDelayMs(null);
      return;
    }
    const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
    reconnectAttemptRef.current = attempt;
    setReconnectDelayMs(delay);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void startStreaming();
    }, delay);
  }, [
    api.state,
    settings.receiverUrl,
    settings.pairingCode,
    startStreaming,
  ]);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!autoStart || autoStartAttempted.current) return;
    if (!settings.receiverUrl || !settings.pairingCode) return;
    if (api.state !== "idle") return;
    autoStartAttempted.current = true;
    void startStreaming();
  }, [
    api.state,
    autoStart,
    settings.receiverUrl,
    settings.pairingCode,
    startStreaming,
  ]);

  const isStreaming = api.state === "streaming";
  const isBusy =
    api.state === "connecting" ||
    api.state === "searching" ||
    api.state === "negotiating" ||
    api.state === "paired";
  const isConnecting =
    api.state === "connecting" ||
    api.state === "searching" ||
    api.state === "negotiating";
  const trustReceiverUrl = useMemo(
    () => receiverTrustUrl(settings.receiverUrl),
    [settings.receiverUrl],
  );
  const showSignalingHelp =
    Boolean(api.error) && Boolean(settings.receiverUrl) && !cameraAccessError;

  const settingsResolution: ResolutionKey = settings.resolution;
  const liveResolutionLabel = useMemo(() => {
    const w = api.trackSettings?.width;
    const h = api.trackSettings?.height;
    if (typeof w === "number" && typeof h === "number") {
      if (h >= 1080) return "1080p";
      if (h >= 720) return "720p";
      if (h >= 480) return "480p";
      return `${h}p`;
    }
    return settingsResolution;
  }, [api.trackSettings, settingsResolution]);

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
        <section className="camera-callout" role="alert" aria-live="polite">
          <div className="camera-callout__title">
            <AlertTriangle size={18} />
            Camera access needs HTTPS or localhost
          </div>
          <p>
            Browser camera access requires a secure context. Opening this app
            from <code>http://&lt;LAN-IP&gt;:5173</code> will not prompt for
            camera permission on most mobile browsers.
          </p>
          <ul>
            <li>
              Run <code>npm run dev:https</code> and open{" "}
              <code>https://&lt;LAN-IP&gt;:5173</code> on the phone.
            </li>
            <li>
              For Chrome Android testing, add the HTTP LAN origin in{" "}
              <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>{" "}
              and relaunch Chrome.
            </li>
            <li>
              Or put a local TLS reverse proxy such as Caddy, nginx, or mkcert
              in front of the Vite dev server.
            </li>
          </ul>
        </section>
      )}

      {autoStart &&
        settings.receiverUrl &&
        settings.pairingCode &&
        !isStreaming &&
        !isBusy && (
          <section className="camera-callout camera-callout--start" aria-live="polite">
            <div className="camera-callout__title">
              <Video size={18} />
              Ready from pairing QR
            </div>
            <p>
              Receiver and pairing code are filled in. If iOS needs a user tap,
              use this button to allow camera access and start streaming.
            </p>
            <button
              type="button"
              className="camera-callout__button"
              onClick={() => void startStreaming()}
              disabled={Boolean(cameraAccessError) || isConnecting}
            >
              {isConnecting ? "Connecting…" : "Allow camera and start streaming"}
            </button>
          </section>
        )}

      {(api.state === "disconnected" || api.state === "error") &&
        hadActiveStreamRef.current &&
        !manualStopRef.current && (
          <section className="camera-callout camera-callout--compact" aria-live="polite">
            <div className="camera-callout__title">
              <Video size={16} />
              Receiver connection dropped
            </div>
            <div className="camera-callout__body">
              <p>
                {reconnectDelayMs
                  ? `Reconnecting in ${Math.ceil(reconnectDelayMs / 1000)}s.`
                  : "Reconnect when the receiver is back."}
              </p>
            </div>
            <button
              type="button"
              className="camera-callout__button camera-callout__button--secondary"
              onClick={() => void startStreaming()}
              disabled={Boolean(cameraAccessError) || isConnecting}
            >
              Reconnect now
            </button>
          </section>
        )}

      {showSignalingHelp && (
        <section
          className="camera-callout camera-callout--compact"
          role="alert"
          aria-live="polite"
        >
          <div className="camera-callout__title">
            <AlertTriangle size={16} />
            Receiver signaling failed
          </div>
          <div className="camera-callout__body">
            <p>
              Tried <code>{settings.receiverUrl}</code>.
              {trustReceiverUrl
                ? " Trust the receiver certificate, then return and start again."
                : ""}
            </p>
            {trustReceiverUrl && (
              <p>
                Opens <code>{trustReceiverUrl}</code>.
              </p>
            )}
          </div>
          {trustReceiverUrl && (
            <button
              type="button"
              className="camera-callout__button camera-callout__button--secondary"
              onClick={() => {
                window.location.href = trustReceiverUrl;
              }}
            >
              Trust receiver certificate
            </button>
          )}
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
            <span>Requesting camera…</span>
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

      {api.error && (
        <div className="errorbar">
          <AlertTriangle size={14} /> {api.error}
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
          aria-pressed={isStreaming}
          disabled={Boolean(cameraAccessError) || isConnecting}
          title={
            cameraAccessError ??
            (isConnecting
              ? "Connecting to receiver"
              : null) ??
            (isStreaming ? "Stop streaming" : "Start streaming")
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
              : api.state === "negotiating"
                ? "Negotiating…"
              : isBusy
                ? "Connecting…"
                : "Tap to Record"}
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
