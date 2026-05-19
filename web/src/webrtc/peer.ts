import type { SignalingClient } from "./signaling-client";

const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export interface PeerOptions {
  sessionId: string;
  signaling: SignalingClient;
  stream: MediaStream;
  onConnectionStateChange: (s: RTCPeerConnectionState) => void;
  onIceConnectionStateChange?: (s: RTCIceConnectionState) => void;
  maxBitrateKbps?: number;
  onLog?: (...args: unknown[]) => void;
}

export interface StreamStats {
  outboundBytesPerSec: number;
  bitrateKbps: number;
  rttMs: number | null;
  packetsLost: number;
  fractionLost: number; // 0..1
  framesPerSecond: number | null;
  resolution: { width: number; height: number } | null;
}

const EMPTY_STATS: StreamStats = {
  outboundBytesPerSec: 0,
  bitrateKbps: 0,
  rttMs: null,
  packetsLost: 0,
  fractionLost: 0,
  framesPerSecond: null,
  resolution: null,
};

export class CameraPeer {
  readonly pc: RTCPeerConnection;
  private readonly opts: PeerOptions;
  private readonly senders: RTCRtpSender[] = [];
  private lastBytesSent = 0;
  private lastBytesSentAt = 0;
  private lastPacketsLost = 0;
  private lastPacketsSent = 0;
  private statsCache: StreamStats = { ...EMPTY_STATS };
  private destroyed = false;

  constructor(opts: PeerOptions) {
    this.opts = opts;
    this.pc = new RTCPeerConnection({
      iceServers: STUN_SERVERS,
      bundlePolicy: "max-bundle",
    });

    for (const track of opts.stream.getTracks()) {
      const sender = this.pc.addTrack(track, opts.stream);
      this.senders.push(sender);
    }

    this.pc.onicecandidate = (ev) => {
      opts.signaling.send({
        type: "ice",
        sessionId: opts.sessionId,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      });
    };
    this.pc.onconnectionstatechange = () => {
      opts.onConnectionStateChange(this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      opts.onIceConnectionStateChange?.(this.pc.iceConnectionState);
    };

    if (opts.maxBitrateKbps) {
      void this.applyMaxBitrate(opts.maxBitrateKbps);
    }
  }

  async applyMaxBitrate(kbps: number): Promise<void> {
    for (const sender of this.senders) {
      if (sender.track?.kind !== "video") continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = kbps * 1000;
        await sender.setParameters(params);
      } catch (err) {
        this.opts.onLog?.("setParameters failed", err);
      }
    }
  }

  async createAndSendOffer(): Promise<void> {
    const offer = await this.pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    await this.pc.setLocalDescription(offer);
    this.opts.signaling.send({
      type: "offer",
      sessionId: this.opts.sessionId,
      sdp: { type: offer.type, sdp: offer.sdp },
    });
  }

  async acceptAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(sdp);
  }

  async addRemoteIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate || !candidate.candidate) {
      // End-of-candidates marker; safe to ignore.
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      this.opts.onLog?.("addIceCandidate failed", err);
    }
  }

  async pollStats(): Promise<StreamStats> {
    if (this.destroyed || this.pc.connectionState === "closed") {
      return this.statsCache;
    }
    let outboundBytes = 0;
    let packetsSent = 0;
    let packetsLost = 0;
    let rttMs: number | null = null;
    let fps: number | null = null;
    let width: number | undefined;
    let height: number | undefined;

    try {
      const report = await this.pc.getStats();
      report.forEach((stat) => {
        const s = stat as Record<string, unknown> & { type: string };
        if (s.type === "outbound-rtp" && (s.kind === "video" || s.mediaType === "video")) {
          if (typeof s.bytesSent === "number") outboundBytes += s.bytesSent;
          if (typeof s.packetsSent === "number") packetsSent += s.packetsSent;
          if (typeof s.framesPerSecond === "number") fps = s.framesPerSecond;
          if (typeof s.frameWidth === "number") width = s.frameWidth as number;
          if (typeof s.frameHeight === "number") height = s.frameHeight as number;
        }
        if (s.type === "remote-inbound-rtp" && (s.kind === "video" || s.mediaType === "video")) {
          if (typeof s.packetsLost === "number") packetsLost += s.packetsLost;
          if (typeof s.roundTripTime === "number") {
            rttMs = (s.roundTripTime as number) * 1000;
          }
        }
        if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
          if (typeof s.currentRoundTripTime === "number" && rttMs === null) {
            rttMs = (s.currentRoundTripTime as number) * 1000;
          }
        }
      });
    } catch (err) {
      this.opts.onLog?.("getStats failed", err);
      return this.statsCache;
    }

    const now = performance.now();
    let bytesPerSec = 0;
    if (this.lastBytesSentAt > 0) {
      const dt = (now - this.lastBytesSentAt) / 1000;
      if (dt > 0) {
        bytesPerSec = Math.max(0, (outboundBytes - this.lastBytesSent) / dt);
      }
    }
    this.lastBytesSent = outboundBytes;
    this.lastBytesSentAt = now;

    const dPacketsSent = Math.max(0, packetsSent - this.lastPacketsSent);
    const dPacketsLost = Math.max(0, packetsLost - this.lastPacketsLost);
    const fractionLost =
      dPacketsSent > 0 ? Math.min(1, dPacketsLost / Math.max(1, dPacketsSent)) : 0;
    this.lastPacketsSent = packetsSent;
    this.lastPacketsLost = packetsLost;

    this.statsCache = {
      outboundBytesPerSec: bytesPerSec,
      bitrateKbps: Math.round((bytesPerSec * 8) / 1000),
      rttMs,
      packetsLost,
      fractionLost,
      framesPerSecond: fps,
      resolution:
        typeof width === "number" && typeof height === "number"
          ? { width, height }
          : null,
    };
    return this.statsCache;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.opts.signaling.send({
        type: "bye",
        sessionId: this.opts.sessionId,
      });
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
  }
}
