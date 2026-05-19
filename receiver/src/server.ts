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
import {
  buildReceiverUrls,
  httpScheme,
  type ReceiverUrlConfig,
} from "./urls.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// When built, server.js lives in dist/, and we want to serve from dist/public.
// When run via tsx, this resolves to src/public.
const STATIC_DIR = path.resolve(__dirname, "public");

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8787);
const RECEIVER_NAME =
  process.env.RECEIVER_NAME ?? `${os.hostname()}-knoxnet-receiver`;
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? detectLanIp() ?? "localhost";
const AUTO_ACCEPT =
  (process.env.AUTO_ACCEPT ?? "false").toLowerCase() === "true";
const BRIDGE_URL = process.env.BRIDGE_URL?.replace(/\/+$/, "");
const USE_TLS =
  (process.env.WSS ?? process.env.HTTPS ?? "false").toLowerCase() === "true";
const PHONE_APP_SCHEME =
  process.env.PHONE_APP_SCHEME ?? (USE_TLS ? "https" : "http");
const PHONE_APP_PORT = Number(process.env.PHONE_APP_PORT ?? 5173);
const PHONE_APP_URL = process.env.PHONE_APP_URL?.replace(/\/+$/, "");
const TLS_KEY_PATH =
  process.env.TLS_KEY_PATH ??
  path.resolve(__dirname, "..", "..", ".cert", "knoxnet-dev.key");
const TLS_CERT_PATH =
  process.env.TLS_CERT_PATH ??
  path.resolve(__dirname, "..", "..", ".cert", "knoxnet-dev.crt");

const state = createPairingState(process.env.PAIRING_CODE);
const urlConfig: ReceiverUrlConfig = {
  publicHost: PUBLIC_HOST,
  receiverPort: PORT,
  useTls: USE_TLS,
  phoneAppUrl: PHONE_APP_URL,
  phoneAppScheme: PHONE_APP_SCHEME,
  phoneAppPort: PHONE_APP_PORT,
};

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[receiver]`, new Date().toISOString(), ...args);
}

function detectLanIp(): string | undefined {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return undefined;
}

function receiverUrls() {
  return buildReceiverUrls(urlConfig, state.code);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
const bridgeClient = createBridgeClient(BRIDGE_URL, log);

app.get("/api/info", (_req: Request, res: Response) => {
  const urls = receiverUrls();
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
    phoneAppUrl: urls.phoneAppUrl,
    autoAccept: AUTO_ACCEPT,
    bridgeUrl: BRIDGE_URL,
    tls: USE_TLS,
    ts: new Date().toISOString(),
  });
});

app.get("/api/cameras", (_req: Request, res: Response) => {
  res.json({ cameras: listCameras(state) });
});

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
    }
  }
  const delivered = signaling.sendToCamera(id, {
    type: "accepted",
    sessionId: id,
  });
  signaling.broadcastCameraUpdate(cam);
  res.json({ ok: true, camera: cam, delivered });
});

app.delete("/api/cameras/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  signaling.closeCameraSocket(id, 1000, "removed");
  const removed = removeCamera(state, id);
  if (bridgeClient) {
    await bridgeClient.removeCamera(id);
  }
  signaling.broadcastCameraList();
  res.json({ ok: removed });
});

app.get("/api/pair-qr", async (_req: Request, res: Response) => {
  try {
    const png = await qrcode.toBuffer(receiverUrls().phonePairingUrl, {
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

const signaling = attachSignaling(wss, {
  state,
  log,
  autoAccept: AUTO_ACCEPT,
  bridgeClient,
});

httpServer.listen(PORT, HOST, () => {
  const urls = receiverUrls();
  log(`Knoxnet browser-cam receiver listening on ${httpScheme(USE_TLS)}://${HOST}:${PORT}`);
  log(`WebSocket signaling at ${urls.receiverWsUrl}`);
  log(`Pairing code (one-time print): ${state.code}`);
  log(`Phone app URL: ${urls.phoneAppUrl}`);
  log(`Phone pairing URL: ${urls.phonePairingUrl}`);
  log(`Scan this URL with the iPhone Camera app to open the phone app.`);
  if (AUTO_ACCEPT) log("AUTO_ACCEPT=true: cameras will be auto-accepted on hello.");
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
