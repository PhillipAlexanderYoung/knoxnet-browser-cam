import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import express, { type Request, type Response } from "express";
import cors from "cors";
import qrcode from "qrcode";
import { WebSocketServer } from "ws";
import {
  createPairingState,
  listCameras,
  redactCode,
  removeCamera,
  setCameraStatus,
} from "./pairing.js";
import { createBridgeClient } from "./bridge-client.js";
import { attachSignaling } from "./signaling.js";
import { createEventLog } from "./events.js";
import { createKnownDeviceStore } from "./known-devices.js";
import {
  DEFAULT_PHONE_APP_URL,
  buildPhonePairingUrl,
  buildReceiverUrls,
  httpScheme,
  type ReceiverUrlConfig,
} from "./urls.js";
import {
  DEFAULT_WIREGUARD_SETTINGS,
  WIREGUARD_INSTALL_COMMANDS,
  generateWireGuardSetup,
  getWireGuardStatus,
  normalizeWireGuardSettings,
} from "./wireguard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// When built, server.js lives in dist/, and we want to serve from dist/public.
// When run via tsx, this resolves to src/public.
const STATIC_DIR = path.resolve(__dirname, "public");
const DOCS_DIR = path.resolve(__dirname, "..", "..", "docs");

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8787);
const RECEIVER_NAME =
  process.env.RECEIVER_NAME ?? `${os.hostname()}-knoxnet-receiver`;
const PUBLIC_HOST_OVERRIDE = process.env.PUBLIC_HOST?.trim();
const PUBLIC_HOST = PUBLIC_HOST_OVERRIDE || recommendedNetworkAddress()?.address || "localhost";
const AUTO_ACCEPT_KNOWN =
  (process.env.AUTO_ACCEPT_KNOWN ?? "true").toLowerCase() === "true";
const AUTO_ACCEPT_ALL =
  (process.env.AUTO_ACCEPT_ALL ?? process.env.AUTO_ACCEPT ?? "false").toLowerCase() ===
  "true";
const STALE_CAMERA_TTL_MS = Number(process.env.STALE_CAMERA_TTL_MS ?? 5 * 60_000);
const BRIDGE_URL = process.env.BRIDGE_URL?.replace(/\/+$/, "");
const USE_TLS =
  (process.env.WSS ?? process.env.HTTPS ?? "false").toLowerCase() === "true";
const PHONE_APP_SCHEME =
  process.env.PHONE_APP_SCHEME;
const PHONE_APP_PORT = process.env.PHONE_APP_PORT
  ? Number(process.env.PHONE_APP_PORT)
  : undefined;
const PHONE_APP_URL = process.env.PHONE_APP_URL?.replace(/\/+$/, "");
const PHONE_APP_ENV = process.env.PHONE_APP_ENV;
const TLS_KEY_PATH =
  process.env.TLS_KEY_PATH ??
  path.resolve(__dirname, "..", "..", ".cert", "knoxnet-dev.key");
const TLS_CERT_PATH =
  process.env.TLS_CERT_PATH ??
  path.resolve(__dirname, "..", "..", ".cert", "knoxnet-dev.crt");
const RECEIVER_DATA_DIR =
  process.env.RECEIVER_DATA_DIR ?? path.resolve(__dirname, "..", "data");
const KNOWN_DEVICES_PATH =
  process.env.KNOWN_DEVICES_PATH ??
  path.join(RECEIVER_DATA_DIR, "known-devices.json");

const state = createPairingState(process.env.PAIRING_CODE);
const eventLog = createEventLog();
const knownDevices = createKnownDeviceStore(KNOWN_DEVICES_PATH);
let cachedWireGuardSetup:
  | { settingsKey: string; response: Record<string, unknown> }
  | undefined;
