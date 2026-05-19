import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import { MediaMtxManager } from "./mediamtx.js";
import { CameraRegistry } from "./registry.js";

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
  const offerSdp = contentType.includes("application/json")
    ? String((JSON.parse(raw) as { sdp?: string }).sdp ?? "")
    : raw;

  if (!offerSdp.trim()) {
    json(res, 400, { ok: false, error: "missing-sdp" });
    return;
  }

  try {
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
    registry.markPublishing(cameraId, { whipSessionUrl: location });
    json(res, 200, {
      ok: true,
      camera: registry.get(cameraId),
      sdp: { type: "answer", sdp: answerSdp },
      whipSessionUrl: location,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? "whip-relay-failed";
    registry.markError(cameraId, message);
    json(res, 502, { ok: false, error: "whip-relay-failed", detail: message });
  }
}

const server = createServer(async (req, res) => {
  try {
    const pathname = routePath(req);

    if (req.method === "GET" && pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        service: "knoxnet-browser-cam-bridge",
        mediamtx: await mediaMtx.status(),
        urls: {
          rtspBase: `rtsp://${config.publicHost}:${config.mediaMtxRtspPort}`,
          whipBase: `http://${config.mediaMtxInternalHost}:${config.mediaMtxWebRtcPort}`,
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

    if (req.method === "POST" && pathname === "/api/cameras") {
      const body = JSON.parse(await readBody(req, 64 * 1024)) as {
        cameraId?: string;
        name?: string;
        pathHint?: string;
      };
      if (!body.cameraId) {
        json(res, 400, { ok: false, error: "missing-cameraId" });
        return;
      }
      const camera = registry.allocate({
        cameraId: body.cameraId,
        name: body.name,
        pathHint: body.pathHint,
      });
      json(res, 200, { ok: true, camera });
      return;
    }

    const whipCameraId = extractCameraId(pathname, "/whip");
    if (req.method === "POST" && whipCameraId) {
      await handleWhipRelay(whipCameraId, req, res);
      return;
    }

    const cameraId = extractCameraId(pathname);
    if (req.method === "DELETE" && cameraId) {
      json(res, 200, { ok: registry.remove(cameraId) });
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

server.listen(config.bridgePort, config.bridgeHost, () => {
  log(`HTTP API listening on http://${config.bridgeHost}:${config.bridgePort}`);
  log(`MediaMTX config: ${config.mediaMtxConfigPath}`);
  log(`RTSP URLs use rtsp://${config.publicHost}:${config.mediaMtxRtspPort}/<camera-path>`);
});

async function shutdown(signal: string): Promise<void> {
  log(`received ${signal}, shutting down`);
  server.close();
  await mediaMtx.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
