import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certDir = path.join(repoRoot, ".cert");
const keyPath = path.join(certDir, "knoxnet-dev.key");
const certPath = path.join(certDir, "knoxnet-dev.crt");

function localIPv4Addresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

mkdirSync(certDir, { recursive: true });

if (!existsSync(keyPath) || !existsSync(certPath)) {
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
      "Could not create a local HTTPS certificate. Install openssl or set TLS_KEY_PATH/TLS_CERT_PATH.",
    );
  }
}

console.log(`Dev certificate ready: ${certPath}`);
