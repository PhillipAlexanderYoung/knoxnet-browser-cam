import { createServer } from "node:http";
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
import { attachSignaling } from "./signaling.js";

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

const state = createPairingState(process.env.PAIRING_CODE);

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

function pairingUrl(): string {
  const wsUrl = `ws://${PUBLIC_HOST}:${PORT}/ws`;
  // The frontend reads ?receiver and ?pair off the URL on load.
  return `http://${PUBLIC_HOST}:${PORT}/?receiver=${encodeURIComponent(wsUrl)}&pair=${state.code}`;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/api/info", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    name: RECEIVER_NAME,
    httpPort: PORT,
    wsPath: "/ws",
    publicHost: PUBLIC_HOST,
    pairingCode: state.code,
    pairingUrl: pairingUrl(),
    autoAccept: AUTO_ACCEPT,
    ts: new Date().toISOString(),
  });
});

app.get("/api/cameras", (_req: Request, res: Response) => {
  res.json({ cameras: listCameras(state) });
});

app.post("/api/cameras/:id/accept", (req: Request, res: Response) => {
  const id = req.params.id;
  const cam = setCameraStatus(state, id, "accepted");
  if (!cam) {
    res.status(404).json({ ok: false, error: "not-found" });
    return;
  }
  const delivered = signaling.sendToCamera(id, {
    type: "accepted",
    sessionId: id,
  });
  signaling.broadcastCameraUpdate(cam);
  res.json({ ok: true, camera: cam, delivered });
});

app.delete("/api/cameras/:id", (req: Request, res: Response) => {
  const id = req.params.id;
  signaling.closeCameraSocket(id, 1000, "removed");
  const removed = removeCamera(state, id);
  signaling.broadcastCameraList();
  res.json({ ok: removed });
});

app.get("/api/pair-qr", async (_req: Request, res: Response) => {
  try {
    const png = await qrcode.toBuffer(pairingUrl(), {
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

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const signaling = attachSignaling(wss, {
  state,
  log,
  autoAccept: AUTO_ACCEPT,
});

httpServer.listen(PORT, HOST, () => {
  const url = pairingUrl();
  log(`Knoxnet browser-cam receiver listening on http://${HOST}:${PORT}`);
  log(`WebSocket signaling at ws://${PUBLIC_HOST}:${PORT}/ws`);
  log(`Pairing code (one-time print): ${state.code}`);
  log(`Pairing URL: ${url}`);
  log(`Open this URL on the phone (must be on the same LAN).`);
  if (AUTO_ACCEPT) log("AUTO_ACCEPT=true: cameras will be auto-accepted on hello.");
  log(`Dashboard:    http://${PUBLIC_HOST}:${PORT}/`);
  log(`From now on, the pairing code is redacted: ${redactCode(state.code)}`);

  // Also emit a textual QR to the console for convenience.
  qrcode
    .toString(url, { type: "terminal", small: true })
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

// TODO(knoxnet-vms): When a camera reaches `streaming` status, a future
// bridge could hand the inbound WebRTC track to a restreamer such as
// mediamtx (WHIP ingest -> RTSP egress). See docs/knoxnet-vms-integration.md.
