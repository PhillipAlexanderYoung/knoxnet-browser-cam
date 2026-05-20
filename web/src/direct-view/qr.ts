import QRCode from "qrcode";

const DIRECT_VIEW_TOKEN_RE = /^[A-Za-z0-9_-]{16,160}$/;
const PAIRING_CODE_RE = /^[A-Z0-9]{4,32}$/;

export type DirectViewQrResult =
  | { type: "direct-view"; roomToken: string }
  | { type: "receiver"; receiverUrl: string; pairingCode: string; autostart: boolean };

export async function qrDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    width: 220,
    margin: 1,
    color: {
      dark: "#0a0b0d",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });
}

export function isDirectViewRoomToken(value: string): boolean {
  return DIRECT_VIEW_TOKEN_RE.test(value.trim());
}

export function parseDirectViewInvite(value: string): string | null {
  const trimmed = value.trim();
  if (isDirectViewRoomToken(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed, window.location.origin);
    if (url.origin !== window.location.origin && url.origin !== "https://cam.knoxnetvms.com") {
      return null;
    }

    const match = url.pathname.match(/^\/join\/([^/]+)$/);
    if (!match) return null;

    const token = decodeURIComponent(match[1]);
    return isDirectViewRoomToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function parseReceiverPairingInvite(value: string): Extract<DirectViewQrResult, { type: "receiver" }> | null {
  try {
    const url = new URL(value.trim(), window.location.origin);
    const receiverUrl = url.searchParams.get("receiver")?.trim();
    const pairingCode = url.searchParams.get("pair")?.trim().toUpperCase();
    if (!receiverUrl || !pairingCode || !PAIRING_CODE_RE.test(pairingCode)) {
      return null;
    }

    const receiver = new URL(receiverUrl);
    if (receiver.protocol !== "ws:" && receiver.protocol !== "wss:") {
      return null;
    }

    const autostart = url.searchParams.get("autostart");
    return {
      type: "receiver",
      receiverUrl: receiver.toString(),
      pairingCode,
      autostart: autostart === "1" || autostart === "true",
    };
  } catch {
    return null;
  }
}

export function parseQrInvite(value: string): DirectViewQrResult | null {
  const receiver = parseReceiverPairingInvite(value);
  if (receiver) return receiver;

  const roomToken = parseDirectViewInvite(value);
  return roomToken ? { type: "direct-view", roomToken } : null;
}
