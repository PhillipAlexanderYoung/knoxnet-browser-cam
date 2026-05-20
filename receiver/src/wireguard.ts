import { spawn } from "node:child_process";

export interface WireGuardSettings {
  vpnSubnet: string;
  receiverVpnIp: string;
  phoneVpnIp: string;
  listenPort: number;
  interfaceName: string;
  publicEndpoint: string;
  receiverPort: number;
}

export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface WireGuardGeneratedSetup {
  settings: WireGuardSettings;
  server: WireGuardKeyPair;
  phone: WireGuardKeyPair;
  serverConfig: string;
  phoneConfig: string;
  commands: string;
}

export const DEFAULT_WIREGUARD_SETTINGS: WireGuardSettings = {
  vpnSubnet: "10.44.0.0/24",
  receiverVpnIp: "10.44.0.1",
  phoneVpnIp: "10.44.0.10",
  listenPort: 51820,
  interfaceName: "wg-knoxcam",
  publicEndpoint: "",
  receiverPort: 8787,
};

export const WIREGUARD_INSTALL_COMMANDS = [
  "sudo apt update",
  "sudo apt install -y wireguard ufw",
].join("\n");

export async function getWireGuardStatus(): Promise<{
  wgInstalled: boolean;
  version?: string;
}> {
  try {
    const result = await runCommand("wg", ["--version"]);
    return {
      wgInstalled: true,
      version: result.stdout.split("\n")[0]?.trim() || undefined,
    };
  } catch {
    return { wgInstalled: false };
  }
}

export function normalizeWireGuardSettings(input: unknown): WireGuardSettings {
  const raw = isRecord(input) ? input : {};
  const listenPort = numberInRange(raw.listenPort, 1, 65535)
    ?? DEFAULT_WIREGUARD_SETTINGS.listenPort;
  const receiverPort = numberInRange(raw.receiverPort, 1, 65535)
    ?? DEFAULT_WIREGUARD_SETTINGS.receiverPort;

  return {
    vpnSubnet: stringValue(raw.vpnSubnet, DEFAULT_WIREGUARD_SETTINGS.vpnSubnet),
    receiverVpnIp: stringValue(raw.receiverVpnIp, DEFAULT_WIREGUARD_SETTINGS.receiverVpnIp),
    phoneVpnIp: stringValue(raw.phoneVpnIp, DEFAULT_WIREGUARD_SETTINGS.phoneVpnIp),
    listenPort,
    interfaceName: interfaceNameValue(raw.interfaceName, DEFAULT_WIREGUARD_SETTINGS.interfaceName),
    publicEndpoint: stringValue(raw.publicEndpoint, DEFAULT_WIREGUARD_SETTINGS.publicEndpoint),
    receiverPort,
  };
}

export async function generateWireGuardSetup(
  input: unknown,
): Promise<WireGuardGeneratedSetup> {
  const settings = normalizeWireGuardSettings(input);
  const server = await generateKeyPair();
  const phone = await generateKeyPair();
  const serverConfig = buildServerConfig(settings, server.privateKey, phone.publicKey);
  const phoneConfig = buildPhoneConfig(settings, phone.privateKey, server.publicKey);
  return {
    settings,
    server,
    phone,
    serverConfig,
    phoneConfig,
    commands: buildSetupCommands(settings, serverConfig),
  };
}

function buildServerConfig(
  settings: WireGuardSettings,
  serverPrivateKey: string,
  phonePublicKey: string,
): string {
  return [
    "[Interface]",
    `Address = ${settings.receiverVpnIp}/${subnetPrefix(settings.vpnSubnet)}`,
    `ListenPort = ${settings.listenPort}`,
    `PrivateKey = ${serverPrivateKey}`,
    "",
    "[Peer]",
    "# iPhone",
    `PublicKey = ${phonePublicKey}`,
    `AllowedIPs = ${settings.phoneVpnIp}/32`,
    "",
  ].join("\n");
}

function buildPhoneConfig(
  settings: WireGuardSettings,
  phonePrivateKey: string,
  serverPublicKey: string,
): string {
  return [
    "[Interface]",
    `PrivateKey = ${phonePrivateKey}`,
    `Address = ${settings.phoneVpnIp}/32`,
    "DNS = 1.1.1.1",
    "",
    "[Peer]",
    `PublicKey = ${serverPublicKey}`,
    `Endpoint = ${endpointWithPort(settings.publicEndpoint, settings.listenPort)}`,
    `AllowedIPs = ${settings.receiverVpnIp}/32`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function buildSetupCommands(settings: WireGuardSettings, serverConfig: string): string {
  const configPath = `/etc/wireguard/${settings.interfaceName}.conf`;
  return [
    "# Review these commands before running them on the receiver/VMS host.",
    `# They install WireGuard, write ${configPath}, open only the VPN`,
    `# and receiver service ports, then start wg-quick@${settings.interfaceName}.`,
    "sudo apt update",
    "sudo apt install -y wireguard ufw",
    "sudo install -m 700 -d /etc/wireguard",
    `sudo tee ${configPath} >/dev/null <<'EOF'`,
    serverConfig.trimEnd(),
    "EOF",
    `sudo chmod 600 ${configPath}`,
    `sudo ufw allow ${settings.listenPort}/udp comment 'WireGuard'`,
    `sudo ufw allow in on ${settings.interfaceName} to ${settings.receiverVpnIp} port ${settings.receiverPort} proto tcp comment 'Knoxnet receiver dashboard/WSS'`,
    `sudo ufw allow in on ${settings.interfaceName} to ${settings.receiverVpnIp} port 8790 proto tcp comment 'Knoxnet bridge API'`,
    `sudo ufw allow in on ${settings.interfaceName} to ${settings.receiverVpnIp} port 8554 proto tcp comment 'MediaMTX RTSP over VPN'`,
    `sudo systemctl enable --now wg-quick@${settings.interfaceName}`,
    "sudo wg show",
  ].join("\n");
}

async function generateKeyPair(): Promise<WireGuardKeyPair> {
  const privateKey = (await runCommand("wg", ["genkey"])).stdout.trim();
  const publicKey = (await runCommand("wg", ["pubkey"], privateKey + "\n")).stdout.trim();
  return { privateKey, publicKey };
}

function endpointWithPort(publicEndpoint: string, listenPort: number): string {
  const endpoint = publicEndpoint.trim();
  if (!endpoint) return `<your-public-ip-or-ddns>:${listenPort}`;
  if (/:\d+$/.test(endpoint)) return endpoint;
  return `${endpoint}:${listenPort}`;
}

function subnetPrefix(vpnSubnet: string): number {
  const match = vpnSubnet.match(/\/(\d{1,2})$/);
  if (!match) return 24;
  const prefix = Number(match[1]);
  return Number.isInteger(prefix) && prefix >= 1 && prefix <= 32 ? prefix : 24;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function interfaceNameValue(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return /^[a-zA-Z0-9_.-]{1,15}$/.test(raw) ? raw : fallback;
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runCommand(
  command: string,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
