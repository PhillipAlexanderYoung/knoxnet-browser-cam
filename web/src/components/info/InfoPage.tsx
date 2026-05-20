import { useEffect, useState } from "react";
import { ExternalLink, Info as InfoIcon, Lock, ShieldCheck } from "lucide-react";
import {
  DEFAULT_WIREGUARD_RECEIVER_URL,
  WIREGUARD_APP_STORE_URL,
  WIREGUARD_DEEP_LINK,
  WIREGUARD_GUIDE_URL,
} from "../../wireguard";
import "./InfoPage.css";

type PermissionResult = "granted" | "denied" | "prompt" | "unknown";

interface PermissionsState {
  camera: PermissionResult;
  microphone: PermissionResult;
  wakeLock: PermissionResult;
}

async function queryPermission(
  name: "camera" | "microphone",
): Promise<PermissionResult> {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return "unknown";
    const res = await navigator.permissions.query({
      name,
    } as unknown as PermissionDescriptor);
    return res.state as PermissionResult;
  } catch {
    return "unknown";
  }
}

export function InfoPage() {
  const [perms, setPerms] = useState<PermissionsState>({
    camera: "unknown",
    microphone: "unknown",
    wakeLock: "unknown",
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cam, mic] = await Promise.all([
        queryPermission("camera"),
        queryPermission("microphone"),
      ]);
      const wl: PermissionResult = "wakeLock" in navigator ? "granted" : "denied";
      if (cancelled) return;
      setPerms({ camera: cam, microphone: mic, wakeLock: wl });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="info-page">
      <div className="info-page__topbar">
        <span className="info-page__title">Info</span>
      </div>

      <div className="card">
        <div className="row">
          <div className="row__label">App</div>
          <div className="row__value">Knoxnet Browser Cam v0.1.0</div>
        </div>
        <div className="row">
          <div className="row__label">
            Purpose
            <span className="row__sublabel">
              Turn a phone browser into a LAN WebRTC camera for the Knoxnet VMS.
            </span>
          </div>
        </div>
      </div>

      <div className="section-header">Permissions</div>
      <div className="card">
        <PermissionRow label="Camera" state={perms.camera} />
        <PermissionRow label="Microphone" state={perms.microphone} />
        <PermissionRow label="Wake Lock" state={perms.wakeLock} />
      </div>

      <div className="section-header">Remote / WireGuard</div>
      <div className="card info-wireguard">
        <div className="info-wireguard__header">
          <ShieldCheck size={18} />
          <div>
            <div className="info-wireguard__title">Connect the VPN before remote camera use</div>
            <p>
              <code>cam.knoxnetvms.com</code> serves the static phone app only.
              The camera stream still needs a private path back to the receiver,
              so remote iPhones should join WireGuard first.
            </p>
          </div>
        </div>
        <ol className="info-wireguard__steps">
          <li>Install WireGuard for iPhone.</li>
          <li>Import the peer config or QR from the receiver machine.</li>
          <li>Turn on the VPN tunnel.</li>
          <li>Return here and use <code>{DEFAULT_WIREGUARD_RECEIVER_URL}</code>, or scan the receiver QR.</li>
        </ol>
        <div className="info-wireguard__actions">
          <a className="btn btn--primary" href={WIREGUARD_APP_STORE_URL} target="_blank" rel="noreferrer">
            Install WireGuard for iPhone
            <ExternalLink size={14} />
          </a>
          <a className="btn btn--ghost" href={WIREGUARD_DEEP_LINK}>
            Open WireGuard
          </a>
          <a className="btn btn--ghost" href={WIREGUARD_GUIDE_URL} target="_blank" rel="noreferrer">
            View setup guide
            <ExternalLink size={14} />
          </a>
        </div>
        <div className="callout callout--warning">
          <InfoIcon size={14} />
          <span>
            Only import configs you trust. WireGuard can grant VPN access to
            private receiver, bridge, RTSP, and VMS services.
          </span>
        </div>
      </div>

      <div className="section-header">Reality constraints</div>
      <div className="card">
        <div className="row">
          <div className="row__label">
            Browser camera limits
            <span className="row__sublabel">
              Browsers cannot expose RTSP/ONVIF directly, cannot read the
              device IP/MAC, and cannot assign static IP settings. WebRTC is
              used over the LAN; the Knoxnet VMS can later bridge the stream
              into RTSP via a sidecar restreamer (mediamtx / gstreamer /
              aiortc). See <code>docs/knoxnet-vms-integration.md</code>.
            </span>
          </div>
        </div>
        <div className="row">
          <div className="row__label">
            Local-only by design
            <span className="row__sublabel">
              Pairing code required, no anonymous open streaming, STUN-only
              (no TURN), random pairing code per receiver run. See
              <code> docs/security.md</code>.
            </span>
          </div>
          <Lock size={16} className="muted" />
        </div>
      </div>

      <div className="callout callout--info">
        <InfoIcon size={14} />
        <span>
          Frontend reads <code>?receiver</code> and <code>?pair</code> URL params
          on load. Video traffic stays on your LAN even when the static
          frontend is served from a public URL.
        </span>
      </div>
    </div>
  );
}

function PermissionRow({
  label,
  state,
}: {
  label: string;
  state: PermissionResult;
}) {
  const ok = state === "granted";
  const muted = state === "unknown";
  return (
    <div className="row">
      <div className="row__label">{label}</div>
      <div className="row__value">
        <span
          className={`pill ${ok ? "pill--green" : muted ? "pill--grey" : "pill--red"}`}
        >
          {state}
        </span>
      </div>
    </div>
  );
}
