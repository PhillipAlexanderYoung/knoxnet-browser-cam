import { DurableObject } from "cloudflare:workers";
import {
  createReconnectToken,
  getActiveRoomIdleTtlMs,
  getHeartbeatIntervalSeconds,
  getMaxFailedJoins,
  getMaxMessageBytes,
  getPeerGraceMs,
  parseClientMessage,
  parseRole,
  validClientId,
  validReconnectToken,
} from "./security";
import type {
  ClientMessage,
  Env,
  PeerInfo,
  PeerRole,
  RoomCreateRequest,
  RoomState,
  ServerMessage,
} from "./types";

interface StoredRoom {
  setupExpiresAt: number;
  state: RoomState;
  failedJoins: number;
  approved: boolean;
  cameraSession?: StoredPeerSession;
  viewerSession?: StoredPeerSession;
}

interface StoredPeerSession {
  clientId: string;
  reconnectToken: string;
  approved: boolean;
  connected: boolean;
  lastSeen: number;
  disconnectedAt?: number;
  info?: PeerInfo;
}

interface PeerSocket {
  role: PeerRole;
  socket: WebSocket;
  approved: boolean;
  clientId: string;
  reconnectToken: string;
  info?: PeerInfo;
}

const ROOM_KEY = "room";
const CLOSE_POLICY = 1008;

