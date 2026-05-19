import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, "..", "src", "public");
const dest = resolve(__dirname, "..", "dist", "public");

if (!existsSync(src)) {
  console.error(`[copy-public] source missing: ${src}`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-public] copied ${src} -> ${dest}`);
