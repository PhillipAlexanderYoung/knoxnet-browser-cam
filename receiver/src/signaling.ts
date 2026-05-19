import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  listCameras,
  registerCamera,
  removeCamera,
  setCameraStatus,
  touchCamera,
  validatePairingCode,
  type CameraCapabilities,
  type CameraRecord,
  type PairingState,
} from "./pairing.js";
import type { BridgeAllocation, BridgeClient } from "./bridge-client.js";
import type { EventLog, ReceiverEvent } from "./events.js";
import type { KnownDeviceStore } from "./known-devices.js";

// Message envelopes traveling over the signaling WebSocket.
// Kept loose on intent (role-specific shape) but typed at the union level.
export type SignalingMessage =
  | {
      type: "hello";
      role: "camera";
      name?: string;
      deviceId?: string;
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
  | { type: "accepted"; sessionId: string; bridge?: BridgeAllocation }
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
  | { type: "event-log"; events: ReceiverEvent[] }
  | { type: "event"; event: ReceiverEvent }
  | {
      type: "announce";
      name?: string;
      deviceId?: string;
      pairingCode: string;
      discoverable: boolean;
    }
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
  autoAcceptAll?: boolean;
  autoAcceptKnown?: boolean;
  bridgeClient?: BridgeClient | null;
  knownDevices: KnownDeviceStore;
  eventLog: EventLog;
  emitEvent: (event: Omit<ReceiverEvent, "id" | "ts">) => ReceiverEvent;
}

export interface SignalingHandle {
  broadcastCameraList: () => void;
  broadcastCameraUpdate: (cam: CameraRecord) => void;
  sendToCamera: (sessionId: string, msg: SignalingMessage) => boolean;
  closeCameraSocket: (sessionId: string, code?: number, reason?: string) => void;
  broadcastEvent: (event: ReceiverEvent) => void;
}

