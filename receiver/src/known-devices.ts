import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface KnownDevice {
  deviceId: string;
  name: string;
  displayName?: string;
  firstSeen: string;
  lastSeen: string;
  trusted: boolean;
  autoAccept: boolean;
  lastSessionId?: string;
  settings?: DeviceSettings;
  settingsUpdatedAt?: string;
  lastSettingsAck?: {
    id: string;
    accepted: boolean;
    ts: string;
    message?: string;
  };
}

export interface DeviceSettings {
  displayName?: string;
  resolution?: "auto" | "480p" | "720p" | "1080p";
  frameRate?: 5 | 10 | 15 | 30;
  bitrateKbps?: 500 | 1000 | 2000 | 4000;
  audioEnabled?: boolean;
  preferredFacingMode?: "user" | "environment";
}

interface KnownDevicesFile {
  devices?: KnownDevice[];
}

export interface KnownDeviceStore {
  list: () => KnownDevice[];
  get: (deviceId: string | undefined) => KnownDevice | undefined;
  upsertSeen: (params: {
    deviceId: string;
    name: string;
    sessionId: string;
  }) => KnownDevice;
  updateTrust: (
    deviceId: string,
    patch: { trusted?: boolean; autoAccept?: boolean },
  ) => KnownDevice | undefined;
  updateDevice: (
    deviceId: string,
    patch: {
      name?: string;
      displayName?: string;
      trusted?: boolean;
      autoAccept?: boolean;
      settings?: DeviceSettings;
    },
  ) => KnownDevice | undefined;
  recordSettingsAck: (
    deviceId: string,
    ack: { id: string; accepted: boolean; message?: string },
  ) => KnownDevice | undefined;
  forget: (deviceId: string) => boolean;
}

function sanitizeDeviceId(deviceId: string | undefined): string | null {
  const value = deviceId?.trim();
  if (!value) return null;
  return /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : null;
}

export function createKnownDeviceStore(filePath: string): KnownDeviceStore {
  const devices = new Map<string, KnownDevice>();

  function load(): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as KnownDevicesFile;
      for (const entry of parsed.devices ?? []) {
        const id = sanitizeDeviceId(entry.deviceId);
        if (!id) continue;
        devices.set(id, {
          deviceId: id,
          name: entry.name || `phone-cam-${id.slice(0, 4)}`,
          displayName: entry.displayName,
          firstSeen: entry.firstSeen || new Date().toISOString(),
          lastSeen: entry.lastSeen || new Date().toISOString(),
          trusted: Boolean(entry.trusted),
          autoAccept: Boolean(entry.autoAccept),
          lastSessionId: entry.lastSessionId,
          settings: sanitizeSettings(entry.settings),
          settingsUpdatedAt: entry.settingsUpdatedAt,
          lastSettingsAck: entry.lastSettingsAck,
        });
      }
    } catch {
      // Corrupt local metadata should not stop the receiver from starting.
    }
  }

  function save(): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const body: KnownDevicesFile = {
      devices: Array.from(devices.values()).sort((a, b) =>
        a.firstSeen.localeCompare(b.firstSeen),
      ),
    };
    writeFileSync(filePath, JSON.stringify(body, null, 2) + "\n", "utf8");
  }

  load();

  return {
    list() {
      return Array.from(devices.values()).sort((a, b) =>
        b.lastSeen.localeCompare(a.lastSeen),
      );
    },

    get(deviceId) {
      const id = sanitizeDeviceId(deviceId);
      return id ? devices.get(id) : undefined;
    },

    upsertSeen({ deviceId, name, sessionId }) {
      const id = sanitizeDeviceId(deviceId);
      if (!id) {
        throw new Error("invalid-device-id");
      }
      const now = new Date().toISOString();
      const existing = devices.get(id);
      const next: KnownDevice = existing
        ? {
            ...existing,
            name: existing.displayName || name || existing.name,
            lastSeen: now,
            lastSessionId: sessionId,
          }
        : {
            deviceId: id,
            name: name || `phone-cam-${id.slice(0, 4)}`,
            firstSeen: now,
            lastSeen: now,
            trusted: false,
            autoAccept: false,
            lastSessionId: sessionId,
          };
      devices.set(id, next);
      save();
      return next;
    },

    updateTrust(deviceId, patch) {
      const id = sanitizeDeviceId(deviceId);
      if (!id) return undefined;
      const existing = devices.get(id);
      if (!existing) return undefined;
      const next = {
        ...existing,
        trusted: patch.trusted ?? existing.trusted,
        autoAccept: patch.autoAccept ?? existing.autoAccept,
      };
      devices.set(id, next);
      save();
      return next;
    },

    updateDevice(deviceId, patch) {
      const id = sanitizeDeviceId(deviceId);
      if (!id) return undefined;
      const existing = devices.get(id);
      if (!existing) return undefined;
      const settings = sanitizeSettings(patch.settings);
      const now = new Date().toISOString();
      const next: KnownDevice = {
        ...existing,
        name: patch.displayName || patch.name || existing.name,
        displayName: patch.displayName ?? existing.displayName,
        trusted: patch.trusted ?? existing.trusted,
        autoAccept: patch.autoAccept ?? existing.autoAccept,
        settings: settings
          ? {
              ...existing.settings,
              ...settings,
              displayName: patch.displayName ?? settings.displayName ?? existing.settings?.displayName,
            }
          : existing.settings,
        settingsUpdatedAt: settings || patch.displayName ? now : existing.settingsUpdatedAt,
      };
      devices.set(id, next);
      save();
      return next;
    },

    recordSettingsAck(deviceId, ack) {
      const id = sanitizeDeviceId(deviceId);
      if (!id) return undefined;
      const existing = devices.get(id);
      if (!existing) return undefined;
      const next: KnownDevice = {
        ...existing,
        lastSettingsAck: {
          id: ack.id,
          accepted: ack.accepted,
          message: ack.message,
          ts: new Date().toISOString(),
        },
      };
      devices.set(id, next);
      save();
      return next;
    },

    forget(deviceId) {
      const id = sanitizeDeviceId(deviceId);
      if (!id) return false;
      const removed = devices.delete(id);
      if (removed) save();
      return removed;
    },
  };
}

function sanitizeSettings(value: unknown): DeviceSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as DeviceSettings;
  const next: DeviceSettings = {};
  if (typeof raw.displayName === "string" && raw.displayName.trim()) {
    next.displayName = raw.displayName.trim().slice(0, 80);
  }
  if (["auto", "480p", "720p", "1080p"].includes(String(raw.resolution))) {
    next.resolution = raw.resolution;
  }
  if ([5, 10, 15, 30].includes(Number(raw.frameRate))) {
    next.frameRate = Number(raw.frameRate) as DeviceSettings["frameRate"];
  }
  if ([500, 1000, 2000, 4000].includes(Number(raw.bitrateKbps))) {
    next.bitrateKbps = Number(raw.bitrateKbps) as DeviceSettings["bitrateKbps"];
  }
  if (typeof raw.audioEnabled === "boolean") {
    next.audioEnabled = raw.audioEnabled;
  }
  if (raw.preferredFacingMode === "user" || raw.preferredFacingMode === "environment") {
    next.preferredFacingMode = raw.preferredFacingMode;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
