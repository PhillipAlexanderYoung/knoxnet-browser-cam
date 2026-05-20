// Receiver dashboard: connects to /ws as a "viewer", lists cameras and lets
// the operator accept/remove/view-live. WebRTC viewer logic lives here.

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const DEFAULT_WIREGUARD_RECEIVER_URL = "wss://10.44.0.1:8787/ws";

const el = (id) => document.getElementById(id);

const state = {
  pairingCode: "",
  info: null,
  lobbyWs: null,
  viewer: null, // { sessionId, ws, pc, stats interval }
  cameras: new Map(),
  knownDevices: new Map(),
  events: [],
  wireguard: {
    status: null,
    generated: null,
    phase: "Not configured",
  },
  network: {
    data: null,
    selectedHost: "",
  },
};

function setStatus(label, mode) {
  const pill = el("status-pill");
  pill.className = `status status--${mode}`;
  el("status-text").textContent = label;
}

async function fetchInfo() {
  const res = await fetch("/api/info", { cache: "no-store" });
  if (!res.ok) throw new Error(`info ${res.status}`);
  return res.json();
}

async function fetchNetwork(host) {
  const qs = host ? `?host=${encodeURIComponent(host)}` : "";
  const res = await fetch(`/api/network${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`network ${res.status}`);
  return res.json();
}

async function fetchKnownDevices() {
  const res = await fetch("/api/known-devices", { cache: "no-store" });
  if (!res.ok) throw new Error(`known-devices ${res.status}`);
  return res.json();
}

async function fetchEvents() {
  const res = await fetch("/api/events", { cache: "no-store" });
  if (!res.ok) throw new Error(`events ${res.status}`);
  return res.json();
}

function renderInfo(info) {
  state.info = info;
  state.pairingCode = info.pairingCode;
  const phonePairingUrl = info.phonePairingUrl ?? info.pairingUrl;
  const receiverDashboardUrl =
    info.dashboardUrl ?? `${info.tls ? "https" : "http"}://${info.publicHost}:${info.httpPort}/`;
  el("receiver-name").textContent = `${info.name} • ${receiverDashboardUrl}`;
  el("pairing-code").textContent = info.pairingCode;
  el("pairing-url").textContent = phonePairingUrl;
  const phoneAppUrl = el("phone-app-url");
  if (phoneAppUrl) {
    phoneAppUrl.textContent = info.phoneAppUrl ?? "unknown";
  }
  const receiverWsUrl = el("receiver-ws-url");
  if (receiverWsUrl) {
    receiverWsUrl.textContent = info.receiverWsUrl ?? "unknown";
  }
  if (info.network && !state.network.data) {
    state.network.data = info.network;
  }
  if (state.network.data) {
    renderNetwork(state.network.data);
  }
  const wireguardReceiverUrl = recommendedWireGuardReceiverUrl(info);
  for (const id of ["wireguard-receiver-url", "remote-wireguard-url"]) {
    const node = el(id);
    if (node) node.textContent = wireguardReceiverUrl;
  }
  const dashboardUrl = el("dashboard-url");
  if (dashboardUrl) {
    dashboardUrl.textContent = receiverDashboardUrl;
  }
  const qrUrl = el("pairing-qr-url");
  if (qrUrl) {
    qrUrl.textContent = phonePairingUrl;
    qrUrl.href = phonePairingUrl;
  }
  if (!state.network.data) {
    el("pairing-qr").src = `/api/pair-qr?ts=${Date.now()}`;
  }
  const bridge = el("bridge-status");
  if (bridge) {
    if (!info.bridgeUrl) {
      bridge.textContent = "RTSP bridge disabled. Use npm run receiver:dev-phone for phone pairing only, or npm run dev:all for the RTSP bridge too.";
    } else if (info.bridgeHealth?.ok) {
      bridge.textContent = `Bridge connected: ${info.bridgeUrl}. Use each Stable RTSP URL / NVR URL after accepting and trusting a camera.`;
    } else {
      bridge.textContent = `Bridge down: ${info.bridgeUrl}. Phones will keep reconnecting; stable RTSP URLs recover when the bridge returns.`;
    }
  }
  const mode = el("accept-mode");
  if (mode) {
    mode.textContent = `Auto-accept known: ${info.autoAcceptKnown ? "on" : "off"} • Auto-accept all: ${info.autoAcceptAll ? "on" : "off"} • stale TTL: ${Math.round((info.staleCameraTtlMs ?? 0) / 1000)}s`;
  }
  const remoteMode = el("remote-mode");
  if (remoteMode) {
    const appHost = safeHost(info.phoneAppUrl);
    const receiverHost = safeHost(info.receiverWsUrl);
    const cloudMode = info.phoneAppMode === "cloud" || appHost === "cam.knoxnetvms.com";
    remoteMode.textContent = cloudMode
      ? `Remote mode ready: QR opens ${appHost}; receiver target is ${receiverHost}. Remote phones must connect WireGuard first.`
      : `Development mode: QR opens ${appHost}; receiver target is ${receiverHost}.`;
  }
}

function renderNetwork(network) {
  state.network.data = network;
  state.network.selectedHost = network.selectedHost ?? "";
  const localDashboard = el("local-dashboard-url");
  const localReceiver = el("local-receiver-ws-url");
  const receiverWs = el("receiver-ws-url");
  const dashboardUrl = el("dashboard-url");
  const pairingUrl = el("pairing-url");
  const qrUrl = el("pairing-qr-url");
  if (localDashboard) localDashboard.textContent = network.localDashboardUrl ?? "unknown";
  if (localReceiver) localReceiver.textContent = network.localReceiverWsUrl ?? "unknown";
  if (receiverWs) receiverWs.textContent = network.localReceiverWsUrl ?? receiverWs.textContent;
  if (dashboardUrl) dashboardUrl.textContent = network.localDashboardUrl ?? dashboardUrl.textContent;
  if (pairingUrl) pairingUrl.textContent = network.localPhonePairingUrl ?? pairingUrl.textContent;
  if (qrUrl) {
    qrUrl.textContent = network.localPhonePairingUrl ?? qrUrl.textContent;
    qrUrl.href = network.localPhonePairingUrl ?? "#";
  }
  const qrEndpoint = network.currentQrUrl || "/api/pair-qr";
  el("pairing-qr").src = `${qrEndpoint}${qrEndpoint.includes("?") ? "&" : "?"}ts=${Date.now()}`;

  const root = el("network-addresses");
  if (!root) return;
  const addresses = network.addresses ?? [];
  if (addresses.length === 0) {
    root.innerHTML = `<div class="empty empty--compact">No LAN IPv4 address detected. Check receiver network settings.</div>`;
    return;
  }
  root.innerHTML = addresses
    .map((addr) => {
      const selected = addr.address === network.selectedHost;
      const recommended = addr.address === network.recommendedAddress?.address;
      const bits = [
        escapeHtml(addr.name),
        escapeHtml(addr.address),
        recommended ? "recommended" : "",
        addr.virtual ? "virtual/VPN" : "",
      ].filter(Boolean);
      return `<button class="network-address ${selected ? "network-address--selected" : ""}" data-network-host="${escapeHtml(addr.address)}">
        <span>${bits.join(" • ")}</span>
      </button>`;
    })
    .join("");
}

function recommendedWireGuardReceiverUrl(info) {
  const receiverWsUrl = info?.receiverWsUrl ?? "";
  if (receiverWsUrl.includes("10.44.0.1")) return receiverWsUrl;
  return DEFAULT_WIREGUARD_RECEIVER_URL;
}

async function fetchWireGuardStatus() {
  const res = await fetch("/api/wireguard/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`wireguard status ${res.status}`);
  return res.json();
}

async function loadWireGuardStatus() {
  const statusNode = el("wg-tool-status");
  try {
    const status = await fetchWireGuardStatus();
    state.wireguard.status = status;
    applyWireGuardDefaults(status.defaults);
    updateWireGuardControls();
  } catch (err) {
    console.warn("wireguard status", err);
    if (statusNode) {
      statusNode.textContent = "Could not check WireGuard tools. The wizard API may be unavailable.";
      statusNode.className = "wg-status wg-status--error";
    }
  }
}

function applyWireGuardDefaults(defaults) {
  if (!defaults) return;
  const values = {
    "wg-subnet": defaults.vpnSubnet,
    "wg-receiver-ip": defaults.receiverVpnIp,
    "wg-phone-ip": defaults.phoneVpnIp,
    "wg-port": defaults.listenPort,
    "wg-interface": defaults.interfaceName,
  };
  for (const [id, value] of Object.entries(values)) {
    const node = el(id);
    if (node && value) node.value = value;
  }
}

function readWireGuardSettings() {
  return {
    vpnSubnet: el("wg-subnet")?.value?.trim() || "10.44.0.0/24",
    receiverVpnIp: el("wg-receiver-ip")?.value?.trim() || "10.44.0.1",
    phoneVpnIp: el("wg-phone-ip")?.value?.trim() || "10.44.0.10",
    listenPort: Number(el("wg-port")?.value || 51820),
    interfaceName: el("wg-interface")?.value?.trim() || "wg-knoxcam",
    publicEndpoint: el("wg-endpoint")?.value?.trim() || "",
    receiverPort: state.info?.httpPort || 8787,
  };
}

function setWireGuardPhase(phase) {
  state.wireguard.phase = phase;
  const node = el("wg-state");
  if (node) node.textContent = phase;
}

function updateWireGuardControls() {
  const status = state.wireguard.status;
  const ack = Boolean(el("wg-ack")?.checked);
  const generate = el("wg-generate");
  const regenerate = el("wg-regenerate");
  const reset = el("wg-reset");
  const statusNode = el("wg-tool-status");
  if (generate) generate.disabled = !ack;
  if (generate && state.wireguard.generated) {
    generate.textContent = "Show generated WireGuard setup";
  }
  if (regenerate) regenerate.classList.toggle("hidden", !state.wireguard.generated);
  if (reset) reset.classList.toggle("hidden", !state.wireguard.generated);
  if (!statusNode) return;
  if (!status) {
    statusNode.textContent = "Checking for WireGuard tools…";
    statusNode.className = "wg-status";
  } else if (status.wgInstalled) {
    const wgQuick = status.wgQuickInstalled ? "wg-quick found" : "wg-quick not found";
    statusNode.textContent = `WireGuard tools found${status.version ? `: ${status.version}` : ""}; ${wgQuick}. Check the acknowledgement, then generate.`;
    statusNode.className = "wg-status";
  } else {
    statusNode.textContent = `WireGuard tools not found. Install WireGuard on this receiver machine first, then click Generate again.`;
    statusNode.className = "wg-status wg-status--warn";
  }
}

async function generateWireGuardSetup(forceRegenerate = false) {
  const button = el("wg-generate");
  const statusNode = el("wg-tool-status");
  if (button) {
    button.disabled = true;
    button.textContent = forceRegenerate ? "Regenerating…" : "Generating…";
  }
  try {
    const requestBody = readWireGuardSettings();
    if (forceRegenerate) requestBody.forceRegenerate = true;
    const res = await fetch("/api/wireguard/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const data = await readJsonResponse(res);
    if (!res.ok) {
      throw new Error(data.message || data.error || data.body || `wireguard generate ${res.status}`);
    }
    if (data.status === "needs-install" || data.wgMissing) {
      renderWireGuardNeedsInstall(data);
      return;
    }
    renderWireGuardSetup(data);
  } catch (err) {
    console.error(err);
    if (statusNode) {
      statusNode.textContent = err instanceof Error ? err.message : "WireGuard generation failed.";
      statusNode.className = "wg-status wg-status--error";
    }
  } finally {
    if (button) {
      button.textContent = "Enable remote phone access with WireGuard";
      updateWireGuardControls();
    }
  }
}

async function readJsonResponse(res) {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => ({}));
  }
  const body = await res.text().catch(() => "");
  return body ? { body, message: body } : {};
}

function renderWireGuardNeedsInstall(data) {
  state.wireguard.generated = null;
  setWireGuardPhase("Install needed");
  const install = el("wg-install");
  if (install) install.classList.remove("hidden");
  el("wg-install-commands").textContent = data.installCommands || ubuntuWireGuardInstallCommands();
  const generated = el("wg-generated");
  if (generated) generated.classList.add("hidden");
  const statusNode = el("wg-tool-status");
  if (statusNode) {
    statusNode.className = "wg-status wg-status--warn";
    statusNode.innerHTML = [
      `<strong>${escapeHtml(data.message || "WireGuard tools are not installed.")}</strong>`,
      "Step A is ready below. Run the install commands on the receiver/VMS host, then click the WireGuard button again to generate config and QR codes.",
    ].join("<br />");
  }
  updateWireGuardControls();
}

function renderWireGuardSetup(data) {
  state.wireguard.generated = data;
  setWireGuardPhase(data.status === "already-generated" ? "Config ready" : "Config generated");
  const statusNode = el("wg-tool-status");
  if (statusNode) {
    const endpointNote =
      data.endpointSource === "request-host"
        ? ` Using ${data.setup?.settings?.publicEndpoint || "the dashboard host"} as the WireGuard endpoint for LAN testing.`
        : "";
    statusNode.textContent = `${data.message || "WireGuard setup ready."}${endpointNote}`;
    statusNode.className = "wg-status";
  }
  const install = el("wg-install");
  if (install) install.classList.remove("hidden");
  const generated = el("wg-generated");
  if (generated) generated.classList.remove("hidden");
  const commandBlocks = wireGuardCommandBlocks(data);
  el("wg-install-commands").textContent = commandBlocks.install;
  el("wg-config-path").textContent = commandBlocks.configPath;
  el("wg-service-name").textContent = commandBlocks.serviceName;
  el("wg-server-config-commands").textContent = commandBlocks.serverConfig;
  el("wg-firewall-commands").textContent = commandBlocks.firewall;
  el("wg-verify-commands").textContent = commandBlocks.verify;
  el("wg-commands").textContent = data.setup.commands;
  el("wg-phone-config").textContent = data.setup.phoneConfig;
  el("wg-peer-qr").src = data.wireGuardPeerQr;
  el("wg-dashboard-url").textContent = data.vpnDashboardUrl;
  el("wg-vpn-ws").textContent = data.vpnReceiverWsUrl;
  const remoteWireGuardUrl = el("remote-wireguard-url");
  if (remoteWireGuardUrl) remoteWireGuardUrl.textContent = data.vpnReceiverWsUrl;
  const pairingQr = el("wg-pairing-qr");
  if (pairingQr) pairingQr.src = data.vpnPairingQr;
  const pairingUrl = el("wg-pairing-url");
  if (pairingUrl) {
    pairingUrl.href = data.vpnPairingUrl;
    pairingUrl.textContent = data.vpnPairingUrl;
  }
  updateWireGuardControls();
}

function resetWireGuardView() {
  state.wireguard.generated = null;
  setWireGuardPhase("Not configured");
  const install = el("wg-install");
  if (install) install.classList.add("hidden");
  const generated = el("wg-generated");
  if (generated) generated.classList.add("hidden");
  const statusNode = el("wg-tool-status");
  if (statusNode) {
    statusNode.textContent = "WireGuard setup view reset. Click the button to show the current generated setup or create one.";
    statusNode.className = "wg-status";
  }
  updateWireGuardControls();
}

function wireGuardCommandBlocks(data) {
  const settings = data.setup.settings;
  const configPath = `/etc/wireguard/${settings.interfaceName}.conf`;
  const serviceName = `wg-quick@${settings.interfaceName}`;
  return {
    configPath,
    serviceName,
    install: ubuntuWireGuardInstallCommands(),
    serverConfig: [
      "sudo install -d -m 700 /etc/wireguard",
      `sudo tee ${configPath} >/dev/null <<'EOF'`,
      data.setup.serverConfig.trimEnd(),
      "EOF",
      `sudo chmod 600 ${configPath}`,
      `sudo systemctl enable --now ${serviceName}`,
    ].join("\n"),
    firewall: [
      `sudo ufw allow ${settings.listenPort}/udp comment 'WireGuard'`,
      `sudo ufw allow in on ${settings.interfaceName} to ${settings.receiverVpnIp} port ${settings.receiverPort} proto tcp comment 'Knoxnet receiver dashboard/WSS'`,
      "# Optional VPN-only service examples:",
      `sudo ufw allow in on ${settings.interfaceName} to ${settings.receiverVpnIp} port 8790 proto tcp comment 'Knoxnet bridge API'`,
      `sudo ufw allow in on ${settings.interfaceName} to ${settings.receiverVpnIp} port 8554 proto tcp comment 'MediaMTX RTSP over VPN'`,
      "# Do not expose RTSP, bridge, or receiver web ports directly to the public internet.",
    ].join("\n"),
    verify: [
      "sudo wg show",
      `ip addr show ${settings.interfaceName}`,
      `curl -k https://${settings.receiverVpnIp}:${settings.receiverPort}/api/info`,
    ].join("\n"),
  };
}

function ubuntuWireGuardInstallCommands() {
  return [
    "# Ubuntu/Debian receiver host",
    "sudo apt update && sudo apt install -y wireguard qrencode",
  ].join("\n");
}

async function copyElementText(targetId, button) {
  const target = el(targetId);
  if (!target) return;
  await navigator.clipboard.writeText(target.textContent || "");
  const old = button.textContent;
  button.textContent = "Copied!";
  setTimeout(() => (button.textContent = old), 1200);
}

el("copy-url").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      state.info?.phonePairingUrl ?? state.info?.pairingUrl ?? "",
    );
    el("copy-url").textContent = "Copied!";
    setTimeout(() => (el("copy-url").textContent = "Copy URL"), 1200);
  } catch (e) {
    console.warn("clipboard fail", e);
  }
});