export function attachSignaling(
  wss: WebSocketServer,
  deps: ServerDeps,
): SignalingHandle {
  const {
    state,
    log,
    autoAcceptAll,
    autoAcceptKnown,
    bridgeClient,
    knownDevices,
    eventLog,
    emitEvent,
  } = deps;
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

  function broadcastEvent(event: ReceiverEvent): void {
    const msg: SignalingMessage = { type: "event", event };
    for (const ws of allViewerLobbySockets) send(ws, msg);
    for (const set of viewerSockets.values()) {
      for (const ws of set) send(ws, msg);
    }
  }

  function applyBridgeUpdate(cam: CameraRecord, bridge?: BridgeAllocation): void {
    if (bridge) cam.bridge = bridge;
  }

  function detach(ws: WebSocket): void {
    const ctx = clients.get(ws);
    if (!ctx) return;
    if (ctx.role === "camera" && ctx.sessionId) {
      cameraSockets.delete(ctx.sessionId);
      const cam = setCameraStatus(state, ctx.sessionId, "disconnected", "socket-closed");
      if (cam) broadcastCameraUpdate(cam);
      emitEvent({
        type: "disconnected",
        sessionId: ctx.sessionId,
        deviceId: cam?.deviceId,
        name: cam?.name,
        message: "Camera disconnected",
        reason: "socket-closed",
      });
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

  async function removeSupersededDeviceSessions(
    deviceId: string | undefined,
    nextSocket: WebSocket,
  ): Promise<string | undefined> {
    if (!deviceId) return undefined;
    const matches = Array.from(state.cameras.values()).filter(
      (cam) => cam.deviceId === deviceId,
    );
    const primary = matches[0];
    for (const cam of matches) {
      const previousSocket = cameraSockets.get(cam.sessionId);
      if (previousSocket && previousSocket !== nextSocket) {
        try {
          previousSocket.close(1000, "replaced-by-reconnect");
        } catch {
          // ignore
        }
        cameraSockets.delete(cam.sessionId);
      }
      const viewers = viewerSockets.get(cam.sessionId);
      if (viewers) {
        for (const viewer of viewers) {
          send(viewer, { type: "bye", sessionId: cam.sessionId });
          try {
            viewer.close(1000, "camera-reconnected");
          } catch {
            // ignore
          }
        }
        viewerSockets.delete(cam.sessionId);
      }
      if (cam.sessionId !== primary?.sessionId) {
        removeCamera(state, cam.sessionId);
      }
      if (bridgeClient) await bridgeClient.removeCamera(cam.sessionId);
      emitEvent({
        type: "reconnect",
        sessionId: cam.sessionId,
        deviceId,
        name: cam.name,
        message: "Previous camera session replaced by reconnect",
        reason: "replaced-by-reconnect",
      });
    }
    return primary?.sessionId;
  }

  async function handleHelloCamera(
    ws: WebSocket,
    ctx: ClientContext,
    msg: Extract<SignalingMessage, { type: "hello"; role: "camera" }>,
  ): Promise<void> {
    if (!validatePairingCode(state, msg.pairingCode)) {
      send(ws, { type: "hello-ack", paired: false, reason: "bad-pairing-code" });
      try {
        ws.close(4001, "bad-pairing-code");
      } catch {
        // ignore
      }
      log(`camera hello rejected (bad code) from ${ctx.remoteAddress}`);
      emitEvent({
        type: "rejected",
        deviceId: msg.deviceId,
        name: msg.name,
        message: "Camera hello rejected",
        reason: "bad-pairing-code",
      });
      return;
    }
    const knownBefore = knownDevices.get(msg.deviceId);
    const replaceSessionId = await removeSupersededDeviceSessions(msg.deviceId, ws);
    const cam = registerCamera(state, {
      name: msg.name ?? "",
      deviceId: msg.deviceId,
      capabilities: msg.capabilities ?? {},
      remoteAddress: ctx.remoteAddress,
      replaceSessionId,
    });
    const known = msg.deviceId
      ? knownDevices.upsertSeen({
          deviceId: msg.deviceId,
          name: cam.name,
          sessionId: cam.sessionId,
        })
      : undefined;
    cam.trusted = known?.trusted;
    const previousSessionId = replaceSessionId ?? knownBefore?.lastSessionId;
    if (previousSessionId && previousSessionId !== cam.sessionId) {
      emitEvent({
        type: "reconnect",
        sessionId: cam.sessionId,
        deviceId: msg.deviceId,
        name: cam.name,
        message: `Known device reconnected (${cam.reconnectCount ?? 1} total)`,
        reason: "replaced-by-reconnect",
      });
    }
    ctx.role = "camera";
    ctx.sessionId = cam.sessionId;
    ctx.pairingValidated = true;
    cameraSockets.set(cam.sessionId, ws);
    send(ws, { type: "hello-ack", paired: true, sessionId: cam.sessionId });
    broadcastCameraList();
    emitEvent({
      type: "paired",
      sessionId: cam.sessionId,
      deviceId: cam.deviceId,
      name: cam.name,
      message: known ? "Known device paired" : "Camera paired",
    });
    log(
      `camera hello accepted sessionId=${cam.sessionId} name="${cam.name}" remote=${ctx.remoteAddress}`,
    );

    const shouldAutoAccept =
      autoAcceptAll || (autoAcceptKnown && Boolean(known?.autoAccept || known?.trusted));
    if (shouldAutoAccept) {
      const updated = setCameraStatus(state, cam.sessionId, "accepted");
      if (updated) {
        updated.autoAccepted = true;
        if (bridgeClient) {
          const allocation = await bridgeClient.allocateCamera(updated);
          if (allocation) {
            updated.bridge = allocation;
            emitEvent({
              type: "bridge-allocated",
              sessionId: cam.sessionId,
              deviceId: cam.deviceId,
              name: cam.name,
              message: `Bridge path allocated: ${allocation.path}`,
            });
          }
        }
        send(ws, { type: "accepted", sessionId: cam.sessionId, bridge: updated.bridge });
        broadcastCameraUpdate(updated);
        emitEvent({
          type: "accepted",
          sessionId: cam.sessionId,
          deviceId: cam.deviceId,
          name: cam.name,
          message: autoAcceptAll
            ? "Camera auto-accepted by AUTO_ACCEPT_ALL"
            : "Trusted known device auto-accepted",
        });
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
    send(ws, { type: "event-log", events: eventLog.list() });
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
            void handleHelloCamera(ws, ctx, msg);
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
          log(
            `announce name="${msg.name ?? "(anon)"}" deviceId="${msg.deviceId ?? ""}" discoverable=${msg.discoverable}`,
          );
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
            if (bridgeClient && cam.bridge) {
              if (msg.type === "offer" && msg.sdp?.sdp) {
                log(
                  `offer received sessionId=${targetSession}; requesting bridge WHIP path=${cam.bridge.path}`,
                );
                const negotiating = setCameraStatus(state, targetSession, "negotiating");
                if (negotiating) broadcastCameraUpdate(negotiating);
                void bridgeClient.publishOffer(cam, msg.sdp.sdp).then((result) => {
                  applyBridgeUpdate(cam, result.camera);
                  if (!result.answer) {
                    const error =
                      result.error ?? "bridge WHIP ingest failed; RTSP stream not available";
                    const updated = setCameraStatus(state, targetSession, "accepted");
                    if (updated) {
                      applyBridgeUpdate(updated, result.camera);
                      if (updated.bridge) {
                        updated.bridge.ingestStatus = "error";
                        updated.bridge.lastError = error;
                      }
                      broadcastCameraUpdate(updated);
                    }
                    log(`bridge WHIP failed sessionId=${targetSession}: ${error}`);
                    emitEvent({
                      type: "bridge-failed",
                      sessionId: targetSession,
                      deviceId: cam.deviceId,
                      name: cam.name,
                      message: "Bridge WHIP ingest failed",
                      reason: error,
                    });
                    send(ws, {
                      type: "error",
                      message: error,
                    });
                    return;
                  }
                  log(`bridge WHIP answer returned sessionId=${targetSession}`);
                  send(ws, {
                    type: "answer",
                    sessionId: targetSession,
                    sdp: result.answer,
                  });
                  const updated = setCameraStatus(state, targetSession, "streaming");
                  if (updated) {
                    applyBridgeUpdate(updated, result.camera);
                    broadcastCameraUpdate(updated);
                  }
                  log(`stream connected sessionId=${targetSession} rtsp=${cam.bridge?.rtspUrl}`);
                  emitEvent({
                    type: "connected",
                    sessionId: targetSession,
                    deviceId: cam.deviceId,
                    name: cam.name,
                    message: "Camera stream connected",
                  });
                }).catch((err) => {
                  const error = (err as Error)?.message ?? String(err);
                  const updated = setCameraStatus(state, targetSession, "accepted");
                  if (updated?.bridge) {
                    updated.bridge.ingestStatus = "error";
                    updated.bridge.lastError = error;
                  }
                  if (updated) broadcastCameraUpdate(updated);
                  log(`bridge WHIP error sessionId=${targetSession}: ${error}`);
                  emitEvent({
                    type: "bridge-failed",
                    sessionId: targetSession,
                    deviceId: cam.deviceId,
                    name: cam.name,
                    message: "Bridge WHIP ingest errored",
                    reason: error,
                  });
                  send(ws, {
                    type: "error",
                    message: `bridge WHIP ingest failed: ${error}`,
                  });
                });
              }
              if (msg.type === "ice") {
                // TODO(knoxnet-vms): add WHIP PATCH trickle support if the
                // browser offer cannot include enough gathered ICE candidates.
              }
              return;
            }
            if (msg.type === "offer") {
              log(`offer received sessionId=${targetSession}; forwarding to dashboard viewers`);
              const updated = setCameraStatus(state, targetSession, "negotiating");
              if (updated) broadcastCameraUpdate(updated);
            }
            if (msg.type === "bye") {
              const updated = setCameraStatus(state, targetSession, "accepted");
              if (updated) broadcastCameraUpdate(updated);
              log(`stream disconnected sessionId=${targetSession}`);
              emitEvent({
                type: "disconnected",
                sessionId: targetSession,
                deviceId: updated?.deviceId,
                name: updated?.name,
                message: "Camera stream disconnected",
                reason: "bye",
              });
            }
            forwardToViewers(targetSession, msg);
            return;
          }

          // Viewers always forward to the camera socket.
          if (ctx.role === "viewer") {
            if (msg.type === "answer") {
              const updated = setCameraStatus(state, targetSession, "streaming");
              if (updated) broadcastCameraUpdate(updated);
              log(`dashboard answer forwarded sessionId=${targetSession}`);
              emitEvent({
                type: "connected",
                sessionId: targetSession,
                deviceId: updated?.deviceId,
                name: updated?.name,
                message: "Dashboard viewer connected",
              });
            }
            if (msg.type === "ice") {
              log(`dashboard ICE forwarded sessionId=${targetSession}`);
            }
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
    broadcastEvent,
  };
}
