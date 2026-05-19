import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { MediaMtxManager } from "./mediamtx.js";
import { CameraRegistry, type CameraQualityInfo } from "./registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.resolve(__dirname, "public");

const config = loadConfig();
const mediaMtx = new MediaMtxManager(config);
const registry = new CameraRegistry(config);

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[bridge]", new Date().toISOString(), ...args);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "dashboard.css", "dashboard.js"].includes(fileName)) {
    return false;
  }

  try {
    const filePath = path.join(STATIC_DIR, fileName);
    const payload = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": payload.byteLength,
      "Cache-Control": fileName === "index.html" ? "no-store" : "public, max-age=60",
    });
    res.end(payload);
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limitBytes = 512 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.byteLength;
    if (size > limitBytes) throw new Error("body-too-large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function routePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.pathname;
}

function extractCameraId(pathname: string, suffix = ""): string | null {
  const prefix = "/api/cameras/";
  if (!pathname.startsWith(prefix)) return null;
  if (suffix && !pathname.endsWith(suffix)) return null;
  const raw = suffix
    ? pathname.slice(prefix.length, -suffix.length)
    : pathname.slice(prefix.length);
  if (!raw || raw.includes("/")) return null;
  return decodeURIComponent(raw);
}

async function handleWhipRelay(
  cameraId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const camera = registry.get(cameraId);
  if (!camera) {
    json(res, 404, { ok: false, error: "camera-not-allocated" });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  const raw = await readBody(req);
  const body = contentType.includes("application/json")
    ? (JSON.parse(raw) as { sdp?: string; quality?: unknown })
    : null;
  const offerSdp = body ? String(body.sdp ?? "") : raw;

  if (!offerSdp.trim()) {
    json(res, 400, { ok: false, error: "missing-sdp" });
    return;
  }

  try {
    log(`WHIP offer received cameraId=${cameraId} path=${camera.path}`);
    if (camera.whipSessionUrl) {
      try {
        await fetch(new URL(camera.whipSessionUrl, camera.whipUrl), { method: "DELETE" });
        log(`previous WHIP publisher closed cameraId=${cameraId} path=${camera.path}`);
      } catch (err) {
        log(`previous WHIP publisher cleanup failed cameraId=${cameraId}:`, err);
      }
    }
    const upstream = await fetch(camera.whipUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Accept: "application/sdp",
      },
      body: offerSdp,
    });
    const answerSdp = await upstream.text();
    if (!upstream.ok) {
      throw new Error(`mediamtx-whip-${upstream.status}: ${answerSdp.slice(0, 200)}`);
    }
    const location = upstream.headers.get("location") ?? undefined;
    registry.markPublishing(cameraId, {
      whipSessionUrl: location,
      quality: body?.quality as CameraQualityInfo | undefined,
    });
    log(`WHIP publish accepted cameraId=${cameraId} rtsp=${camera.rtspUrl}`);
    json(res, 200, {
      ok: true,
      camera: registry.get(cameraId),
      sdp: { type: "answer", sdp: answerSdp },
      whipSessionUrl: location,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? "whip-relay-failed";
    registry.markError(cameraId, message);
    log(`WHIP publish failed cameraId=${cameraId}: ${message}`);
    json(res, 502, { ok: false, error: "whip-relay-failed", detail: message });
  }
}

const server = createServer(async (req, res) => {
  try {
    const pathname = routePath(req);

    if (req.method === "GET" && (await serveStatic(res, pathname))) {
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        service: "knoxnet-browser-cam-bridge",
        mediamtx: await mediaMtx.status(),
        rtspPathGraceMs: config.rtspPathGraceMs,
        urls: {
          rtspBase: `rtsp://${config.publicHost}:${config.mediaMtxRtspPort}`,
          whipBase: `http://${config.mediaMtxInternalHost}:${config.mediaMtxWebRtcPort}`,
          webRtcBase: `http://${config.publicHost}:${config.mediaMtxWebRtcPort}`,
          hlsBase: null,
        },
        cameras: registry.list(),
        ts: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/cameras") {
      json(res, 200, { cameras: registry.list() });
      return;
    }

    const cameraId = extractCameraId(pathname);
    if (req.method === "GET" && cameraId) {
      const camera = registry.get(cameraId);
      if (!camera) {
        json(res, 404, { ok: false, error: "not-found" });
        return;
      }
      json(res, 200, { ok: true, camera });
      return;
    }

    if (req.method === "POST" && pathname === "/api/cameras") {
      const body = JSON.parse(await readBody(req, 64 * 1024)) as {
        cameraId?: string;
        sessionId?: string;
        deviceId?: string;
        name?: string;
        pathHint?: string;
        quality?: CameraQualityInfo;
      };
      if (!body.cameraId) {
        json(res, 400, { ok: false, error: "missing-cameraId" });
        return;
      }
      const camera = registry.allocate({
        cameraId: body.cameraId,
        sessionId: body.sessionId,
        deviceId: body.deviceId,
        name: body.name,
        pathHint: body.pathHint,
        quality: body.quality,
      });
      log(`allocated cameraId=${camera.cameraId} path=${camera.path} rtsp=${camera.rtspUrl}`);
      json(res, 200, { ok: true, camera });
      return;
    }

    const whipCameraId = extractCameraId(pathname, "/whip");
    if (req.method === "POST" && whipCameraId) {
      await handleWhipRelay(whipCameraId, req, res);
      return;
    }

    const offlineCameraId = extractCameraId(pathname, "/offline");
    if (req.method === "POST" && offlineCameraId) {
      let reason = "publisher-offline";
      try {
        const body = JSON.parse(await readBody(req, 64 * 1024) || "{}") as {
          reason?: string;
        };
        reason = body.reason || reason;
      } catch {
        // Keep the default reason when the body is empty or malformed.
      }
      const camera = registry.markOffline(
        offlineCameraId,
        `${reason}; stable RTSP URL retained for ${Math.round(config.rtspPathGraceMs / 1000)}s.`,
      );
      if (!camera) {
        json(res, 404, { ok: false, error: "not-found" });
        return;
      }
      log(`marked offline cameraId=${offlineCameraId} path=${camera.path}`);
      json(res, 200, { ok: true, camera });
      return;
    }

    if (req.method === "DELETE" && cameraId) {
      const permanent = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
        .searchParams.get("permanent") === "1";
      json(res, 200, { ok: registry.remove(cameraId, { permanent }) });
      return;
    }

    json(res, 404, { ok: false, error: "not-found" });
  } catch (err) {
    json(res, 500, {
      ok: false,
      error: "internal-error",
      detail: (err as Error)?.message ?? String(err),
    });
  }
});

await mediaMtx.start();

const cleanupTimer = setInterval(() => {
  const removed = registry.cleanupExpired();
  for (const cameraId of removed) {
    log(`expired retained RTSP path cameraId=${cameraId}`);
  }
}, Math.min(Math.max(config.rtspPathGraceMs / 2, 30_000), 60_000));
cleanupTimer.unref();

server.listen(config.bridgePort, config.bridgeHost, () => {
  log(`HTTP API listening on http://${config.bridgeHost}:${config.bridgePort}`);
  log(`MediaMTX config: ${config.mediaMtxConfigPath}`);
  log(`RTSP URLs use rtsp://${config.publicHost}:${config.mediaMtxRtspPort}/<camera-path>`);
});

async function shutdown(signal: string): Promise<void> {
  log(`received ${signal}, shutting down`);
  clearInterval(cleanupTimer);
  server.close();
  await mediaMtx.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
