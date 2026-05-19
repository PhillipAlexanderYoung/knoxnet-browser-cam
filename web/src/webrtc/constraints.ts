export type ResolutionKey = "480p" | "720p" | "1080p";

export const RESOLUTION_PRESETS: Record<
  ResolutionKey,
  { width: number; height: number; label: string }
> = {
  "480p": { width: 854, height: 480, label: "854 x 480" },
  "720p": { width: 1280, height: 720, label: "1280 x 720 (HD)" },
  "1080p": { width: 1920, height: 1080, label: "1920 x 1080 (FHD)" },
};

export const FRAME_RATE_OPTIONS = [5, 10, 15, 30] as const;
export type FrameRate = (typeof FRAME_RATE_OPTIONS)[number];

export const BITRATE_OPTIONS = [500, 1000, 2000, 4000] as const;
export type BitrateKbps = (typeof BITRATE_OPTIONS)[number];

export function bitrateLabel(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toString()} Mbps`;
  return `${kbps} Kbps`;
}

export function buildVideoConstraints(opts: {
  facingMode?: "user" | "environment";
  deviceId?: string;
  resolution: ResolutionKey;
  frameRate: FrameRate;
}): MediaTrackConstraints {
  const preset = RESOLUTION_PRESETS[opts.resolution];
  const constraints: MediaTrackConstraints = {
    width: { ideal: preset.width },
    height: { ideal: preset.height },
    frameRate: { ideal: opts.frameRate },
  };
  if (opts.deviceId) {
    constraints.deviceId = { exact: opts.deviceId };
  } else if (opts.facingMode) {
    constraints.facingMode = { ideal: opts.facingMode };
  }
  return constraints;
}
