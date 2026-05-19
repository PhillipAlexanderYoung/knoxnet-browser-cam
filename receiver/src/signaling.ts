import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  listCameras,
  registerCamera,
  setCameraStatus,
  touchCamera,
  validatePairingCode,
  type CameraCapabilities,
  type CameraRecord,
  type PairingState,
} from "./pairing.js";

// Message envelopes traveling over the signaling WebSocket.
// Kept loose on intent (role-specific shape) but typed at the union level.
export type SignalingMessage =
  | {
      type: "hello";
      role: "camera";
      name?: string;
      pairingCode: string;
      capabilities?: CameraCapabilities;
    }
  | {
      type: "hello";
      role: "viewer";
      pairingCode: string;
      sessionId?: string;
    }
  | { type: "hello-ack"; paired: boolean; sessionId?: string; reason?: string }
  | { type: "accepted"; sessionId: string }
  | { type: "rejected"; sessionId: string; reason?: string }
  | { type: "offer"; sessionId: string; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sessionId: string; sdp: RTCSessionDescriptionInit }
  | {
      type: "ice";
      sessionId: string;
      candidate: RTCIceCandidateInit | null;
    }
  | { type: "bye"; sessionId: string }
  | { type: "camera-list"; cameras: CameraRecord[] }
  | { type: "camera-update"; camera: CameraRecord }
  | { type: "announce"; name?: string; pairingCode: string; discoverable: boolean }
  | { type: "error"; message: string }
  | { type: "ping" }
  | { type: "pong" };

// Minimal RTC type stubs so this file compiles in pure Node without DOM lib.
// The receiver itself never creates an RTCPeerConnection; we just relay SDP/ICE blobs.
interface RTCSessionDescriptionInit {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}
interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

type ClientRole = "camera" | "viewer";

interface ClientContext {
  role?: ClientRole;
  sessionId?: string;
  pairingValidated: boolean;
  alive: boolean;
  missedPongs: number;
  remoteAddress: string;
}

interface ServerDeps {
  state: PairingState;
  log: (...args: unknown[]) => void;
  autoAccept?: boolean;
}

export interface SignalingHandle {
  broadcastCameraList: () => void;
  broadcastCameraUpdate: (cam: CameraRecord) => void;
  sendToCamera: (sessionId: string, msg: SignalingMessage) => boolean;
  closeCameraSocket: (sessionId: string, code?: number, reason?: string) => void;
}

