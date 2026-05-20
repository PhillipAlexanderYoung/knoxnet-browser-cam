import os from "node:os";
import { existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export interface BridgeConfig {
  bridgeHost: string;
  bridgePort: number;
  publicHost: string;
  runtimeDir: string;
  manageMediaMtx: boolean;
  mediaMtxBinary: string;
  mediaMtxConfigPath: string;
  mediaMtxBindHost: string;
  mediaMtxInternalHost: string;
  mediaMtxRtspPort: number;
  mediaMtxApiHost: string;
  mediaMtxApiPort: number;
  mediaMtxWebRtcPort: number;
  mediaMtxWebRtcUdpPort: number;
  mediaMtxAdditionalHosts: string[];
  rtspPathGraceMs: number;
  rtspAuthRequired: boolean;
  rtspUsername: string;
  rtspPassword?: string;
  rtspPasswordFile: string;
  rtspPasswordGenerated: boolean;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
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

export function loadConfig(): BridgeConfig {
  const runtimeDir =
    process.env.BRIDGE_RUNTIME_DIR ??
    path.resolve(process.cwd(), ".runtime");
  const publicHost =
    process.env.BRIDGE_PUBLIC_HOST ??
    process.env.PUBLIC_HOST ??
    detectLanIp() ??
    "localhost";
  const rtspAuthRequired = envBool("RTSP_AUTH_REQUIRED", true);
  const rtspPasswordFile =
    process.env.RTSP_PASSWORD_FILE ?? path.join(runtimeDir, "rtsp-password");
  const rtspCredentials = rtspAuthRequired
    ? loadRtspCredentials(runtimeDir, rtspPasswordFile)
    : { password: process.env.RTSP_PASSWORD?.trim() || undefined, generated: false };

  return {
    bridgeHost: process.env.BRIDGE_HOST ?? "127.0.0.1",
    bridgePort: envNumber("BRIDGE_HTTP_PORT", 8790),
    publicHost,
    runtimeDir,
    manageMediaMtx: envBool("MEDIAMTX_MANAGE_PROCESS", true),
    mediaMtxBinary: process.env.MEDIAMTX_BINARY ?? defaultMediaMtxBinary(),
    mediaMtxConfigPath:
      process.env.MEDIAMTX_CONFIG_PATH ??
      path.join(runtimeDir, "mediamtx.yml"),
    mediaMtxBindHost: process.env.MEDIAMTX_BIND_HOST ?? "0.0.0.0",
    mediaMtxInternalHost: process.env.MEDIAMTX_INTERNAL_HOST ?? "127.0.0.1",
    mediaMtxRtspPort: envNumber("MEDIAMTX_RTSP_PORT", 8554),
    mediaMtxApiHost: process.env.MEDIAMTX_API_HOST ?? "127.0.0.1",
    mediaMtxApiPort: envNumber("MEDIAMTX_API_PORT", 9997),
    mediaMtxWebRtcPort: envNumber("MEDIAMTX_WEBRTC_PORT", 8889),
    mediaMtxWebRtcUdpPort: envNumber("MEDIAMTX_WEBRTC_UDP_PORT", 8189),
    mediaMtxAdditionalHosts: (process.env.MEDIAMTX_WEBRTC_ADDITIONAL_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    rtspPathGraceMs: envNumber("RTSP_PATH_GRACE_MS", 10 * 60_000),
    rtspAuthRequired,
    rtspUsername: process.env.RTSP_USERNAME?.trim() || "knoxnet",
    rtspPassword: rtspCredentials.password,
    rtspPasswordFile,
    rtspPasswordGenerated: rtspCredentials.generated,
  };
}

export function rotateRtspPassword(config: BridgeConfig): { password: string; passwordFile: string } {
  if (process.env.RTSP_PASSWORD?.trim()) {
    throw new Error("rtsp-password-env-managed");
  }
  const password = randomBytes(24).toString("base64url");
  mkdirSync(path.dirname(config.rtspPasswordFile) || config.runtimeDir, {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(config.rtspPasswordFile, `${password}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(config.rtspPasswordFile, 0o600);
  } catch {
    // Best effort only; file creation mode is the primary protection.
  }
  config.rtspPassword = password;
  config.rtspPasswordGenerated = true;
  return { password, passwordFile: config.rtspPasswordFile };
}

function loadRtspCredentials(
  runtimeDir: string,
  passwordFile: string,
): { password: string; generated: boolean } {
  const envPassword = process.env.RTSP_PASSWORD?.trim();
  if (envPassword) return { password: envPassword, generated: false };

  try {
    const existing = readFileSync(passwordFile, "utf8").trim();
    if (existing) {
      try {
        chmodSync(passwordFile, 0o600);
      } catch {
        // Best effort only; config generation should still work on non-POSIX filesystems.
      }
      return { password: existing, generated: false };
    }
  } catch {
    // Missing or unreadable files fall through to first-start generation.
  }

  mkdirSync(path.dirname(passwordFile) || runtimeDir, { recursive: true, mode: 0o700 });
  const password = randomBytes(24).toString("base64url");
  writeFileSync(passwordFile, `${password}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(passwordFile, 0o600);
  } catch {
    // Best effort only; the file mode above is the primary protection.
  }
  return { password, generated: true };
}

function defaultMediaMtxBinary(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "Knoxnet-VMS", "mediamtx", "mediamtx"),
    path.resolve(process.cwd(), "..", "..", "Knoxnet-VMS", "mediamtx", "mediamtx"),
    "/home/operator1/Documents/Knoxnet-VMS/mediamtx/mediamtx",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "mediamtx";
}

export function socketAddress(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") return `:${port}`;
  return `${host}:${port}`;
}

export function rtspUrlForPath(
  config: BridgeConfig,
  cameraPath: string,
  opts: { credentials?: "none" | "redacted" | "full" } = {},
): string {
  const base = `${config.publicHost}:${config.mediaMtxRtspPort}/${cameraPath}`;
  const mode = opts.credentials ?? "none";
  if (!config.rtspAuthRequired || mode === "none") return `rtsp://${base}`;

  const username = encodeURIComponent(config.rtspUsername);
  const password = mode === "full"
    ? encodeURIComponent(config.rtspPassword ?? "")
    : "****";
  return `rtsp://${username}:${password}@${base}`;
}