const urlConfig: ReceiverUrlConfig = {
  publicHost: PUBLIC_HOST,
  receiverPort: PORT,
  useTls: USE_TLS,
  phoneAppUrl: PHONE_APP_URL,
  phoneAppEnv: PHONE_APP_ENV,
  phoneAppScheme: PHONE_APP_SCHEME,
  phoneAppPort: PHONE_APP_PORT,
};

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[receiver]`, new Date().toISOString(), ...args);
}

function requestHost(req: Request): string {
  return req.hostname || PUBLIC_HOST;
}

function wireGuardSettingsKey(settings: typeof DEFAULT_WIREGUARD_SETTINGS): string {
  return JSON.stringify({
    vpnSubnet: settings.vpnSubnet,
    receiverVpnIp: settings.receiverVpnIp,
    phoneVpnIp: settings.phoneVpnIp,
    listenPort: settings.listenPort,
    interfaceName: settings.interfaceName,
    publicEndpoint: settings.publicEndpoint,
    receiverPort: settings.receiverPort,
  });
}

interface NetworkAddress {
  id: string;
  name: string;
  address: string;
  cidr?: string | null;
  mac?: string;
  private: boolean;
  virtual: boolean;
}

function listNetworkAddresses(): NetworkAddress[] {
  const ifaces = os.networkInterfaces();
  const addresses: NetworkAddress[] = [];
  for (const name of Object.keys(ifaces).sort()) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.push({
          id: `${name}-${info.address}`,
          name,
          address: info.address,
          cidr: info.cidr,
          mac: info.mac,
          private: isPrivateIpv4(info.address),
          virtual: isLikelyVirtualInterface(name, info.address),
        });
      }
    }
  }
  return addresses.sort((a, b) => scoreNetworkAddress(b) - scoreNetworkAddress(a));
}

function recommendedNetworkAddress(addresses = listNetworkAddresses()): NetworkAddress | undefined {
  if (PUBLIC_HOST_OVERRIDE) {
    const override = addresses.find((addr) => addr.address === PUBLIC_HOST_OVERRIDE);
    if (override) return override;
  }
  return addresses[0];
}

function scoreNetworkAddress(addr: NetworkAddress): number {
  let score = 0;
  if (addr.private) score += 100;
  if (!addr.virtual) score += 50;
  if (/^(en|eth|wlan|wl|wifi)/i.test(addr.name)) score += 20;
  if (/^192\.168\./.test(addr.address)) score += 10;
  if (/^10\./.test(addr.address)) score += 8;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr.address)) score += 6;
  if (/^169\.254\./.test(addr.address)) score -= 100;
  return score;
}

function isPrivateIpv4(address: string): boolean {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  );
}

function isLikelyVirtualInterface(name: string, address: string): boolean {
  return (
    /^(docker|br-|veth|virbr|vmnet|tun|tap|wg|zt|tailscale|cni|flannel|kube)/i.test(name) ||
    /^169\.254\./.test(address)
  );
}

function receiverUrls(host = PUBLIC_HOST) {
  return buildReceiverUrls({ ...urlConfig, publicHost: host }, state.code);
}

function selectedNetworkHost(rawHost: unknown): string {
  if (typeof rawHost !== "string" || !rawHost.trim()) return PUBLIC_HOST;
  const requested = rawHost.trim();
  const addresses = listNetworkAddresses();
  return addresses.some((addr) => addr.address === requested) ? requested : PUBLIC_HOST;
}

function networkInfo(host = PUBLIC_HOST) {
  const addresses = listNetworkAddresses();
  const recommended = recommendedNetworkAddress(addresses);
  const selected = addresses.find((addr) => addr.address === host) ?? recommended;
  const selectedHost = selected?.address ?? host;
  const urls = receiverUrls(selectedHost);
  return {
    ok: true,
    addresses,
    recommendedAddress: recommended,
    selectedAddress: selected,
    selectedHost,
    localDashboardUrl: urls.dashboardUrl,
    localReceiverWsUrl: urls.receiverWsUrl,
    localPhonePairingUrl: urls.phonePairingUrl,
    currentQrUrl: `/api/pair-qr?host=${encodeURIComponent(selectedHost)}`,
    connectivity:
      "Works when this phone can reach the receiver: same Wi-Fi/LAN, or connected to the same WireGuard VPN.",
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
const bridgeClient = createBridgeClient(BRIDGE_URL, log);

app.get("/api/info", async (_req: Request, res: Response) => {
  const urls = receiverUrls();
  const network = networkInfo(PUBLIC_HOST);
  const bridgeHealth = bridgeClient ? await bridgeClient.health() : null;
  res.json({
    ok: true,
    name: RECEIVER_NAME,
    httpPort: PORT,
    wsPath: "/ws",
    publicHost: PUBLIC_HOST,
    pairingCode: state.code,
    phonePairingUrl: urls.phonePairingUrl,
    pairingUrl: urls.phonePairingUrl,
    dashboardUrl: urls.dashboardUrl,
    receiverWsUrl: urls.receiverWsUrl,
    network,
    phoneAppUrl: urls.phoneAppUrl,
    phoneAppDefaultUrl: DEFAULT_PHONE_APP_URL,
    phoneAppMode: PHONE_APP_URL
      ? "custom"
      : (PHONE_APP_ENV ?? "").toLowerCase() === "dev" || PHONE_APP_SCHEME || PHONE_APP_PORT
        ? "dev"
        : "cloud",
    autoAcceptKnown: AUTO_ACCEPT_KNOWN,
    autoAcceptAll: AUTO_ACCEPT_ALL,
    staleCameraTtlMs: STALE_CAMERA_TTL_MS,
    bridgeUrl: BRIDGE_URL,
    bridgeHealth,
    tls: USE_TLS,
    ts: new Date().toISOString(),
  });
});

app.get("/api/network", (req: Request, res: Response) => {
  res.json(networkInfo(selectedNetworkHost(req.query.host)));
});

app.get("/api/cameras", (_req: Request, res: Response) => {
  res.json({ cameras: listCameras(state) });
});

app.get("/api/events", (_req: Request, res: Response) => {
  res.json({ events: eventLog.list() });
});

app.get("/api/known-devices", (_req: Request, res: Response) => {
  res.json({ devices: knownDevices.list() });
});

if ((process.env.RECEIVER_TEST_SHUTDOWN ?? "false").toLowerCase() === "true") {
  app.post("/__test/shutdown", (_req: Request, res: Response) => {
    res.json({ ok: true });
    setTimeout(() => shutdown("test-shutdown"), 10).unref();
  });
}

app.post("/api/cameras/:id/accept", async (req: Request, res: Response) => {
  const id = req.params.id;
  const cam = setCameraStatus(state, id, "accepted");
  if (!cam) {
    res.status(404).json({ ok: false, error: "not-found" });
    return;
  }
  if (bridgeClient) {
    const allocation = await bridgeClient.allocateCamera(cam);
    if (allocation) {
      cam.bridge = allocation;
      publishEvent({
        type: "bridge-allocated",
        sessionId: cam.sessionId,
        deviceId: cam.deviceId,
        name: cam.name,
        message: `Bridge path allocated: ${allocation.path}`,
      });
    }
  }
  const delivered = signaling.sendToCamera(id, {
    type: "accepted",
    sessionId: id,
    bridge: cam.bridge,
  });
  signaling.broadcastCameraUpdate(cam);
  publishEvent({
    type: "accepted",
    sessionId: cam.sessionId,
    deviceId: cam.deviceId,
    name: cam.name,
    message: "Camera accepted by operator",
  });
  res.json({ ok: true, camera: cam, delivered });
});

app.delete("/api/cameras/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  const cam = state.cameras.get(id);
  signaling.closeCameraSocket(id, 1000, "removed");
  const removed = removeCamera(state, id);
  if (bridgeClient && cam) {
    await bridgeClient.removeCamera(cam, true);
  }
  signaling.broadcastCameraList();
  if (removed) {
    publishEvent({
      type: "stale-cleaned",
      sessionId: id,
      message: "Camera session removed by operator",
      reason: "manual-remove",
    });
  }
  res.json({ ok: removed });
});

app.post("/api/cameras/clear-stale", async (_req: Request, res: Response) => {
  const cleaned = await clearStaleCameras(true);
  res.json({ ok: true, cleaned });
});

app.post("/api/known-devices/:deviceId/trust", (req: Request, res: Response) => {
  const deviceId = req.params.deviceId;
  const autoAccept =
    typeof req.body?.autoAccept === "boolean" ? req.body.autoAccept : true;
  const known = knownDevices.updateTrust(deviceId, {
    trusted: true,
    autoAccept,
  });
  if (!known) {
    res.status(404).json({ ok: false, error: "not-found" });
    return;
  }
  for (const cam of state.cameras.values()) {
    if (cam.deviceId === deviceId) {
      cam.trusted = true;
      signaling.broadcastCameraUpdate(cam);
    }
  }
  publishEvent({
    type: "device-trusted",
    deviceId,
    name: known.name,
    message: autoAccept ? "Device trusted for auto-accept" : "Device trusted",
  });
  signaling.broadcastCameraList();
  res.json({ ok: true, device: known });
});

app.post("/api/known-devices/:deviceId/auto-accept", (req: Request, res: Response) => {
  const deviceId = req.params.deviceId;
  const autoAccept = Boolean(req.body?.autoAccept);
  const known = knownDevices.updateTrust(deviceId, {
    trusted: true,
    autoAccept,
  });
  if (!known) {
    res.status(404).json({ ok: false, error: "not-found" });
    return;
  }
  publishEvent({
    type: "device-trusted",
    deviceId,
    name: known.name,
    message: autoAccept ? "Device auto-accept enabled" : "Device auto-accept disabled",
  });
  res.json({ ok: true, device: known });
});

app.delete("/api/known-devices/:deviceId", (req: Request, res: Response) => {
  const deviceId = req.params.deviceId;
  const removed = knownDevices.forget(deviceId);
  if (removed) {
    for (const cam of state.cameras.values()) {
      if (cam.deviceId === deviceId) {
        cam.trusted = false;
        signaling.broadcastCameraUpdate(cam);
      }
    }
    publishEvent({
      type: "device-forgotten",
      deviceId,
      message: "Known device forgotten",
    });
    signaling.broadcastCameraList();
  }
  res.json({ ok: removed });
});

app.get("/api/pair-qr", async (req: Request, res: Response) => {
  try {
    const host = selectedNetworkHost(req.query.host);
    const png = await qrcode.toBuffer(receiverUrls(host).phonePairingUrl, {
      type: "png",
      margin: 1,
      width: 320,
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (err) {
    log("qr error", err);
    res.status(500).json({ ok: false, error: "qr-failed" });
  }
});

app.get("/api/wireguard/status", async (_req: Request, res: Response) => {
  const wg = await getWireGuardStatus();
  res.json({
    ok: true,
    ...wg,
    defaults: {
      ...DEFAULT_WIREGUARD_SETTINGS,
      receiverPort: PORT,
    },
    installCommands: WIREGUARD_INSTALL_COMMANDS,
    warnings: [
      "WireGuard peer configs include private keys. Keep them secret.",
      "A VPN exposes receiver services to VPN peers. Only add phones you trust.",
      "Do not expose receiver, bridge, or RTSP ports directly to the public internet.",
    ],
  });
});

app.post("/api/wireguard/generate", async (req: Request, res: Response) => {
  const wg = await getWireGuardStatus();
  const requestedEndpoint =
    typeof req.body?.publicEndpoint === "string" ? req.body.publicEndpoint.trim() : "";
  const settings = normalizeWireGuardSettings({
    ...req.body,
    publicEndpoint: requestedEndpoint || requestHost(req),
    receiverPort: req.body?.receiverPort ?? PORT,
  });
  const endpointSource = requestedEndpoint ? "provided" : "request-host";
  const settingsKey = wireGuardSettingsKey(settings);
  const forceRegenerate = req.body?.forceRegenerate === true;
  const vpnUrlConfig: ReceiverUrlConfig = {
    ...urlConfig,
    publicHost: settings.receiverVpnIp,
    receiverPort: settings.receiverPort,
    useTls: true,
    phoneAppUrl: DEFAULT_PHONE_APP_URL,
    phoneAppEnv: undefined,
    phoneAppScheme: undefined,
    phoneAppPort: undefined,
  };
  const vpnReceiverWsUrl = `wss://${settings.receiverVpnIp}:${settings.receiverPort}/ws`;
  const vpnDashboardUrl = `https://${settings.receiverVpnIp}:${settings.receiverPort}/`;
  const vpnPairingUrl = buildPhonePairingUrl(vpnUrlConfig, state.code);

  if (!wg.wgInstalled) {
    log("wireguard setup needs install: local wg command not found");
    res.json({
      ok: true,
      status: "needs-install",
      error: "wg-missing",
      wgMissing: true,
      wgInstalled: false,
      wgQuickInstalled: wg.wgQuickInstalled,
      settings,
      endpointSource,
      installCommands: WIREGUARD_INSTALL_COMMANDS,
      vpnReceiverWsUrl,
      vpnDashboardUrl,
      vpnPairingUrl,
      message:
        "WireGuard key generation requires the local wg command. Install WireGuard first, then click Generate again.",
    });
    return;
  }

  if (!forceRegenerate && cachedWireGuardSetup?.settingsKey === settingsKey) {
    log("wireguard setup already generated; returning cached config");
    res.json({
      ...cachedWireGuardSetup.response,
      status: "already-generated",
      message:
        "WireGuard setup already generated. Showing the existing config; use Regenerate setup to create new keys.",
    });
    return;
  }

  try {
    const setup = await generateWireGuardSetup(settings);
    const { server: _server, phone: _phone, ...configOnlySetup } = setup;
    const [wireGuardPeerQr, vpnPairingQr] = await Promise.all([
      qrcode.toDataURL(setup.phoneConfig, {
        margin: 1,
        width: 320,
        color: { dark: "#000000ff", light: "#ffffffff" },
      }),
      qrcode.toDataURL(vpnPairingUrl, {
        margin: 1,
        width: 320,
        color: { dark: "#000000ff", light: "#ffffffff" },
      }),
    ]);
    const response = {
      ok: true,
      status: "generated",
      wgInstalled: true,
      wgQuickInstalled: wg.wgQuickInstalled,
      wgVersion: wg.version,
      endpointSource,
      setup: configOnlySetup,
      wireGuardPeerQr,
      vpnPairingQr,
      vpnPairingUrl,
      vpnReceiverWsUrl,
      vpnDashboardUrl,
      notPersisted: true,
    };
    cachedWireGuardSetup = { settingsKey, response };
    res.json(response);
  } catch (err) {
    log("wireguard generate error", err);
    res.status(500).json({
      ok: false,
      error: "wireguard-generate-failed",
      message: "Failed to generate WireGuard keys/configs with wg.",
    });
  }
});

