import { RoomDurableObject } from "./RoomDurableObject";
import { checkRateLimit, requestIp } from "./rateLimit";
import {
  createRoomToken,
  enforceProductionHttps,
  getRoomJoinTtlMs,
  isProduction,
  isValidRoomToken,
  jsonResponse,
  originAllowed,
} from "./security";
import type { Env, RoomCreateResponse } from "./types";

export { RoomDurableObject };

const CREATE_LIMIT_PER_MINUTE = 20;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/direct/")) {
      return new Response("Not found", { status: 404 });
    }
    if (!originAllowed(request, env)) {
      return jsonResponse({ error: "Origin not allowed" }, { status: 403 });
    }
    if (!enforceProductionHttps(request, env)) {
      return jsonResponse({ error: "HTTPS required" }, { status: 400 });
    }

    if (url.pathname === "/api/direct/rooms" && request.method === "POST") {
      return createRoom(request, env);
    }

    const wsMatch = url.pathname.match(/^\/api\/direct\/ws\/([^/]+)$/);
    if (wsMatch && request.method === "GET") {
      return routeWebSocket(request, env, wsMatch[1]);
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  },
};

async function createRoom(request: Request, env: Env): Promise<Response> {
  const ip = requestIp(request);
  if (!checkRateLimit(`create:${ip}`, CREATE_LIMIT_PER_MINUTE, 60_000)) {
    return jsonResponse({ error: "Too many room requests" }, { status: 429 });
  }

  const roomToken = createRoomToken();
  const expiresAtMs = Date.now() + getRoomJoinTtlMs(env);
  const id = env.ROOMS.idFromName(roomToken);
  const stub = env.ROOMS.get(id);
  const createResponse = await stub.fetch("https://room.local/create", {
    method: "POST",
    body: JSON.stringify({ expiresAt: expiresAtMs }),
    headers: { "Content-Type": "application/json" },
  });
  if (!createResponse.ok) {
    return jsonResponse({ error: "Could not create room" }, { status: 500 });
  }

  const appOrigin = normalizedAppOrigin(request, env);
  const apiOrigin = new URL(request.url).origin;
  const wsScheme = apiOrigin.startsWith("https://") ? "wss" : "ws";
  const apiHost = new URL(apiOrigin).host;
  const payload: RoomCreateResponse = {
    roomToken,
    joinUrl: `${appOrigin}/join/${roomToken}`,
    wsUrl: `${wsScheme}://${apiHost}/api/direct/ws/${roomToken}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return jsonResponse(payload, { status: 201 });
}

function routeWebSocket(request: Request, env: Env, roomToken: string): Promise<Response> {
  if (!isValidRoomToken(roomToken)) {
    return Promise.resolve(jsonResponse({ error: "Invalid room token" }, { status: 404 }));
  }
  if (isProduction(env) && new URL(request.url).protocol !== "https:") {
    return Promise.resolve(jsonResponse({ error: "WSS required" }, { status: 400 }));
  }
  const id = env.ROOMS.idFromName(roomToken);
  const stub = env.ROOMS.get(id);
  const roomUrl = new URL(request.url);
  roomUrl.protocol = "https:";
  roomUrl.hostname = "room.local";
  roomUrl.pathname = "/ws";
  return stub.fetch(new Request(roomUrl.toString(), request));
}

function normalizedAppOrigin(request: Request, env: Env): string {
  const configured = env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}
