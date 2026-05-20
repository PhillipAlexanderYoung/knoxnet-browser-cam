import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraPage } from "./components/camera/CameraPage";
import {
  NetworkPage,
  type ReceiverInfo,
} from "./components/network/NetworkPage";
import { InfoPage } from "./components/info/InfoPage";
import { TabBar, type TabKey } from "./components/TabBar";
import { Toast } from "./components/common/Toast";
import { DirectViewCamera } from "./direct-view/DirectViewCamera";
import { DirectViewViewer } from "./direct-view/DirectViewViewer";
import {
  DEFAULT_SETTINGS,
  getOrCreateDeviceId,
  loadSettings,
  saveSettings,
  type CameraSettings,
} from "./storage/storage";
import { useCameraStream } from "./webrtc/useCameraStream";

function urlSettingsOverride(base: CameraSettings): CameraSettings {
  try {
    const params = new URLSearchParams(window.location.search);
    const receiver = params.get("receiver");
    const pair = params.get("pair");
    if (!receiver && !pair) return base;
    return {
      ...base,
      receiverUrl: receiver?.trim() || base.receiverUrl,
      pairingCode: pair?.trim().toUpperCase() || base.pairingCode,
    };
  } catch {
    return base;
  }
}

function urlWantsAutostart(): boolean {
  try {
    const value = new URLSearchParams(window.location.search).get("autostart");
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

function deriveReceiverHttpFromWs(ws: string): string | null {
  try {
    if (!ws) return null;
    const u = new URL(ws);
    const httpScheme = u.protocol === "wss:" ? "https:" : "http:";
    return `${httpScheme}//${u.host}`;
  } catch {
    return null;
  }
}

export default function App() {
  const [tab, setTab] = useState<TabKey>("camera");
  const [directMode, setDirectMode] = useState<"camera" | "viewer" | null>(null);
  const [joinToken, setJoinToken] = useState<string | null>(() => {
    const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  });
  const [settings, setSettings] = useState<CameraSettings>(() =>
    urlSettingsOverride({ ...DEFAULT_SETTINGS, ...loadSettings() }),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [receiverInfo, setReceiverInfo] = useState<ReceiverInfo | null>(null);
  const [autoStart] = useState(urlWantsAutostart);
  const [clientDeviceId] = useState(getOrCreateDeviceId);
  const api = useCameraStream();

  // Persist initial URL-derived settings (so they survive a reload).
  const persistedOnce = useRef(false);
  useEffect(() => {
    if (persistedOnce.current) return;
    persistedOnce.current = true;
    saveSettings(settings);
  }, [settings]);

  // Apply track-level constraints live while streaming when relevant settings change.
  useEffect(() => {
    if (api.state !== "streaming") return;
    void api.applyTrackConstraints({
      resolution: settings.resolution,
      frameRate: settings.frameRate,
    });
  }, [api, api.state, settings.resolution, settings.frameRate]);

  useEffect(() => {
    if (api.state !== "streaming") return;
    void api.applyMaxBitrate(settings.bitrateKbps);
  }, [api, api.state, settings.bitrateKbps]);

  // Live-mute audio while streaming if user toggles audio off (and vice versa).
  useEffect(() => {
    if (!api.stream) return;
    for (const t of api.stream.getAudioTracks()) {
      t.enabled = settings.audioEnabled;
    }
  }, [api.stream, settings.audioEnabled]);

  // Periodically fetch receiver info if a URL is configured.
  useEffect(() => {
    const http = deriveReceiverHttpFromWs(settings.receiverUrl);
    if (!http) {
      setReceiverInfo(null);
      return;
    }
    let cancelled = false;
    const tryFetch = async () => {
      try {
        const res = await fetch(`${http}/api/info`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as ReceiverInfo;
        if (!cancelled) setReceiverInfo(json);
      } catch {
        if (!cancelled) setReceiverInfo(null);
      }
    };
    void tryFetch();
    const id = window.setInterval(tryFetch, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [settings.receiverUrl]);

  // Announce on discoverable toggle / start. Best-effort, requires receiver+pair.
  useEffect(() => {
    if (!settings.discoverable) return;
    if (!settings.receiverUrl || !settings.pairingCode) return;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(settings.receiverUrl);
      ws.onopen = () => {
        ws?.send(
          JSON.stringify({
            type: "announce",
            name: settings.cameraName,
            deviceId: clientDeviceId,
            pairingCode: settings.pairingCode,
            discoverable: true,
            quality: api.quality,
          }),
        );
        ws?.close();
      };
      ws.onerror = () => {
        ws?.close();
      };
    } catch {
      // ignore
    }
    return () => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [
    settings.discoverable,
    settings.receiverUrl,
    settings.pairingCode,
    settings.cameraName,
    clientDeviceId,
  ]);

  // Wake lock while the user wants streaming; browsers may drop it on background.
  useEffect(() => {
    if (!api.shouldStream) return;
    type SentinelLike = { release: () => Promise<void> };
    let lock: SentinelLike | null = null;
    let cancelled = false;
    const requestLock = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const wl = (navigator as Navigator & {
          wakeLock?: { request: (t: string) => Promise<SentinelLike> };
        }).wakeLock;
        if (wl && typeof wl.request === "function") {
          if (lock) {
            try {
              await lock.release();
            } catch {
              // ignore
            }
          }
          lock = await wl.request("screen");
        }
      } catch {
        // ignore
      }
      if (cancelled && lock) {
        try {
          await lock.release();
        } catch {
          // ignore
        }
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void requestLock();
    };
    void requestLock();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (lock) {
        try {
          void lock.release();
        } catch {
          // ignore
        }
      }
    };
  }, [api.shouldStream, api.state]);

  const onChangeSettings = useCallback((next: CameraSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const handleSave = useCallback(() => {
    saveSettings(settings);
    setToast("Settings saved");
  }, [settings]);

  const onChangeAudio = useCallback(
    (next: boolean) => {
      onChangeSettings({ ...settings, audioEnabled: next });
    },
    [onChangeSettings, settings],
  );

  const receiverName = useMemo(
    () => receiverInfo?.name ?? null,
    [receiverInfo],
  );

  const leaveDirectView = useCallback(() => {
    if (joinToken) {
      window.history.pushState({}, "", "/");
      setJoinToken(null);
    }
    setDirectMode(null);
    setTab("camera");
  }, [joinToken]);

  if (joinToken) {
    return (
      <div className="app-shell">
        <DirectViewViewer roomToken={joinToken} onBack={leaveDirectView} />
        <Toast message={toast} onDone={() => setToast(null)} />
      </div>
    );
  }

  if (directMode === "camera") {
    return (
      <div className="app-shell">
        <DirectViewCamera onBack={leaveDirectView} />
        <Toast message={toast} onDone={() => setToast(null)} />
      </div>
    );
  }

  if (directMode === "viewer") {
    return (
      <div className="app-shell">
        <DirectViewViewer onBack={leaveDirectView} />
        <Toast message={toast} onDone={() => setToast(null)} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {tab === "camera" && (
        <CameraPage
          api={api}
          settings={settings}
          receiverName={receiverName}
          onChangeAudio={onChangeAudio}
          autoStart={autoStart}
          clientDeviceId={clientDeviceId}
          onDirectCamera={() => setDirectMode("camera")}
          onDirectViewer={() => setDirectMode("viewer")}
        />
      )}
      {tab === "network" && (
        <NetworkPage
          settings={settings}
          onChange={onChangeSettings}
          onSave={handleSave}
          onBack={() => setTab("camera")}
          receiverInfo={receiverInfo}
          signalingState={api.state}
          currentResolution={api.quality.currentResolution}
        />
      )}
      {tab === "info" && <InfoPage />}
      <Toast message={toast} onDone={() => setToast(null)} />
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