el("wg-ack")?.addEventListener("change", updateWireGuardControls);
el("wg-generate")?.addEventListener("click", () => generateWireGuardSetup(false));
el("wg-regenerate")?.addEventListener("click", () => generateWireGuardSetup(true));
el("wg-reset")?.addEventListener("click", resetWireGuardView);

function statusForCamera(cam) {
  return cam.status;
}

function bridgePhase(cam) {
  if (!cam.bridge) return "";
  if (cam.bridge.ingestStatus === "publishing") return "RTSP live";
  if (cam.bridge.ingestStatus === "recovering") return "RTSP recovering; stable URL retained";
  if (cam.bridge.ingestStatus === "offline") return "RTSP offline; stable URL retained";
  if (cam.bridge.ingestStatus === "error") return `RTSP error${cam.bridge.lastError ? ": " + cam.bridge.lastError : ""}`;
  return "RTSP allocated; waiting for WHIP media";
}

function bridgePreviewUrl(cam) {
  return cam.bridge?.preview?.webRtcUrl || cam.bridge?.previewUrls?.webRtc || "";
}

function stableKbps(kbps) {
  if (typeof kbps !== "number" || kbps <= 0) return 0;
  const bucket = kbps >= 1000 ? 100 : 50;
  return Math.max(bucket, Math.round(kbps / bucket) * bucket);
}

