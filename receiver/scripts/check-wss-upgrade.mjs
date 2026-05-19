import { spawn, spawnSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const receiverRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(receiverRoot, "..");
const port = Number(
  process.env.WSS_SMOKE_PORT ?? 18000 + Math.floor(Math.random() * 1000),
);
const pairingCode = "SMOKE1";
const infoUrl = `https://localhost:${port}/api/info`;
const wsUrl = `wss://localhost:${port}/ws`;
const shutdownUrl = `https://localhost:${port}/__test/shutdown`;

function ensureDevCert() {
  const result = spawnSync(process.execPath, ["scripts/ensure-dev-cert.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("dev certificate setup failed");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchInfo() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      infoUrl,
      { rejectUnauthorized: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET /api/info returned ${res.statusCode}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("GET /api/info timed out"));
    });
  });
}

async function waitForReceiver() {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchInfo();
    } catch (err) {
      lastError = err;
      await wait(250);
    }
  }
  throw lastError ?? new Error("receiver did not start");
}

function connectAndHello() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("WSS hello timed out"));
    }, 5000);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          role: "camera",
          name: "wss-smoke",
          pairingCode,
          capabilities: {},
        }),
      );
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "hello-ack" || msg.paired !== true || !msg.sessionId) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`unexpected hello response: ${raw.toString()}`));
        return;
      }
      clearTimeout(timeout);
      ws.close();
      resolve(msg);
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function requestReceiverShutdown() {
  return new Promise((resolve) => {
    if (receiver.exitCode != null || receiver.signalCode != null) {
      resolve();
      return;
    }

    const done = () => resolve();
    const timeout = setTimeout(done, 3000);
    receiver.once("exit", () => {
      clearTimeout(timeout);
      done();
    });

    const req = https.request(
      shutdownUrl,
      { method: "POST", rejectUnauthorized: false },
      (res) => {
        res.resume();
      },
    );
    req.on("error", () => {
      clearTimeout(timeout);
      done();
    });
    req.end();
  });
}

ensureDevCert();

const receiver = spawn("tsx", ["src/server.ts"], {
  cwd: receiverRoot,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PUBLIC_HOST: "localhost",
    PORT: String(port),
    WSS: "true",
    PHONE_APP_SCHEME: "https",
    PHONE_APP_PORT: "5173",
    PAIRING_CODE: pairingCode,
    AUTO_ACCEPT: "false",
    RECEIVER_TEST_SHUTDOWN: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stoppingReceiver = false;
receiver.stdout.on("data", (chunk) => process.stdout.write(chunk));
receiver.stderr.on("data", (chunk) => process.stderr.write(chunk));
receiver.on("error", (err) => {
  if (stoppingReceiver) {
    console.warn(`[check-wss-upgrade] receiver shutdown warning: ${err.message}`);
    return;
  }
  console.error(`[check-wss-upgrade] receiver process error: ${err.message}`);
  process.exitCode = 1;
});

try {
  const info = await waitForReceiver();
  if (info.receiverWsUrl !== wsUrl) {
    throw new Error(`expected receiverWsUrl ${wsUrl}, got ${info.receiverWsUrl}`);
  }
  await connectAndHello();
  console.log(`[check-wss-upgrade] WSS upgrade and hello OK at ${wsUrl}`);
} finally {
  stoppingReceiver = true;
  await requestReceiverShutdown();
  try {
    if (receiver.exitCode == null && receiver.signalCode == null) {
      receiver.kill("SIGTERM");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[check-wss-upgrade] receiver shutdown warning: ${message}`,
    );
  }
  receiver.stdout.destroy();
  receiver.stderr.destroy();
  receiver.unref();
}
