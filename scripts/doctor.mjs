import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const candidates = [
  process.env.MEDIAMTX_BINARY,
  path.resolve(repoRoot, "..", "Knoxnet-VMS", "mediamtx", "mediamtx"),
  path.resolve(repoRoot, "..", "..", "Knoxnet-VMS", "mediamtx", "mediamtx"),
  "/home/operator1/Documents/Knoxnet-VMS/mediamtx/mediamtx",
].filter(Boolean);

function executable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const found = candidates.find((candidate) => existsSync(candidate) && executable(candidate));

console.log("Knoxnet browser-cam doctor");
console.log(`repo: ${repoRoot}`);
if (found) {
  console.log(`mediamtx: ${found}`);
  console.log(`start: MEDIAMTX_BINARY="${found}" npm run dev:all`);
} else {
  console.log("mediamtx: not found in the expected Knoxnet-VMS path or MEDIAMTX_BINARY");
  console.log("install: download MediaMTX, then set MEDIAMTX_BINARY=/path/to/mediamtx");
}
console.log("bridge health: curl http://localhost:8790/api/health");
console.log("rtsp default: rtsp://<lan-ip>:8554/<camera-path> after bridge ingest is publishing");
