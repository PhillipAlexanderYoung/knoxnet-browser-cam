import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, rotateRtspPassword, rtspUrlForPath } from "./config.js";
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

  let upstreamStatus: number | undefined;
  let upstreamBody = "";
  const offerSummary = summarizeSdp(offerSdp);
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
    upstreamStatus = upstream.status;
    const answerSdp = await upstream.text();
    upstreamBody = answerSdp;
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
    const diagnostics = {
      attemptedWhipUrl: camera.whipUrl,
      mediamtx: await mediaMtx.status(),
      httpStatus: upstreamStatus ?? null,
      httpBody: upstreamBody ? upstreamBody.slice(0, 2000) : null,
      offerSummary,
      configuredPorts: {
        rtsp: config.mediaMtxRtspPort,
        webrtc: config.mediaMtxWebRtcPort,
        webrtcUdp: config.mediaMtxWebRtcUdpPort,
        api: config.mediaMtxApiPort,
      },
      recentLogs: mediaMtx.recentLogs(25),
    };
    registry.markError(cameraId, message, diagnostics);
    log(`WHIP publish failed cameraId=${cameraId}: ${message}`);
    json(res, 502, {
      ok: false,
      error: "whip-relay-failed",
      detail: message,
      diagnostics,
      camera: registry.get(cameraId),
    });
  }
}

function summarizeSdp(sdp: string): Record<string, unknown> {
  const lines = sdp.split(/\r?\n/);
  const candidates = lines.filter((line) => line.startsWith("a=candidate:"));
  const media = lines.filter((line) => line.startsWith("m="));
  const codecs = lines
    .filter((line) => line.startsWith("a=rtpmap:"))
    .map((line) => line.slice("a=rtpmap:".length))
    .slice(0, 20);
  return {
    bytes: Buffer.byteLength(sdp),
    media,
    candidateCount: candidates.length,
    candidateTypes: Array.from(
      new Set(
        candidates
          .map((line) => line.match(/\styp\s+([a-z0-9]+)/i)?.[1])
          .filter(Boolean),
      ),
    ),
    codecs,
    hasIceUfrag: lines.some((line) => line.startsWith("a=ice-ufrag:")),
    hasFingerprint: lines.some((line) => line.startsWith("a=fingerprint:")),
  };
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
        rtspAuth: {
          required: config.rtspAuthRequired,
          username: config.rtspAuthRequired ? config.rtspUsername : null,
          passwordFile: config.rtspAuthRequired && !process.env.RTSP_PASSWORD
            ? config.rtspPasswordFile
            : null,
          generated: config.rtspPasswordGenerated,
        },
        urls: {
          rtspBase: `rtsp://${config.publicHost}:${config.mediaMtxRtspPort}`,
          rtspBaseRedacted: config.rtspAuthRequired
            ? `rtsp://${encodeURIComponent(config.rtspUsername)}:****@${config.publicHost}:${config.mediaMtxRtspPort}`
            : `rtsp://${config.publicHost}:${config.mediaMtxRtspPort}`,
          whipBase: `http://${config.mediaMtxInternalHost}:${config.mediaMtxWebRtcPort}`,
          webRtcBase: `http://${config.publicHost}:${config.mediaMtxWebRtcPort}`,
          hlsBase: null,
        },
        cameras: registry.list(),
        ts: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/logs") {
      json(res, 200, {
        ok: true,
        mediamtx: await mediaMtx.status(),
        logs: mediaMtx.recentLogs(80),
        cameras: registry.list().map((camera) => ({
          cameraId: camera.cameraId,
          path: camera.path,
          ingestStatus: camera.ingestStatus,
          lastError: camera.lastError,
          diagnostics: camera.diagnostics,
          updatedAt: camera.updatedAt,
        })),
        ts: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/rtsp-auth") {
      json(res, 200, {
        ok: true,
        required: config.rtspAuthRequired,
        username: config.rtspAuthRequired ? config.rtspUsername : null,
        password: config.rtspAuthRequired ? config.rtspPassword : null,
        passwordFile: config.rtspAuthRequired && !process.env.RTSP_PASSWORD
          ? config.rtspPasswordFile
          : null,
        generated: config.rtspPasswordGenerated,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/rtsp-auth/rotate") {
      if (!config.rtspAuthRequired) {
        json(res, 400, { ok: false, error: "rtsp-auth-disabled" });
        return;
      }
      try {
        const rotated = rotateRtspPassword(config);
        await mediaMtx.restart();
        for (const camera of registry.list()) {
          camera.rtspUrl = rtspUrlForPath(config, camera.path);
          camera.rtspUrlRedacted = rtspUrlForPath(config, camera.path, {
            credentials: "redacted",
          });
        }
        json(res, 200, {
          ok: true,
          required: true,
          username: config.rtspUsername,
          password: rotated.password,
          passwordFile: rotated.passwordFile,
          generated: config.rtspPasswordGenerated,
          mediamtx: await mediaMtx.status(),
        });
      } catch (err) {
        const detail = (err as Error)?.message ?? String(err);
        const status = detail === "rtsp-password-env-managed" ? 409 : 500;
        json(res, status, {
          ok: false,
          error: detail,
          message:
            detail === "rtsp-password-env-managed"
              ? "RTSP_PASSWORD is set in the environment; rotate by changing that secret and restarting."
              : "RTSP credential rotation failed.",
        });
      }
      return;
    }

    const cameraRtspUrlId = extractCameraId(pathname, "/rtsp-url");
    if (req.method === "GET" && cameraRtspUrlId) {
      const camera = registry.get(cameraRtspUrlId);
      if (!camera) {
        json(res, 404, { ok: false, error: "not-found" });
        return;
      }
      const includeCredentials =
        new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
          .searchParams.get("credentials") === "1";
      json(res, 200, {
        ok: true,
        url: rtspUrlForPath(config, camera.path, {
          credentials: includeCredentials ? "full" : "none",
        }),
        authRequired: config.rtspAuthRequired,
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

if (config.rtspAuthRequired) {
  log(`RTSP auth enabled username=${config.rtspUsername}`);
  if (config.rtspPasswordGenerated) {
    log(`Generated RTSP password saved to ${config.rtspPasswordFile}`);
    log(`RTSP password: ${config.rtspPassword}`);
  } else if (!process.env.RTSP_PASSWORD) {
    log(`RTSP password loaded from ${config.rtspPasswordFile}`);
  }
} else {
  log("WARNING: RTSP auth disabled. Anyone on this network who can reach RTSP may view streams.");
}

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
  log(`RTSP URLs use ${rtspUrlForPath(config, "<camera-path>", { credentials: "redacted" })}`);
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
