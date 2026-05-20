import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Info as InfoIcon,
  Save,
  ShieldCheck,
} from "lucide-react";
import { Toggle } from "../common/Toggle";
import { SegmentedControl } from "../common/SegmentedControl";
import { BottomSheet, SheetOption } from "../common/BottomSheet";
import type { CameraSettings } from "../../storage/storage";
import type { ConnectionState } from "../../webrtc/signaling-client";
import {
  BITRATE_OPTIONS,
  FRAME_RATE_OPTIONS,
  RESOLUTION_PRESETS,
  bitrateLabel,
  isManualResolution,
  resolutionModeLabel,
  type BitrateKbps,
  type FrameRate,
  type ResolutionKey,
  type ResolutionMode,
} from "../../webrtc/constraints";
import {
  DEFAULT_WIREGUARD_RECEIVER_URL,
  WIREGUARD_APP_STORE_URL,
  WIREGUARD_DEEP_LINK,
  WIREGUARD_GUIDE_URL,
} from "../../wireguard";
import "./NetworkPage.css";

export interface ReceiverInfo {
  ok: boolean;
  name: string;
  httpPort: number;
  wsPath: string;
  publicHost: string;
  pairingCode: string;
  phonePairingUrl?: string;
  pairingUrl: string;
  dashboardUrl?: string;
  receiverWsUrl?: string;
  phoneAppUrl?: string;
  bridgeUrl?: string;
  tls?: boolean;
  ts: string;
}

interface NetworkPageProps {
  settings: CameraSettings;
  onChange: (next: CameraSettings) => void;
  onSave: () => void;
  onBack: () => void;
  receiverInfo: ReceiverInfo | null;
  signalingState: ConnectionState;
  currentResolution?: ResolutionKey;
}

const RESOLUTION_OPTS: { value: ResolutionMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "480p", label: "854 x 480 (SD)" },
  { value: "720p", label: "1280 x 720 (HD)" },
  { value: "1080p", label: "1920 x 1080 (FHD)" },
];

