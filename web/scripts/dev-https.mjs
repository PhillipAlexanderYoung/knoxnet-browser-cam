import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "..");
const certDir = path.join(repoRoot, ".cert");
const keyPath = path.join(certDir, "knoxnet-dev.key");
const certPath = path.join(certDir, "knoxnet-dev.crt");

function localIPv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function ensureCertificate() {
  mkdirSync(certDir, { recursive: true });
  if (existsSync(keyPath) && existsSync(certPath)) return;

  const san = [
    "DNS:localhost",
    "IP:127.0.0.1",
    ...localIPv4Addresses().map((address) => `IP:${address}`),
  ].join(",");

  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "30",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { stdio: "inherit" },
  );

  if (result.status !== 0) {
    throw new Error(
      "Could not create a local HTTPS certificate. Install openssl or front Vite with a local TLS reverse proxy.",
    );
  }
}

ensureCertificate();

const server = await createServer({
  root: webRoot,
  configFile: path.join(webRoot, "vite.config.ts"),
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
  },
});

await server.listen();
server.printUrls();
console.log(`HTTPS dev certificate: ${certPath}`);
console.log("Open https://<LAN-IP>:5173 on the phone and accept the local certificate warning.");

async function shutdown() {
  await server.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
