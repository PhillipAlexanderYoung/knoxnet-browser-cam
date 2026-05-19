import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface KnownDevice {
  deviceId: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  trusted: boolean;
  autoAccept: boolean;
  lastSessionId?: string;
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
          firstSeen: entry.firstSeen || new Date().toISOString(),
          lastSeen: entry.lastSeen || new Date().toISOString(),
          trusted: Boolean(entry.trusted),
          autoAccept: Boolean(entry.autoAccept),
          lastSessionId: entry.lastSessionId,
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
            name: name || existing.name,
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

    forget(deviceId) {
      const id = sanitizeDeviceId(deviceId);
      if (!id) return false;
      const removed = devices.delete(id);
      if (removed) save();
      return removed;
    },
  };
}