function formatKbps(kbps) {
  const rounded = stableKbps(kbps);
  if (!rounded) return "— kbps";
  if (rounded >= 1000) return `${(rounded / 1000).toFixed(1)} Mbps`;
  return `${rounded} kbps`;
}

function qualityLabel(quality) {
  if (!quality) return "";
  const current = quality.currentResolution || (quality.height ? `${quality.height}p` : "");
  const mode = quality.mode === "auto"
    ? `Auto${current ? ` (${current})` : ""}`
    : (quality.currentResolution || quality.requestedResolution || quality.mode);
  const details = [];
  if (quality.frameRate) details.push(`${Math.round(quality.frameRate)}fps`);
  if (quality.bitrateKbps) details.push(formatKbps(quality.bitrateKbps));
  return [mode, ...details].filter(Boolean).join(" / ");
}

function renderViewerMeta(viewer) {
  el("viewer-meta").innerHTML = `
    <div class="viewer__meta-row"><span>session</span><span>${escapeHtml(viewer.sessionId)}</span></div>
    <div class="viewer__meta-row"><span>pc state</span><span id="pc-state">${escapeHtml(viewer.pc.connectionState)}</span></div>
    <div class="viewer__meta-row"><span>bitrate</span><span id="viewer-bitrate" class="viewer__bitrate">— kbps</span></div>
  `;
}

