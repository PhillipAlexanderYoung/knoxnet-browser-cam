export const DIRECT_P2P_FAILURE_MESSAGE =
  "Direct peer-to-peer connection failed. This can happen on some cellular networks. Try same Wi-Fi, WireGuard receiver mode, or local receiver mode.";

export const DIRECT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export function createDirectPeerConnection(
  onIce: (candidate: RTCIceCandidateInit | null) => void,
  onFailure: () => void | Promise<void>,
): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: DIRECT_ICE_SERVERS,
    bundlePolicy: "max-bundle",
  });
  pc.onicecandidate = (event) => {
    onIce(event.candidate ? event.candidate.toJSON() : null);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") void onFailure();
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") void onFailure();
  };
  return pc;
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

export function buildDirectConstraints(opts: {
  facingMode: "user" | "environment";
  resolution: "480p" | "720p" | "1080p";
  frameRate: 5 | 10 | 15 | 30;
  audioEnabled: boolean;
}): MediaStreamConstraints {
  const height = opts.resolution === "1080p" ? 1080 : opts.resolution === "720p" ? 720 : 480;
  const width = opts.resolution === "1080p" ? 1920 : opts.resolution === "720p" ? 1280 : 854;
  return {
    video: {
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: opts.frameRate },
      facingMode: { ideal: opts.facingMode },
    },
    audio: opts.audioEnabled
      ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      : false,
  };
}
