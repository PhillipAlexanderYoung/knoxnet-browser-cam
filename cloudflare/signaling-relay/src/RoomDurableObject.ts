import { DurableObject } from "cloudflare:workers";
import {
  getMaxFailedJoins,
  getMaxMessageBytes,
  parseClientMessage,
  parseRole,
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
  expiresAt: number;
  state: RoomState;
  failedJoins: number;
  approved: boolean;
}

interface PeerSocket {
  role: PeerRole;
  socket: WebSocket;
  approved: boolean;
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
    await this.expire("expired");
  }

  private async createRoom(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as RoomCreateRequest | null;
    if (!body || typeof body.expiresAt !== "number") {
      return new Response("Bad request", { status: 400 });
    }
    const expiresAt = body.expiresAt;
    this.room = {
      expiresAt,
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
    if (this.isExpired()) {
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
    if (role === "camera" && this.camera) {
      await this.recordFailedJoin();
      return new Response("Camera already connected", { status: 409 });
    }
    if (role === "viewer" && (this.viewer || this.room.approved)) {
      await this.recordFailedJoin();
      return new Response("Room is locked", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const peer: PeerSocket = { role, socket: server, approved: false };
    if (role === "camera") this.camera = peer;
    else this.viewer = peer;
    this.attach(peer);
    this.send(peer, {
      type: "room-ready",
      state: this.room.state,
      expiresAt: new Date(this.room.expiresAt).toISOString(),
    });
    return new Response(null, { status: 101, webSocket: client });
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
    if (this.isExpired()) {
      await this.expire("expired");
      return;
    }

    if (message.type === "ping") {
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
      this.room.state = this.viewer ? "viewer_waiting" : "camera_connected";
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
        this.room.state = "camera_connected";
        await this.persistRoom();
        return;
      }
      this.room.approved = true;
      this.room.state = "viewer_approved";
      peer.approved = true;
      this.viewer.approved = true;
      await this.persistRoom();
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
    }
  }

  private async handleViewer(peer: PeerSocket, message: ClientMessage): Promise<void> {
    if (!this.room) return;
    if (message.type === "viewer-hello") {
      peer.info = message.device;
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
    }
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
    if (peer.role === "camera" && this.camera === peer) this.camera = null;
    if (peer.role === "viewer" && this.viewer === peer) this.viewer = null;
    const remaining = peer.role === "camera" ? this.viewer : this.camera;
    if (remaining) {
      this.send(remaining, { type: "peer-left", reason: "Peer disconnected." });
    }
    if (this.room?.approved || peer.role === "camera") {
      await this.end("peer disconnected");
    }
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
    peer.socket.send(JSON.stringify(message));
  }

  private isExpired(): boolean {
    return Boolean(this.room && Date.now() >= this.room.expiresAt);
  }

  private async persistRoom(): Promise<void> {
    if (!this.room) return;
    await this.ctx.storage.put(ROOM_KEY, this.room);
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
  }
}