export class RoomDurableObject extends DurableObject<Env> {
  private room: StoredRoom | null = null;
  private camera: PeerSocket | null = null;
  private viewer: PeerSocket | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get<StoredRoom>(ROOM_KEY)) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/create") && request.method === "POST") {
      return this.createRoom(request);
    }
    if (url.pathname.endsWith("/ws") && request.method === "GET") {
      return this.acceptWebSocket(request);
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.handleAlarm();
  }

  private async createRoom(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as RoomCreateRequest | null;
    if (!body || typeof body.expiresAt !== "number") {
      return new Response("Bad request", { status: 400 });
    }
    const expiresAt = body.expiresAt;
    this.room = {
      setupExpiresAt: expiresAt,
      state: "created",
      failedJoins: 0,
      approved: false,
    };
    await this.ctx.storage.put(ROOM_KEY, this.room);
    await this.ctx.storage.setAlarm(expiresAt);
    return Response.json({ ok: true });
  }

  private async acceptWebSocket(request: Request): Promise<Response> {
    if (!this.room) {
      await this.recordFailedJoin();
      return new Response("Room not found", { status: 404 });
    }
    if (this.isJoinExpired()) {
      await this.expire("expired");
      return new Response("Room expired", { status: 410 });
    }
    if (this.room.failedJoins >= getMaxFailedJoins(this.env)) {
      return new Response("Too many failed joins", { status: 429 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const role = parseRole(new URL(request.url).searchParams.get("role"));
    if (!role) {
      await this.recordFailedJoin();
      return new Response("Invalid role", { status: 400 });
    }

    const params = new URL(request.url).searchParams;
    const clientId = validClientId(params.get("clientId"));
    if (!clientId) {
      await this.recordFailedJoin();
      return new Response("Invalid client id", { status: 400 });
    }
    const reconnectToken = validReconnectToken(params.get("reconnectToken")) ?? createReconnectToken();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const admission = await this.admitPeer(role, clientId, reconnectToken, server);
    if (!("peer" in admission)) {
      this.sendRaw(server, { type: "error", code: admission.code, message: admission.message });
      server.close(CLOSE_POLICY, admission.code);
      return new Response(null, { status: 101, webSocket: client });
    }

    const peer = admission.peer;
    this.attach(peer);
    this.send(peer, {
      type: "room-ready",
      state: this.room!.state,
      expiresAt: new Date(this.room!.setupExpiresAt).toISOString(),
      heartbeatSeconds: getHeartbeatIntervalSeconds(this.env),
    });
    this.send(peer, {
      type: "session",
      clientId: peer.clientId,
      reconnectToken: peer.reconnectToken,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private async admitPeer(
    role: PeerRole,
    clientId: string,
    reconnectToken: string,
    socket: WebSocket,
  ): Promise<{ peer: PeerSocket } | { code: string; message: string }> {
    const sessionKey = role === "camera" ? "cameraSession" : "viewerSession";
    const currentSocket = role === "camera" ? this.camera : this.viewer;
    const session = this.room?.[sessionKey];
    if (!this.room) return { code: "room_expired", message: "Room is no longer available." };

    if (role === "viewer" && this.room.approved) {
      if (!session || session.clientId !== clientId || session.reconnectToken !== reconnectToken) {
        await this.recordFailedJoin();
        return {
          code: "room_locked",
          message: "This room is already locked to an approved viewer. Ask the camera to share a new link.",
        };
      }
    } else if (session && session.clientId !== clientId) {
      await this.recordFailedJoin();
      return {
        code: role === "viewer" ? "viewer_already_connected" : "room_locked",
        message:
          role === "viewer"
            ? "A viewer is already waiting or connected for this room."
            : "The camera room is already owned by another device.",
      };
    }

    if (currentSocket && currentSocket.clientId !== clientId) {
      await this.recordFailedJoin();
      return {
        code: role === "viewer" ? "viewer_already_connected" : "room_locked",
        message:
          role === "viewer"
            ? "A viewer is already connected to this room."
            : "The camera is already connected to this room.",
      };
    }

    if (currentSocket && currentSocket.clientId === clientId) {
      currentSocket.socket.close(1000, "replaced");
    }

    const now = Date.now();
    const nextSession: StoredPeerSession = {
      clientId,
      reconnectToken: session?.reconnectToken ?? reconnectToken,
      approved: session?.approved ?? false,
      connected: true,
      lastSeen: now,
      info: session?.info,
    };
    this.room[sessionKey] = nextSession;
    const peer: PeerSocket = {
      role,
      socket,
      approved: nextSession.approved,
      clientId,
      reconnectToken: nextSession.reconnectToken,
      info: nextSession.info,
    };
    if (role === "camera") this.camera = peer;
    else this.viewer = peer;
    await this.persistRoom();
    await this.scheduleNextAlarm();
    return { peer };
  }

  private attach(peer: PeerSocket): void {
    peer.socket.addEventListener("message", (event) => {
      void this.handleMessage(peer, event.data);
    });
    peer.socket.addEventListener("close", () => {
      void this.handleClose(peer);
    });
    peer.socket.addEventListener("error", () => {
      void this.handleClose(peer);
    });
  }

  private async handleMessage(peer: PeerSocket, raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      await this.rejectPeer(peer, "Malformed message.");
      return;
    }
    let message: ClientMessage;
    try {
      message = parseClientMessage(raw, getMaxMessageBytes(this.env));
    } catch {
      await this.rejectPeer(peer, "Malformed message.");
      return;
    }
    if (!this.room || this.room.state === "ended" || this.room.state === "expired") {
      this.send(peer, { type: "ended", reason: "Room ended" });
      peer.socket.close(1000, "ended");
      return;
    }
    this.touchPeer(peer);
    if (this.isJoinExpired()) {
      await this.expire("expired");
      return;
    }

    if (message.type === "ping") {
      await this.persistRoom();
      await this.scheduleNextAlarm();
      this.send(peer, { type: "pong" });
      return;
    }
    if (message.type === "bye") {
      await this.end("peer disconnected");
      return;
    }
    if (peer.role === "camera") {
      await this.handleCamera(peer, message);
      return;
    }
    await this.handleViewer(peer, message);
  }

  private async handleCamera(peer: PeerSocket, message: ClientMessage): Promise<void> {
    if (!this.room) return;
    if (message.type === "camera-hello") {
      peer.info = message.device;
      this.updatePeerSession(peer, { info: message.device });
      this.room.state = this.viewer ? "viewer_waiting" : "camera_connected";
      if (this.room.approved && peer.approved) {
        this.room.state = "negotiating";
        await this.persistRoom();
        await this.restoreApprovedPeers("camera");
        return;
      }
      await this.persistRoom();
      if (this.viewer?.info) {
        this.send(peer, { type: "viewer-request", device: this.viewer.info });
      }
      return;
    }
    if (message.type === "approve-viewer") {
      if (!this.viewer?.info) {
        this.send(peer, { type: "error", message: "No viewer is waiting." });
        return;
      }
      if (!message.allow) {
        this.send(this.viewer, { type: "denied", reason: "Camera denied the request." });
        this.viewer.socket.close(1008, "denied");
        this.viewer = null;
        this.room.viewerSession = undefined;
        this.room.state = "camera_connected";
        await this.persistRoom();
        return;
      }
      this.room.approved = true;
      this.room.state = "viewer_approved";
      peer.approved = true;
      this.viewer.approved = true;
      this.updatePeerSession(peer, { approved: true });
      this.updatePeerSession(this.viewer, { approved: true });
      await this.persistRoom();
      await this.scheduleNextAlarm();
      this.send(peer, { type: "approved" });
      this.send(this.viewer, { type: "approved" });
      return;
    }
    if (message.type === "offer") {
      if (!this.canNegotiate(peer, "viewer")) return;
      this.room!.state = "negotiating";
      await this.persistRoom();
      this.send(this.viewer!, { type: "offer", sdp: message.sdp });
      return;
    }
    if (message.type === "ice") {
      if (!this.canNegotiate(peer, "viewer")) return;
      this.send(this.viewer!, { type: "ice", candidate: message.candidate });
      return;
    }
    if (message.type === "connected") {
      this.room.state = "connected";
      await this.persistRoom();
      await this.scheduleNextAlarm();
    }
  }

  private async handleViewer(peer: PeerSocket, message: ClientMessage): Promise<void> {
    if (!this.room) return;
    if (message.type === "viewer-hello") {
      peer.info = message.device;
      this.updatePeerSession(peer, { info: message.device });
      if (this.room.approved && peer.approved) {
        this.room.state = "negotiating";
        await this.persistRoom();
        await this.restoreApprovedPeers("viewer");
        return;
      }
      this.room.state = "viewer_waiting";
      await this.persistRoom();
      this.send(peer, { type: "waiting-approval" });
      if (this.camera) {
        this.send(this.camera, { type: "viewer-request", device: message.device });
      }
      return;
    }
    if (message.type === "answer") {
      if (!this.canNegotiate(peer, "camera")) return;
      this.send(this.camera!, { type: "answer", sdp: message.sdp });
      return;
    }
    if (message.type === "ice") {
      if (!this.canNegotiate(peer, "camera")) return;
      this.send(this.camera!, { type: "ice", candidate: message.candidate });
      return;
    }
    if (message.type === "connected") {
      this.room.state = "connected";
      await this.persistRoom();
      await this.scheduleNextAlarm();
    }
  }

  private async restoreApprovedPeers(reconnectedRole: PeerRole): Promise<void> {
    const other = reconnectedRole === "camera" ? this.viewer : this.camera;
    const current = reconnectedRole === "camera" ? this.camera : this.viewer;
    if (current?.approved) this.send(current, { type: "approved" });
    if (other?.approved) {
      this.send(other, { type: "peer-reconnected", role: reconnectedRole });
      this.send(other, { type: "approved" });
    }
    await this.scheduleNextAlarm();
  }

  private canNegotiate(peer: PeerSocket, targetRole: PeerRole): boolean {
    const target = targetRole === "camera" ? this.camera : this.viewer;
    if (!this.room?.approved || !peer.approved || !target?.approved) {
      this.send(peer, { type: "error", message: "Viewer approval is required first." });
      return false;
    }
    return true;
  }

  private async handleClose(peer: PeerSocket): Promise<void> {
    const isCurrent =
      (peer.role === "camera" && this.camera === peer) ||
      (peer.role === "viewer" && this.viewer === peer);
    if (!isCurrent) return;
    if (peer.role === "camera" && this.camera === peer) this.camera = null;
    if (peer.role === "viewer" && this.viewer === peer) this.viewer = null;
    const remaining = peer.role === "camera" ? this.viewer : this.camera;
    if (!this.room || this.room.state === "ended" || this.room.state === "expired") return;

    const now = Date.now();
    this.updatePeerSession(peer, { connected: false, lastSeen: now, disconnectedAt: now });

    if (this.room.approved && peer.approved) {
      this.room.state = peer.role === "camera" ? "camera_reconnecting" : "viewer_reconnecting";
      if (remaining) {
        this.send(remaining, {
          type: "peer-reconnecting",
          role: peer.role,
          graceSeconds: Math.round(getActiveRoomIdleTtlMs(this.env) / 1000),
        });
      }
      await this.persistRoom();
      await this.scheduleNextAlarm();
      return;
    }

    if (remaining) this.send(remaining, { type: "peer-left", reason: "Peer disconnected." });
    if (peer.role === "viewer") this.room.viewerSession = undefined;
    await this.persistRoom();
  }

  private async rejectPeer(peer: PeerSocket, message: string): Promise<void> {
    await this.recordFailedJoin();
    this.send(peer, { type: "error", message });
    peer.socket.close(CLOSE_POLICY, "policy");
  }

  private async recordFailedJoin(): Promise<void> {
    if (!this.room) return;
    this.room.failedJoins += 1;
    await this.persistRoom();
  }

  private send(peer: PeerSocket, message: ServerMessage): void {
    if (peer.socket.readyState !== WebSocket.OPEN) return;
    this.sendRaw(peer.socket, message);
  }

  private sendRaw(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private isJoinExpired(): boolean {
    return Boolean(this.room && !this.room.approved && Date.now() >= this.room.setupExpiresAt);
  }

  private touchPeer(peer: PeerSocket): void {
    this.updatePeerSession(peer, { connected: true, lastSeen: Date.now(), disconnectedAt: undefined });
  }

  private updatePeerSession(peer: PeerSocket, patch: Partial<StoredPeerSession>): void {
    if (!this.room) return;
    const key = peer.role === "camera" ? "cameraSession" : "viewerSession";
    const current = this.room[key];
    if (!current || current.clientId !== peer.clientId) return;
    this.room[key] = { ...current, ...patch };
  }

  private async persistRoom(): Promise<void> {
    if (!this.room) return;
    await this.ctx.storage.put(ROOM_KEY, this.room);
  }

  private async handleAlarm(): Promise<void> {
    if (!this.room) return;
    if (this.room.state === "ended") {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    if (this.room.state === "expired") {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    const now = Date.now();
    if (!this.room.approved) {
      if (now >= this.room.setupExpiresAt) await this.expire("expired");
      else await this.scheduleNextAlarm();
      return;
    }

    const idleTtl = getActiveRoomIdleTtlMs(this.env);
    for (const role of ["camera", "viewer"] as const) {
      const session = role === "camera" ? this.room.cameraSession : this.room.viewerSession;
      const socket = role === "camera" ? this.camera : this.viewer;
      if (!session) continue;
      if (!session.connected && session.disconnectedAt && now - session.disconnectedAt >= idleTtl) {
        await this.end(`${role} did not reconnect`);
        return;
      }
      if (socket && session.connected && now - session.lastSeen >= getPeerGraceMs(this.env)) {
        socket.socket.close(1000, "heartbeat missed");
        await this.handleClose(socket);
        return;
      }
    }
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (!this.room || this.room.state === "ended" || this.room.state === "expired") return;
    if (!this.room.approved) {
      await this.ctx.storage.setAlarm(this.room.setupExpiresAt);
      return;
    }
    const now = Date.now();
    const idleTtl = getActiveRoomIdleTtlMs(this.env);
    const peerGrace = getPeerGraceMs(this.env);
    const recoverUntil = [this.room.cameraSession, this.room.viewerSession]
      .filter((session): session is StoredPeerSession => Boolean(session?.disconnectedAt))
      .map((session) => (session.disconnectedAt ?? now) + idleTtl);
    const heartbeatDue = [this.room.cameraSession, this.room.viewerSession]
      .filter((session): session is StoredPeerSession => Boolean(session?.connected))
      .map((session) => session.lastSeen + peerGrace);
    const next = Math.min(...recoverUntil, ...heartbeatDue, now + peerGrace);
    await this.ctx.storage.setAlarm(next);
  }

  private async end(reason: string): Promise<void> {
    if (!this.room || this.room.state === "ended" || this.room.state === "expired") return;
    this.room.state = "ended";
    await this.persistRoom();
    for (const peer of [this.camera, this.viewer]) {
      if (!peer) continue;
      this.send(peer, { type: "ended", reason });
      peer.socket.close(1000, "ended");
    }
    this.camera = null;
    this.viewer = null;
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private async expire(reason: "expired"): Promise<void> {
    if (this.room) {
      this.room.state = "expired";
      await this.persistRoom();
    }
    for (const peer of [this.camera, this.viewer]) {
      if (!peer) continue;
      this.send(peer, { type: "ended", reason });
      peer.socket.close(1000, "expired");
    }
    this.camera = null;
    this.viewer = null;
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}