function renderCameras() {
  const list = Array.from(state.cameras.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  renderCounts(list);
  const root = el("cameras");
  if (list.length === 0) {
    root.innerHTML = `<div class="empty">No cameras connected yet. Scan the QR with your phone.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const cam of list) {
    const div = document.createElement("div");
    div.className = "camera";
    const dotClass = `camera__dot camera__dot--${statusForCamera(cam)}`;
    const capBits = [];
    if (cam.capabilities?.audio) capBits.push("audio");
    if (cam.capabilities?.torch) capBits.push("torch");
    const quality = qualityLabel(cam.quality || cam.capabilities?.quality || cam.bridge?.quality);
    const known = cam.deviceId ? state.knownDevices.get(cam.deviceId) : null;
    const staleText =
      cam.status === "disconnected" && cam.disconnectReason
        ? ` • reason: ${escapeHtml(cam.disconnectReason)}`
        : "";
    const rtsp = cam.bridge?.rtspUrl
      ? `<div class="camera__rtsp">
          <span>${cam.bridge.ingestStatus === "publishing" ? "Stable RTSP URL / NVR URL live" : "Stable RTSP URL / NVR URL retained"}</span>
          <code>${escapeHtml(cam.bridge.rtspUrl)}</code>
          <button class="btn btn--ghost" data-action="copy-rtsp" data-id="${cam.sessionId}">Copy</button>
          <small>NVRs should use this URL. The stream may pause during phone reconnects, but the URL should not change.</small>
        </div>`
      : "";
    const bridge = bridgePhase(cam);
    div.innerHTML = `
      <span class="${dotClass}"></span>
      <div>
        <div class="camera__name">${escapeHtml(cam.name)}</div>
        <div class="camera__meta">
          status: ${escapeHtml(cam.status)} • session: ${escapeHtml(cam.sessionId.slice(0, 6))}
          ${cam.deviceId ? "• device: " + escapeHtml(cam.deviceId.slice(0, 8)) : ""}
          ${known?.trusted || cam.trusted ? "• trusted" : ""}
          ${cam.reconnectCount ? "• reconnects: " + escapeHtml(cam.reconnectCount) : ""}
          ${cam.remoteAddress ? "• " + escapeHtml(cam.remoteAddress) : ""}
          ${capBits.length ? "• " + capBits.join(", ") : ""}
          ${quality ? "• quality: " + escapeHtml(quality) : ""}
          ${bridge ? "• bridge: " + escapeHtml(bridge) : ""}
          ${staleText}
        </div>
        ${rtsp}
      </div>
      <div class="camera__actions">
        ${cam.status === "pending"
          ? `<button class="btn btn--primary" data-action="accept" data-id="${cam.sessionId}">Accept</button>`
          : ""}
        ${cam.deviceId && !(known?.trusted || cam.trusted)
          ? `<button class="btn btn--ghost" data-action="trust-camera" data-id="${cam.sessionId}">Trust this device</button>`
          : ""}
        ${(cam.status === "accepted" || cam.status === "streaming") && !cam.bridge
          ? `<button class="btn btn--primary" data-action="view" data-id="${cam.sessionId}">View Live</button>`
          : ""}
        ${cam.bridge?.ingestStatus === "publishing" && bridgePreviewUrl(cam)
          ? `<button class="btn btn--primary" data-action="bridge-preview" data-id="${cam.sessionId}">View Live</button>`
          : ""}
        <button class="btn btn--danger" data-action="remove" data-id="${cam.sessionId}">Remove</button>
      </div>
    `;
    root.appendChild(div);
  }
}

function renderCounts(list = Array.from(state.cameras.values())) {
  const counts = { active: 0, pending: 0, disconnected: 0 };
  for (const cam of list) {
    if (cam.status === "pending") counts.pending += 1;
    else if (cam.status === "disconnected") counts.disconnected += 1;
    else counts.active += 1;
  }
  const root = el("camera-counts");
  if (!root) return;
  root.innerHTML = `
    <span>active ${counts.active}</span>
    <span>pending ${counts.pending}</span>
    <span>disconnected ${counts.disconnected}</span>
  `;
}

function renderKnownDevices() {
  const list = Array.from(state.knownDevices.values()).sort((a, b) =>
    b.lastSeen.localeCompare(a.lastSeen),
  );
  const root = el("known-devices");
  if (!root) return;
  if (list.length === 0) {
    root.innerHTML = `<div class="empty">Trusted phones will appear after first pairing.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const device of list) {
    const row = document.createElement("div");
    row.className = "known-device";
    row.innerHTML = `
      <div>
        <div class="known-device__name">${escapeHtml(device.name)}</div>
        <div class="known-device__meta">
          ${escapeHtml(device.deviceId.slice(0, 12))} • last seen ${formatTime(device.lastSeen)}
          ${device.lastSessionId ? "• session " + escapeHtml(device.lastSessionId.slice(0, 6)) : ""}
        </div>
      </div>
      <div class="known-device__actions">
        <label class="toggle-row">
          <input type="checkbox" data-action="toggle-auto-accept" data-id="${device.deviceId}" ${device.autoAccept ? "checked" : ""} />
          <span>Auto-accept</span>
        </label>
        ${device.trusted
          ? `<button class="btn btn--danger" data-action="forget-device" data-id="${device.deviceId}">Forget</button>`
          : `<button class="btn btn--primary" data-action="trust-device" data-id="${device.deviceId}">Trust</button>`}
      </div>
    `;
    root.appendChild(row);
  }
}

function renderEvents() {
  const root = el("events");
  if (!root) return;
  const list = state.events.slice(-200).reverse();
  if (list.length === 0) {
    root.innerHTML = `<div class="empty">No connection events yet.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const event of list) {
    const row = document.createElement("div");
    row.className = "event";
    row.innerHTML = `
      <div class="event__type">${escapeHtml(event.type)}</div>
      <div class="event__body">
        <div>${escapeHtml(event.message)}${event.reason ? " - " + escapeHtml(event.reason) : ""}</div>
        <div class="event__meta">
          ${formatTime(event.ts)}
          ${event.name ? "• " + escapeHtml(event.name) : ""}
          ${event.sessionId ? "• session " + escapeHtml(event.sessionId.slice(0, 6)) : ""}
          ${event.deviceId ? "• device " + escapeHtml(event.deviceId.slice(0, 8)) : ""}
        </div>
      </div>
    `;
    root.appendChild(row);
  }
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

async function refreshKnownDevices() {
  const known = await fetchKnownDevices();
  state.knownDevices = new Map((known.devices ?? []).map((d) => [d.deviceId, d]));
  renderKnownDevices();
  renderCameras();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
}

function safeHost(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl || "unknown";
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const networkHost = t.closest("[data-network-host]")?.getAttribute("data-network-host");
  if (networkHost) {
    try {
      state.network.data = await fetchNetwork(networkHost);
      renderNetwork(state.network.data);
    } catch (err) {
      console.warn("network select", err);
    }
    return;
  }
  const copyTarget = t.getAttribute("data-copy-target");
  if (copyTarget) {
    await copyElementText(copyTarget, t);
    return;
  }
  const action = t.getAttribute("data-action");
  const id = t.getAttribute("data-id");
  if (!action || !id) return;
  if (action === "accept") {
    await fetch(`/api/cameras/${encodeURIComponent(id)}/accept`, {
      method: "POST",
    });
  } else if (action === "trust-camera") {
    const cam = state.cameras.get(id);
    if (!cam?.deviceId) return;
    await fetch(`/api/known-devices/${encodeURIComponent(cam.deviceId)}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoAccept: true }),
    });
    await refreshKnownDevices();
  } else if (action === "trust-device") {
    await fetch(`/api/known-devices/${encodeURIComponent(id)}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoAccept: true }),
    });
    await refreshKnownDevices();
  } else if (action === "forget-device") {
    if (!confirm("Forget this trusted device? It will need manual accept next time.")) return;
    await fetch(`/api/known-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshKnownDevices();
  } else if (action === "remove") {
    if (!confirm("Remove this camera?")) return;
    await fetch(`/api/cameras/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.viewer?.sessionId === id) closeViewer();
  } else if (action === "view") {
    await openViewer(id);
  } else if (action === "bridge-preview") {
    const cam = state.cameras.get(id);
    const url = bridgePreviewUrl(cam);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  } else if (action === "copy-rtsp") {
    const cam = state.cameras.get(id);
    if (cam?.bridge?.rtspUrl) {
      await navigator.clipboard.writeText(cam.bridge.rtspUrl);
      t.textContent = "Copied!";
      setTimeout(() => (t.textContent = "Copy"), 1200);
    }
  }
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  const action = t.getAttribute("data-action");
  const id = t.getAttribute("data-id");
  if (action !== "toggle-auto-accept" || !id) return;
  await fetch(`/api/known-devices/${encodeURIComponent(id)}/auto-accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoAccept: t.checked }),
  });
  await refreshKnownDevices();
});