app.use("/docs", express.static(DOCS_DIR));
app.use(express.static(STATIC_DIR));

app.get("*", (_req: Request, res: Response) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"), (err) => {
    if (err) res.status(404).end();
  });
});

function createServer() {
  if (!USE_TLS) return createHttpServer(app);
  if (!existsSync(TLS_KEY_PATH) || !existsSync(TLS_CERT_PATH)) {
    throw new Error(
      `WSS=true requires a dev certificate. Run "npm run dev:cert" first, or set TLS_KEY_PATH/TLS_CERT_PATH. Missing ${TLS_KEY_PATH} / ${TLS_CERT_PATH}`,
    );
  }
  return createHttpsServer(
    {
      key: readFileSync(TLS_KEY_PATH),
      cert: readFileSync(TLS_CERT_PATH),
    },
    app,
  );
}

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

let signaling: ReturnType<typeof attachSignaling>;

function publishEvent(event: Parameters<typeof eventLog.add>[0]) {
  const saved = eventLog.add(event);
  signaling?.broadcastEvent(saved);
  return saved;
}

async function clearStaleCameras(manual = false) {
  const now = Date.now();
  const stale = listCameras(state).filter((cam) => {
    if (cam.status !== "pending" && cam.status !== "disconnected") return false;
    const lastSeen = Date.parse(cam.lastSeen);
    return Number.isFinite(lastSeen) && now - lastSeen >= STALE_CAMERA_TTL_MS;
  });
  for (const cam of stale) {
    signaling.closeCameraSocket(cam.sessionId, 1000, "stale-cleanup");
    removeCamera(state, cam.sessionId);
    if (bridgeClient) await bridgeClient.removeCamera(cam, false);
    publishEvent({
      type: "stale-cleaned",
      sessionId: cam.sessionId,
      deviceId: cam.deviceId,
      name: cam.name,
      message: "Stale camera session cleaned",
      reason: manual ? "manual-clear-stale" : "ttl-expired",
    });
  }
  if (stale.length > 0) signaling.broadcastCameraList();
  return stale.map((cam) => cam.sessionId);
}

