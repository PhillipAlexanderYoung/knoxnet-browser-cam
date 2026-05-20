import { timingSafeEqual, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

export interface VmsAuthState {
  token: string;
  source: "env" | "file";
  tokenFile?: string;
  generated: boolean;
}

export function loadVmsAuth(dataDir: string): VmsAuthState {
  const envToken = process.env.VMS_INTEGRATION_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env", generated: false };
  }

  const tokenFile =
    process.env.VMS_INTEGRATION_TOKEN_FILE ?? path.join(dataDir, "vms-integration-token");
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, "utf8").trim();
    if (existing) {
      try {
        chmodSync(tokenFile, 0o600);
      } catch {
        // Best effort only on non-POSIX filesystems.
      }
      return { token: existing, source: "file", tokenFile, generated: false };
    }
  }

  mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    // Best effort only; file creation mode is the primary protection.
  }
  return { token, source: "file", tokenFile, generated: true };
}

export function createVmsAuthMiddleware(auth: VmsAuthState) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = bearerToken(req) || headerToken(req);
    if (!provided || !constantTimeEquals(provided, auth.token)) {
      res.status(401).json({
        ok: false,
        error: "unauthorized",
        message: "Use Authorization: Bearer <VMS_INTEGRATION_TOKEN> for /api/vms/v1.",
      });
      return;
    }
    next();
  };
}

function bearerToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function headerToken(req: Request): string {
  return req.header("x-knoxnet-vms-token")?.trim() ?? "";
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