el("clear-stale")?.addEventListener("click", async () => {
  await fetch("/api/cameras/clear-stale", { method: "POST" });
});

function openLobbyWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  state.lobbyWs = ws;
  ws.onopen = () => {
    setStatus("Connected", "connected");
    ws.send(
      JSON.stringify({
        type: "hello",
        role: "viewer",
        pairingCode: state.pairingCode,
      }),
    );
  };
  ws.onclose = () => {
    setStatus("Disconnected", "error");
    setTimeout(openLobbyWs, 1500);
  };
  ws.onerror = () => setStatus("Connection error", "error");
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello-ack") {
      if (!msg.paired) {
        setStatus("Bad pairing code", "error");
      }
    } else if (msg.type === "camera-list") {
      state.cameras = new Map(msg.cameras.map((c) => [c.sessionId, c]));
      renderCameras();
    } else if (msg.type === "camera-update") {
      state.cameras.set(msg.camera.sessionId, msg.camera);
      renderCameras();
    } else if (msg.type === "event-log") {
      state.events = msg.events ?? [];
      renderEvents();
    } else if (msg.type === "event") {
      state.events.push(msg.event);
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
      renderEvents();
      void refreshKnownDevices().catch((err) => console.warn("refresh known", err));
    } else if (msg.type === "error") {
      console.warn("server error", msg.message);
    }
  };
}

