#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}

const settings = {
  vpnSubnet: args.get("subnet") || "10.44.0.0/24",
  receiverVpnIp: args.get("receiver-ip") || "10.44.0.1",
  phoneVpnIp: args.get("phone-ip") || "10.44.0.10",
  listenPort: Number(args.get("port") || 51820),
  publicEndpoint: args.get("endpoint") || "<your-public-ip-or-ddns>",
  receiverPort: Number(args.get("receiver-port") || 8787),
};

if (args.has("help")) {
  console.log(`Usage: node receiver/scripts/wireguard-setup.mjs [options]

Generates WireGuard server/iPhone configs using the local wg command.
No privileged commands are run.

Options:
  --endpoint <host>        Public IP or DDNS for the receiver
  --subnet <cidr>          VPN subnet (default 10.44.0.0/24)
  --receiver-ip <ip>       Receiver VPN IP (default 10.44.0.1)
  --phone-ip <ip>          iPhone VPN IP (default 10.44.0.10)
  --port <udp-port>        WireGuard UDP listen port (default 51820)
  --receiver-port <port>   Receiver HTTPS/WSS port (default 8787)
`);
  process.exit(0);
}

if (!hasWg()) {
  console.error("WireGuard wg command not found.");
  console.error("Install it first, for example: sudo apt update && sudo apt install -y wireguard ufw");
  process.exit(1);
}

const server = generateKeyPair();
const phone = generateKeyPair();
const serverConfig = buildServerConfig(settings, server.privateKey, phone.publicKey);
const phoneConfig = buildPhoneConfig(settings, phone.privateKey, server.publicKey);

console.log("# WireGuard server config: /etc/wireguard/wg0.conf");
console.log(serverConfig.trimEnd());
console.log("\n# iPhone peer config: import this in the WireGuard app");
console.log(phoneConfig.trimEnd());
console.log("\n# Receiver commands to review and run manually");
console.log(buildSetupCommands(settings, serverConfig));
console.log(`\n# Knoxnet VPN pairing receiver URL: wss://${settings.receiverVpnIp}:${settings.receiverPort}/ws`);

function hasWg() {
  return spawnSync("wg", ["--version"], { encoding: "utf8" }).status === 0;
}

function generateKeyPair() {
  const privateKey = run("wg", ["genkey"]).stdout.trim();
  const publicKey = run("wg", ["pubkey"], privateKey + "\n").stdout.trim();
  return { privateKey, publicKey };
}

function buildServerConfig(input, serverPrivateKey, phonePublicKey) {
  return [
    "[Interface]",
    `Address = ${input.receiverVpnIp}/${subnetPrefix(input.vpnSubnet)}`,
    `ListenPort = ${input.listenPort}`,
    `PrivateKey = ${serverPrivateKey}`,
    "",
    "[Peer]",
    "# iPhone",
    `PublicKey = ${phonePublicKey}`,
    `AllowedIPs = ${input.phoneVpnIp}/32`,
    "",
  ].join("\n");
}

function buildPhoneConfig(input, phonePrivateKey, serverPublicKey) {
  return [
    "[Interface]",
    `PrivateKey = ${phonePrivateKey}`,
    `Address = ${input.phoneVpnIp}/32`,
    "DNS = 1.1.1.1",
    "",
    "[Peer]",
    `PublicKey = ${serverPublicKey}`,
    `Endpoint = ${endpointWithPort(input.publicEndpoint, input.listenPort)}`,
    `AllowedIPs = ${input.receiverVpnIp}/32`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function buildSetupCommands(input, serverConfig) {
  return [
    "sudo apt update",
    "sudo apt install -y wireguard ufw",
    "sudo install -m 700 -d /etc/wireguard",
    "sudo tee /etc/wireguard/wg0.conf >/dev/null <<'EOF'",
    serverConfig.trimEnd(),
    "EOF",
    "sudo chmod 600 /etc/wireguard/wg0.conf",
    `sudo ufw allow ${input.listenPort}/udp comment 'WireGuard'`,
    `sudo ufw allow in on wg0 to ${input.receiverVpnIp} port ${input.receiverPort} proto tcp comment 'Knoxnet receiver dashboard/WSS'`,
    `sudo ufw allow in on wg0 to ${input.receiverVpnIp} port 8790 proto tcp comment 'Knoxnet bridge API'`,
    `sudo ufw allow in on wg0 to ${input.receiverVpnIp} port 8554 proto tcp comment 'MediaMTX RTSP over VPN'`,
    "sudo systemctl enable --now wg-quick@wg0",
    "sudo wg show",
  ].join("\n");
}

function endpointWithPort(endpoint, port) {
  const trimmed = endpoint.trim();
  if (/:\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}:${port}`;
}

function subnetPrefix(cidr) {
  const match = cidr.match(/\/(\d{1,2})$/);
  if (!match) return 24;
  const prefix = Number(match[1]);
  return Number.isInteger(prefix) && prefix >= 1 && prefix <= 32 ? prefix : 24;
}

function run(command, commandArgs, stdin) {
  const result = spawnSync(command, commandArgs, {
    input: stdin,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}
