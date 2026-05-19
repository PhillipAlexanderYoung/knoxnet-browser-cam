import os from "node:os";
import { existsSync } from "node:fs";
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
  };
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