function closeViewer() {
  const v = state.viewer;
  if (!v) return;
  if (v.statsInterval) clearInterval(v.statsInterval);
  if (v.pc) {
    try {
      v.pc.close();
    } catch {}
  }
  if (v.ws && v.ws.readyState === WebSocket.OPEN) {
    try {
      v.ws.send(JSON.stringify({ type: "bye", sessionId: v.sessionId }));
    } catch {}
    try {
      v.ws.close();
    } catch {}
  }
  state.viewer = null;
  const vid = el("viewer-video");
  vid.srcObject = null;
  el("viewer-section").classList.add("hidden");
  el("viewer-meta").innerHTML = "";
}

el("close-viewer").addEventListener("click", closeViewer);

async function openViewer(sessionId) {
  closeViewer();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  const viewer = {
    sessionId,
    ws,
    pc,
    statsInterval: null,
    lastBytes: 0,
    lastT: 0,
    displayedKbps: 0,
    lastMetaAt: 0,
  };
  state.viewer = viewer;

  el("viewer-section").classList.remove("hidden");
  renderViewerMeta(viewer);

  pc.ontrack = (ev) => {
    const vid = el("viewer-video");
    if (vid.srcObject !== ev.streams[0]) {
      vid.srcObject = ev.streams[0];
    }
  };
  pc.onicecandidate = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "ice",
        sessionId,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      }),
    );
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const node = document.getElementById("pc-state");
    if (node) node.textContent = s;
  };

  // We don't add tracks; we only receive video (and optional audio).
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        role: "viewer",
        pairingCode: state.pairingCode,
        sessionId,
      }),
    );
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello-ack" && msg.paired) {
      // Wait for the camera's offer.
    } else if (msg.type === "offer" && msg.sessionId === sessionId) {
      try {
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: "answer",
            sessionId,
            sdp: { type: answer.type, sdp: answer.sdp },
          }),
        );
      } catch (err) {
        console.error("answer failed", err);
      }
    } else if (msg.type === "ice" && msg.sessionId === sessionId) {
      if (msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          console.warn("addIceCandidate", err);
        }
      }
    } else if (msg.type === "bye" && msg.sessionId === sessionId) {
      closeViewer();
    } else if (msg.type === "camera-update") {
      state.cameras.set(msg.camera.sessionId, msg.camera);
      renderCameras();
    }
  };

  ws.onclose = () => {
    if (state.viewer === viewer) closeViewer();
  };

  viewer.statsInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let kbps = 0;
      let total = 0;
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && (s.kind === "video" || s.mediaType === "video")) {
          if (typeof s.bytesReceived === "number") total += s.bytesReceived;
        }
      });
      const now = performance.now();
      if (viewer.lastT > 0) {
        const dt = (now - viewer.lastT) / 1000;
        if (dt > 0) kbps = Math.round(((total - viewer.lastBytes) * 8) / 1000 / dt);
      }
      viewer.lastBytes = total;
      viewer.lastT = now;
      const rounded = stableKbps(kbps);
      viewer.displayedKbps = viewer.displayedKbps
        ? Math.round(viewer.displayedKbps * 0.65 + rounded * 0.35)
        : rounded;
      if (now - viewer.lastMetaAt >= 2500) {
        viewer.lastMetaAt = now;
        const bitrateNode = document.getElementById("viewer-bitrate");
        if (bitrateNode) bitrateNode.textContent = formatKbps(viewer.displayedKbps);
        const stateNode = document.getElementById("pc-state");
        if (stateNode) stateNode.textContent = pc.connectionState;
      }
    } catch {}
  }, 1000);
}

(async () => {
  try {
    setStatus("Loading…", "");
    const info = await fetchInfo();
    renderInfo(info);
    void loadWireGuardStatus();
    const [known, events] = await Promise.all([fetchKnownDevices(), fetchEvents()]);
    state.knownDevices = new Map((known.devices ?? []).map((d) => [d.deviceId, d]));
    state.events = events.events ?? [];
    renderKnownDevices();
    renderEvents();
  } catch (e) {
    console.error(e);
    setStatus("Server error", "error");
    return;
  }
  openLobbyWs();
  setInterval(async () => {
    try {
      renderInfo(await fetchInfo());
    } catch (err) {
      console.warn("refresh info", err);
    }
  }, 8000);
})();
