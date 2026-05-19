export interface ReceiverUrlConfig {
  publicHost: string;
  receiverPort: number;
  useTls: boolean;
  phoneAppUrl?: string;
  phoneAppScheme?: string;
  phoneAppPort?: number;
}

export interface ReceiverUrls {
  dashboardUrl: string;
  receiverWsUrl: string;
  phoneAppUrl: string;
  phonePairingUrl: string;
}

export function httpScheme(useTls: boolean): "http" | "https" {
  return useTls ? "https" : "http";
}

export function wsScheme(useTls: boolean): "ws" | "wss" {
  return useTls ? "wss" : "ws";
}

export function buildDashboardUrl(config: ReceiverUrlConfig): string {
  return `${httpScheme(config.useTls)}://${config.publicHost}:${config.receiverPort}/`;
}

export function buildReceiverWsUrl(config: ReceiverUrlConfig): string {
  return `${wsScheme(config.useTls)}://${config.publicHost}:${config.receiverPort}/ws`;
}

export function buildPhoneAppUrl(config: ReceiverUrlConfig): string {
  const explicit = config.phoneAppUrl?.replace(/\/+$/, "");
  if (explicit) return explicit;

  const scheme = config.phoneAppScheme ?? (config.useTls ? "https" : "http");
  const port = config.phoneAppPort ?? 5173;
  return `${scheme}://${config.publicHost}:${port}`;
}

export function buildPhonePairingUrl(
  config: ReceiverUrlConfig,
  pairingCode: string,
): string {
  const url = new URL(buildPhoneAppUrl(config));
  url.searchParams.set("receiver", buildReceiverWsUrl(config));
  url.searchParams.set("pair", pairingCode);
  url.searchParams.set("autostart", "1");
  return url.toString();
}

export function buildReceiverUrls(
  config: ReceiverUrlConfig,
  pairingCode: string,
): ReceiverUrls {
  return {
    dashboardUrl: buildDashboardUrl(config),
    receiverWsUrl: buildReceiverWsUrl(config),
    phoneAppUrl: buildPhoneAppUrl(config),
    phonePairingUrl: buildPhonePairingUrl(config, pairingCode),
  };
}