export function NetworkPage({
  settings,
  onChange,
  onSave,
  onBack,
  receiverInfo,
  signalingState,
  currentResolution,
}: NetworkPageProps) {
  const [showSheet, setShowSheet] = useState<
    | null
    | "name"
    | "resolution"
    | "fps"
    | "bitrate"
    | "receiver"
    | "vpnReceiver"
    | "pair"
  >(null);
  const [draftName, setDraftName] = useState(settings.cameraName);
  const [draftReceiver, setDraftReceiver] = useState(settings.receiverUrl);
  const [draftVpnReceiver, setDraftVpnReceiver] = useState(
    settings.vpnReceiverUrl ?? DEFAULT_WIREGUARD_RECEIVER_URL,
  );
  const [draftPair, setDraftPair] = useState(settings.pairingCode);

  useEffect(() => setDraftName(settings.cameraName), [settings.cameraName]);
  useEffect(() => setDraftReceiver(settings.receiverUrl), [settings.receiverUrl]);
  useEffect(
    () => setDraftVpnReceiver(settings.vpnReceiverUrl ?? DEFAULT_WIREGUARD_RECEIVER_URL),
    [settings.vpnReceiverUrl],
  );
  useEffect(() => setDraftPair(settings.pairingCode), [settings.pairingCode]);

  const resolutionLabel = useMemo(
    () =>
      isManualResolution(settings.resolution)
        ? RESOLUTION_PRESETS[settings.resolution].label
        : resolutionModeLabel("auto", currentResolution),
    [currentResolution, settings.resolution],
  );

  const connectionLabel = (() => {
    switch (signalingState) {
      case "streaming":
        return "Streaming";
      case "paired":
      case "negotiating":
      case "searching":
      case "connecting":
        return "Paired";
      case "error":
      case "disconnected":
        return "Disconnected";
      default:
        return "Idle";
    }
  })();
  const vpnReceiverUrl = settings.vpnReceiverUrl?.trim() || DEFAULT_WIREGUARD_RECEIVER_URL;

  return (
    <div className="network-page">
      <div className="network-page__topbar">
        <button
          type="button"
          className="iconbtn"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <span className="network-page__title">Network Settings</span>
        <span className="iconbtn iconbtn--ghost" aria-hidden="true" />
      </div>

      <div className="card">
        <div
          className="row"
          role="button"
          tabIndex={0}
          onClick={() => setShowSheet("name")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setShowSheet("name");
          }}
        >
          <div className="row__label">Camera Name</div>
          <div className="row__value">
            {settings.cameraName || "—"}
            <ChevronRight size={16} className="chev" />
          </div>
        </div>

        <div className="row">
          <div className="row__label">
            Make Discoverable
            <span className="row__sublabel">
              Allow Knoxnet VMS to find this camera
            </span>
          </div>
          <Toggle
            checked={settings.discoverable}
            onChange={(v) => onChange({ ...settings, discoverable: v })}
            ariaLabel="Make discoverable"
          />
        </div>
      </div>

      <div className="section-header">Pairing</div>
      <div className="card">
        <div
          className="row"
          role="button"
          tabIndex={0}
          onClick={() => setShowSheet("receiver")}
        >
          <div className="row__label">
            Receiver URL
            <span className="row__sublabel">WebSocket signaling endpoint</span>
          </div>
          <div className="row__value">
            <span className="ellipsize">
              {settings.receiverUrl || "Not set"}
            </span>
            <ChevronRight size={16} className="chev" />
          </div>
        </div>
        <div
          className="row"
          role="button"
          tabIndex={0}
          onClick={() => setShowSheet("pair")}
        >
          <div className="row__label">
            Pairing Code
            <span className="row__sublabel">
              From the receiver dashboard
            </span>
          </div>
          <div className="row__value">
            {settings.pairingCode || "Not set"}
            <ChevronRight size={16} className="chev" />
          </div>
        </div>
        <div className="row">
          <div className="row__label">
            Connection
            <span className="row__sublabel">{connectionLabel}</span>
          </div>
          <div className="row__value">
            {receiverInfo?.name ?? "—"}
          </div>
        </div>
      </div>

      <div className="section-header">Remote / WireGuard</div>
      <div className="card wireguard-card">
        <div className="wireguard-card__heading">
          <ShieldCheck size={18} />
          <div>
            <div className="wireguard-card__title">Remote phone? Connect WireGuard first.</div>
            <p>
              Cloudflare hosts only the app shell at <code>cam.knoxnetvms.com</code>.
              For remote camera use, connect this iPhone to the receiver/VMS
              network with WireGuard before pairing.
            </p>
          </div>
        </div>

        <ol className="wireguard-steps">
          <li>Install the WireGuard app.</li>
          <li>Import the peer config or QR generated on the receiver machine.</li>
          <li>Turn on the VPN tunnel.</li>
          <li>Return here and use receiver URL <code>{vpnReceiverUrl}</code>, or scan the receiver QR.</li>
        </ol>

        <div className="wireguard-actions">
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

        <div className="row wireguard-row" role="button" tabIndex={0} onClick={() => setShowSheet("vpnReceiver")}>
          <div className="row__label">
            VPN Receiver URL
            <span className="row__sublabel">Use after the WireGuard tunnel is on</span>
          </div>
          <div className="row__value">
            <span className="ellipsize">{vpnReceiverUrl}</span>
            <ChevronRight size={16} className="chev" />
          </div>
        </div>
        <button
          type="button"
          className="btn btn--ghost wireguard-card__use"
          onClick={() => onChange({ ...settings, receiverUrl: vpnReceiverUrl })}
        >
          Use VPN URL as Receiver URL
        </button>

        <div className="callout wireguard-warning">
          <InfoIcon size={14} />
          <span>
            Only import WireGuard configs you trust. A VPN peer config can grant
            access to private receiver, bridge, RTSP, and VMS services.
          </span>
        </div>
      </div>

      <div className="section-header">Network Mode</div>
      <SegmentedControl
        value={settings.networkMode}
        ariaLabel="Network mode"
        options={[
          { value: "dhcp", label: "DHCP" },
          { value: "static", label: "Static" },
        ]}
        onChange={(v) => onChange({ ...settings, networkMode: v })}
      />
      <div className="callout">
        <InfoIcon size={14} />
        <span>
          Browsers cannot assign IP settings to the phone. These values are
          stored as preferences only and are not applied to the device — configure
          DHCP / static IP in your phone's Wi-Fi settings.
        </span>
      </div>

      <div className="card">
        <NetworkRow
          label="IP Address"
          value={receiverInfo?.publicHost ?? "—"}
          editable={settings.networkMode === "static"}
          fieldValue={settings.staticIp ?? ""}
          placeholder="192.168.1.120"
          onFieldChange={(v) => onChange({ ...settings, staticIp: v })}
        />
        <NetworkRow
          label="Subnet Mask"
          value="—"
          editable={settings.networkMode === "static"}
          fieldValue={settings.staticSubnet ?? ""}
          placeholder="255.255.255.0"
          onFieldChange={(v) => onChange({ ...settings, staticSubnet: v })}
        />
        <NetworkRow
          label="Gateway"
          value="—"
          editable={settings.networkMode === "static"}
          fieldValue={settings.staticGateway ?? ""}
          placeholder="192.168.1.1"
          onFieldChange={(v) => onChange({ ...settings, staticGateway: v })}
        />
        <NetworkRow
          label="DNS"
          value="—"
          editable={settings.networkMode === "static"}
          fieldValue={settings.staticDns ?? ""}
          placeholder="192.168.1.1"
          onFieldChange={(v) => onChange({ ...settings, staticDns: v })}
        />
      </div>

      <div className="section-header">Stream Settings</div>
      <div className="card">
        <div
          className="row"
          role="button"
          tabIndex={0}
          onClick={() => setShowSheet("resolution")}
        >
          <div className="row__label">Resolution</div>
          <div className="row__value">
            {resolutionLabel}
            <ChevronRight size={16} className="chev" />
          </div>
        </div>
        <div
          className="row"
          role="button"
          tabIndex={0}
          onClick={() => setShowSheet("fps")}
        >
          <div className="row__label">Frame Rate</div>
          <div className="row__value">
            {settings.frameRate} FPS
            <ChevronRight size={16} className="chev" />
          </div>
        </div>
        <div
          className="row"
          role="button"
          tabIndex={0}
          onClick={() => setShowSheet("bitrate")}
        >
          <div className="row__label">Bitrate</div>
          <div className="row__value">
            {bitrateLabel(settings.bitrateKbps)}
            <ChevronRight size={16} className="chev" />
          </div>
        </div>
      </div>

      <div className="section-header">Advanced</div>
      <div className="card">
        <div className="row">
          <div className="row__label">Port (HTTP)</div>
          <div className="row__value">
            {receiverInfo?.httpPort ?? "—"}
          </div>
        </div>
        <div className="row">
          <div className="row__label">
            Port (RTSP)
            <span className="row__sublabel rtsp-note">
              Browser cameras cannot expose RTSP directly — bridge via Knoxnet
              VMS receiver. See docs/knoxnet-vms-integration.md.
            </span>
          </div>
          <div className="row__value muted">554</div>
        </div>
      </div>

      <button
        type="button"
        className="btn btn--primary network-page__save"
        onClick={onSave}
      >
        <Save size={16} />
        Save Settings
      </button>

      <BottomSheet
        open={showSheet === "name"}
        title="Camera Name"
        onClose={() => setShowSheet(null)}
      >
        <input
          autoFocus
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="phone-cam-xxxx"
        />
        <div className="sheet__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onChange({ ...settings, cameraName: draftName.trim() });
              setShowSheet(null);
            }}
          >
            Save
          </button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={showSheet === "receiver"}
        title="Receiver URL"
        onClose={() => setShowSheet(null)}
      >
        <input
          autoFocus
          value={draftReceiver}
          onChange={(e) => setDraftReceiver(e.target.value)}
          placeholder="ws://192.168.1.50:8787/ws"
        />
        <div className="sheet__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onChange({ ...settings, receiverUrl: draftReceiver.trim() });
              setShowSheet(null);
            }}
          >
            Save
          </button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={showSheet === "vpnReceiver"}
        title="VPN Receiver URL"
        onClose={() => setShowSheet(null)}
      >
        <input
          autoFocus
          value={draftVpnReceiver}
          onChange={(e) => setDraftVpnReceiver(e.target.value)}
          placeholder={DEFAULT_WIREGUARD_RECEIVER_URL}
        />
        <div className="sheet__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onChange({ ...settings, vpnReceiverUrl: draftVpnReceiver.trim() || DEFAULT_WIREGUARD_RECEIVER_URL });
              setShowSheet(null);
            }}
          >
            Save
          </button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={showSheet === "pair"}
        title="Pairing Code"
        onClose={() => setShowSheet(null)}
      >
        <input
          autoFocus
          value={draftPair}
          onChange={(e) => setDraftPair(e.target.value.toUpperCase())}
          placeholder="ABC123"
          autoCapitalize="characters"
        />
        <div className="sheet__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onChange({ ...settings, pairingCode: draftPair.trim() });
              setShowSheet(null);
            }}
          >
            Save
          </button>
        </div>
      </BottomSheet>

      <BottomSheet
        open={showSheet === "resolution"}
        title="Resolution"
        onClose={() => setShowSheet(null)}
      >
        {RESOLUTION_OPTS.map((opt) => (
          <SheetOption
            key={opt.value}
            active={settings.resolution === opt.value}
            label={opt.label}
            onClick={() => {
              onChange({ ...settings, resolution: opt.value });
              setShowSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      <BottomSheet
        open={showSheet === "fps"}
        title="Frame Rate"
        onClose={() => setShowSheet(null)}
      >
        {FRAME_RATE_OPTIONS.map((fps) => (
          <SheetOption
            key={fps}
            active={settings.frameRate === fps}
            label={`${fps} FPS`}
            onClick={() => {
              onChange({ ...settings, frameRate: fps as FrameRate });
              setShowSheet(null);
            }}
          />
        ))}
      </BottomSheet>

      <BottomSheet
        open={showSheet === "bitrate"}
        title="Bitrate"
        onClose={() => setShowSheet(null)}
      >
        {BITRATE_OPTIONS.map((k) => (
          <SheetOption
            key={k}
            active={settings.bitrateKbps === k}
            label={bitrateLabel(k)}
            onClick={() => {
              onChange({ ...settings, bitrateKbps: k as BitrateKbps });
              setShowSheet(null);
            }}
          />
        ))}
      </BottomSheet>
    </div>
  );
}

interface NetworkRowProps {
  label: string;
  value: string;
  editable: boolean;
  fieldValue: string;
  placeholder: string;
  onFieldChange: (v: string) => void;
}

function NetworkRow({
  label,
  value,
  editable,
  fieldValue,
  placeholder,
  onFieldChange,
}: NetworkRowProps) {
  return (
    <div className="row">
      <div className="row__label">{label}</div>
      <div className="row__value">
        {editable ? (
          <input
            value={fieldValue}
            onChange={(e) => onFieldChange(e.target.value)}
            placeholder={placeholder}
            className="inline-input"
          />
        ) : (
          <span>{value}</span>
        )}
      </div>
    </div>
  );
}