signaling = attachSignaling(wss, {
  state,
  log,
  autoAcceptAll: AUTO_ACCEPT_ALL,
  autoAcceptKnown: AUTO_ACCEPT_KNOWN,
  bridgeClient,
  knownDevices,
  eventLog,
  emitEvent: publishEvent,
});

const staleCleanup = setInterval(() => {
  void clearStaleCameras(false).catch((err) => log("stale cleanup failed", err));
}, Math.min(Math.max(STALE_CAMERA_TTL_MS / 2, 15_000), 60_000));
staleCleanup.unref();

httpServer.listen(PORT, HOST, () => {
  const urls = receiverUrls();
  log(`Knoxnet browser-cam receiver listening on ${httpScheme(USE_TLS)}://${HOST}:${PORT}`);
  log(`WebSocket signaling at ${urls.receiverWsUrl}`);
  log(`Pairing code (one-time print): ${state.code}`);
  log(`Phone app URL: ${urls.phoneAppUrl}`);
  log(`Phone pairing URL: ${urls.phonePairingUrl}`);
  log(`Scan this URL with the iPhone Camera app to open the phone app.`);
  log(`Known device store: ${KNOWN_DEVICES_PATH}`);
  log(`AUTO_ACCEPT_KNOWN=${AUTO_ACCEPT_KNOWN}: trusted devices can reconnect without manual accept.`);
  if (AUTO_ACCEPT_ALL) {
    log("WARNING: AUTO_ACCEPT_ALL=true: any valid pairing-code camera will be auto-accepted.");
  }
  log(`STALE_CAMERA_TTL_MS=${STALE_CAMERA_TTL_MS}`);
  log(`Dashboard:    ${urls.dashboardUrl}`);
  if (BRIDGE_URL) {
    log(`Bridge API:   ${BRIDGE_URL} (RTSP paths appear after accept)`);
  } else {
    log("Bridge API:   disabled. Restart with npm run receiver:dev-phone, or use npm run dev:all for the RTSP bridge too.");
  }
  log(`From now on, the pairing code is redacted: ${redactCode(state.code)}`);

  // Also emit a textual QR to the console for convenience.
  qrcode
    .toString(urls.phonePairingUrl, { type: "terminal", small: true })
    .then((ascii) => {
      log("Scan this QR with the phone camera:\n" + ascii);
    })
    .catch((err) => log("terminal qr failed", err));
});

function shutdown(signal: string): void {
  log(`received ${signal}, shutting down`);
  clearInterval(staleCleanup);
  try {
    for (const ws of wss.clients) ws.terminate();
  } catch {
    // ignore
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// TODO(knoxnet-vms): Knoxnet VMS can later own BRIDGE_URL discovery/lifecycle
// and ingest the camera.bridge.rtspUrl values as managed RTSP camera sources.
