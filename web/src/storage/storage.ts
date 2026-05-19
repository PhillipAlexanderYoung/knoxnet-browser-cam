const NS = "knoxnet-browser-cam:";

export interface CameraSettings {
  cameraName: string;
  receiverUrl: string;
  pairingCode: string;
  discoverable: boolean;
  preferredFacingMode: "user" | "environment";
  preferredDeviceId?: string;
  resolution: "480p" | "720p" | "1080p";
  frameRate: 5 | 10 | 15 | 30;
  bitrateKbps: 500 | 1000 | 2000 | 4000;
  audioEnabled: boolean;
  networkMode: "dhcp" | "static";
  staticIp?: string;
  staticSubnet?: string;
  staticGateway?: string;
  staticDns?: string;
}

export const DEFAULT_SETTINGS: CameraSettings = {
  cameraName: "",
  receiverUrl: "",
  pairingCode: "",
  discoverable: true,
  preferredFacingMode: "environment",
  preferredDeviceId: undefined,
  resolution: "720p",
  frameRate: 15,
  bitrateKbps: 2000,
  audioEnabled: false,
  networkMode: "dhcp",
};

function k(key: string): string {
  return NS + key;
}

export function getString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(k(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setString(key: string, value: string): void {
  try {
    localStorage.setItem(k(key), value);
  } catch {
    // ignore quota / privacy errors
  }
}

export function getJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k(key));
    if (raw == null) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) } as T;
  } catch {
    return fallback;
  }
}

export function setJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(k(key), JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function loadSettings(): CameraSettings {
  const stored = getJSON<CameraSettings>("settings", DEFAULT_SETTINGS);
  // Generate a default camera name if missing.
  if (!stored.cameraName) {
    const id = Math.random().toString(36).slice(2, 6);
    stored.cameraName = `phone-cam-${id}`;
  }
  return stored;
}

export function saveSettings(s: CameraSettings): void {
  // Only persist non-sensitive fields per requirements.
  const safe: CameraSettings = {
    cameraName: s.cameraName,
    receiverUrl: s.receiverUrl,
    pairingCode: s.pairingCode,
    discoverable: s.discoverable,
    preferredFacingMode: s.preferredFacingMode,
    preferredDeviceId: s.preferredDeviceId,
    resolution: s.resolution,
    frameRate: s.frameRate,
    bitrateKbps: s.bitrateKbps,
    audioEnabled: s.audioEnabled,
    networkMode: s.networkMode,
    staticIp: s.staticIp,
    staticSubnet: s.staticSubnet,
    staticGateway: s.staticGateway,
    staticDns: s.staticDns,
  };
  setJSON("settings", safe);
}