export function attachSignaling(
  wss: WebSocketServer,
  deps: ServerDeps,
): SignalingHandle {
  const { state, log, autoAccept } = deps;
  const clients = new WeakMap<WebSocket, ClientContext>();
  // Keep an indexable list so we can match camera <-> viewer pairs by sessionId.
  const cameraSockets = new Map<string, WebSocket>();
  const viewerSockets = new Map<string, Set<WebSocket>>();
  const allViewerLobbySockets = new Set<WebSocket>();

  function send(ws: WebSocket, msg: SignalingMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      log("send error", err);
    }
  }

  function broadcastCameraList(): void {
    const list = listCameras(state);
    const msg: SignalingMessage = { type: "camera-list", cameras: list };
    for (const ws of allViewerLobbySockets) send(ws, msg);
    for (const set of viewerSockets.values()) {
      for (const ws of set) send(ws, msg);
    }
  }

  function broadcastCameraUpdate(cam: CameraRecord): void {
    const msg: SignalingMessage = { type: "camera-update", camera: cam };
    for (const ws of allViewerLobbySockets) send(ws, msg);
    const viewerSet = viewerSockets.get(cam.sessionId);
    if (viewerSet) {
      for (const ws of viewerSet) send(ws, msg);
    }
  }

  function detach(ws: WebSocket): void {
    const ctx = clients.get(ws);
    if (!ctx) return;
    if (ctx.role === "camera" && ctx.sessionId) {
      cameraSockets.delete(ctx.sessionId);
      const cam = setCameraStatus(state, ctx.sessionId, "disconnected");
      if (cam) broadcastCameraUpdate(cam);
      log(`camera disconnected sessionId=${ctx.sessionId}`);
    } else if (ctx.role === "viewer") {
      if (ctx.sessionId) {
        const set = viewerSockets.get(ctx.sessionId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) viewerSockets.delete(ctx.sessionId);
        }
      }
      allViewerLobbySockets.delete(ws);
    }
    clients.delete(ws);
  }

  function forwardToCamera(sessionId: string, msg: SignalingMessage): void {
    const target = cameraSockets.get(sessionId);
    if (!target) return;
    send(target, msg);
  }

  function forwardToViewers(sessionId: string, msg: SignalingMessage): void {
    const set = viewerSockets.get(sessionId);
    if (!set) return;
    for (const ws of set) send(ws, msg);
  }

  function handleHelloCamera(
    ws: WebSocket,
    ctx: ClientContext,
    msg: Extract<SignalingMessage, { type: "hello"; role: "camera" }>,
  ): void {
    if (!validatePairingCode(state, msg.pairingCode)) {
      send(ws, { type: "hello-ack", paired: false, reason: "bad-pairing-code" });
      try {
        ws.close(4001, "bad-pairing-code");
      } catch {
        // ignore
      }
      log(`camera hello rejected (bad code) from ${ctx.remoteAddress}`);
      return;
    }
    const cam = registerCamera(state, {
      name: msg.name ?? "",
      capabilities: msg.capabilities ?? {},
      remoteAddress: ctx.remoteAddress,
    });
    ctx.role = "camera";
    ctx.sessionId = cam.sessionId;
    ctx.pairingValidated = true;
    cameraSockets.set(cam.sessionId, ws);
    send(ws, { type: "hello-ack", paired: true, sessionId: cam.sessionId });
    broadcastCameraList();
    log(
      `camera hello accepted sessionId=${cam.sessionId} name="${cam.name}" remote=${ctx.remoteAddress}`,
    );

    if (autoAccept) {
      const updated = setCameraStatus(state, cam.sessionId, "accepted");
      if (updated) {
        send(ws, { type: "accepted", sessionId: cam.sessionId });
        broadcastCameraUpdate(updated);
      }
    }
  }

  function handleHelloViewer(
    ws: WebSocket,
    ctx: ClientContext,
    msg: Extract<SignalingMessage, { type: "hello"; role: "viewer" }>,
  ): void {
    if (!validatePairingCode(state, msg.pairingCode)) {
      send(ws, { type: "hello-ack", paired: false, reason: "bad-pairing-code" });
      try {
        ws.close(4001, "bad-pairing-code");
      } catch {
        // ignore
      }
      return;
    }
    ctx.role = "viewer";
    ctx.pairingValidated = true;
    if (msg.sessionId) {
      ctx.sessionId = msg.sessionId;
      let set = viewerSockets.get(msg.sessionId);
      if (!set) {
        set = new Set();
        viewerSockets.set(msg.sessionId, set);
      }
      set.add(ws);
    } else {
      allViewerLobbySockets.add(ws);
    }
    send(ws, { type: "hello-ack", paired: true, sessionId: msg.sessionId });
    send(ws, { type: "camera-list", cameras: listCameras(state) });
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const remoteAddress =
      (req.socket.remoteAddress ?? "unknown") +
      (req.socket.remotePort ? `:${req.socket.remotePort}` : "");
    const ctx: ClientContext = {
      pairingValidated: false,
      alive: true,
      missedPongs: 0,
      remoteAddress,
    };
    clients.set(ws, ctx);

    ws.on("pong", () => {
      ctx.alive = true;
      ctx.missedPongs = 0;
    });

    ws.on("message", (raw) => {
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(raw.toString()) as SignalingMessage;
      } catch {
        send(ws, { type: "error", message: "invalid-json" });
        return;
      }

      switch (msg.type) {
        case "hello": {
          if (msg.role === "camera") {
            handleHelloCamera(ws, ctx, msg);
          } else if (msg.role === "viewer") {
            handleHelloViewer(ws, ctx, msg);
          } else {
            send(ws, { type: "error", message: "unknown-role" });
          }
          return;
        }
        case "announce": {
          if (!validatePairingCode(state, msg.pairingCode)) return;
          // Announce just keeps the receiver aware a camera exists in the wild,
          // without yet establishing a media session. Currently a no-op beyond log.
          log(`announce name="${msg.name ?? "(anon)"}" discoverable=${msg.discoverable}`);
          return;
        }
        case "offer":
        case "answer":
        case "ice":
        case "bye": {
          if (!ctx.pairingValidated || !ctx.role) {
            send(ws, { type: "error", message: "not-paired" });
            return;
          }
          const targetSession = msg.sessionId;
          if (!targetSession) return;
          touchCamera(state, targetSession);

          // Cameras only forward to their bound session and only when accepted.
          if (ctx.role === "camera") {
            const cam = state.cameras.get(targetSession);
            if (!cam || cam.status === "pending" || cam.status === "disconnected") {
              return;
            }
            if (msg.type === "offer") {
              const updated = setCameraStatus(state, targetSession, "streaming");
              if (updated) broadcastCameraUpdate(updated);
            }
            forwardToViewers(targetSession, msg);
            return;
          }

          // Viewers always forward to the camera socket.
          if (ctx.role === "viewer") {
            forwardToCamera(targetSession, msg);
            return;
          }
          return;
        }
        case "ping": {
          send(ws, { type: "pong" });
          return;
        }
        default:
          // We don't expect inbound camera-list/camera-update/hello-ack/etc.
          return;
      }
    });

    ws.on("close", () => {
      detach(ws);
      broadcastCameraList();
    });

    ws.on("error", (err) => {
      log("ws error", err);
    });
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const ctx = clients.get(ws);
      if (!ctx) continue;
      if (!ctx.alive) {
        ctx.missedPongs += 1;
        if (ctx.missedPongs >= 2) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }
      }
      ctx.alive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, 15_000);
  wss.on("close", () => clearInterval(heartbeat));

  function sendToCamera(sessionId: string, msg: SignalingMessage): boolean {
    const target = cameraSockets.get(sessionId);
    if (!target) return false;
    send(target, msg);
    return true;
  }

  function closeCameraSocket(
    sessionId: string,
    code = 1000,
    reason = "removed",
  ): void {
    const target = cameraSockets.get(sessionId);
    if (!target) return;
    try {
      target.close(code, reason);
    } catch {
      // ignore
    }
    cameraSockets.delete(sessionId);
  }

  return {
    broadcastCameraList,
    broadcastCameraUpdate,
    sendToCamera,
    closeCameraSocket,
  };
}
