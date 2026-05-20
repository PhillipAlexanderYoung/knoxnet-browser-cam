import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, Video, Volume2, VolumeX } from "lucide-react";
import { Header } from "../components/Header";
import {
  describeThisDevice,
  DirectSignalingClient,
  wsUrlForToken,
} from "./signalingClient";
import {
  createDirectPeerConnection,
  DIRECT_P2P_FAILURE_MESSAGE,
  stopStream,
} from "./webrtc";
import "./DirectView.css";

type ViewerStatus =
  | "idle"
  | "joining"
  | "waiting-approval"
  | "connecting"
  | "connected"
  | "failed"
  | "ended";

interface DirectViewViewerProps {
  roomToken?: string;
  onBack?: () => void;
}

export function DirectViewViewer({ roomToken, onBack }: DirectViewViewerProps) {
  const [token, setToken] = useState(roomToken ?? "");
  const [status, setStatus] = useState<ViewerStatus>(roomToken ? "joining" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [needsPlay, setNeedsPlay] = useState(false);
  const clientRef = useRef<DirectSignalingClient | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const cleanup = useCallback((sendBye = true) => {
    clientRef.current?.close(sendBye);
    clientRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    stopStream(remoteStreamRef.current);
    remoteStreamRef.current = null;
  }, []);

  useEffect(() => () => cleanup(false), [cleanup]);

  const attachAndPlay = useCallback(async (stream: MediaStream) => {
    remoteStreamRef.current = stream;
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
    videoRef.current.muted = muted;
    try {
      await videoRef.current.play();
      setNeedsPlay(false);
    } catch {
      setNeedsPlay(true);
    }
  }, [muted]);

  const join = useCallback(async (joinToken = token) => {
    const cleanToken = joinToken.trim();
    if (!cleanToken) return;
    cleanup(false);
    setError(null);
    setStatus("joining");
    setToken(cleanToken);
    const client = new DirectSignalingClient(
      wsUrlForToken(cleanToken),
      async (message) => {
        if (message.type === "room-ready") {
          client.send({ type: "viewer-hello", device: describeThisDevice() });
        } else if (message.type === "waiting-approval") {
          setStatus("waiting-approval");
        } else if (message.type === "approved") {
          setStatus("connecting");
          const pc = createDirectPeerConnection(
            (candidate) => client.send({ type: "ice", candidate }),
            () => {
              setError(DIRECT_P2P_FAILURE_MESSAGE);
              setStatus("failed");
            },
          );
          pc.ontrack = (event) => {
            const stream = event.streams[0] ?? new MediaStream([event.track]);
            void attachAndPlay(stream);
          };
          pc.onconnectionstatechange = () => {
            if (pc.connectionState === "connected") {
              setStatus("connected");
              client.send({ type: "connected" });
            } else if (pc.connectionState === "failed") {
              setError(DIRECT_P2P_FAILURE_MESSAGE);
              setStatus("failed");
            }
          };
          pcRef.current = pc;
        } else if (message.type === "offer") {
          const pc = pcRef.current;
          if (!pc) return;
          await pc.setRemoteDescription(message.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          client.send({ type: "answer", sdp: pc.localDescription ?? answer });
        } else if (message.type === "ice") {
          if (message.candidate?.candidate) {
            await pcRef.current?.addIceCandidate(message.candidate);
          }
        } else if (message.type === "denied") {
          setError(message.reason);
          setStatus("failed");
        } else if (message.type === "peer-left" || message.type === "ended") {
          setStatus("ended");
        } else if (message.type === "error") {
          setError(message.message);
          setStatus("failed");
        }
      },
      () => setStatus((current) => (current === "ended" ? current : "failed")),
      (message) => {
        setError(message);
        setStatus("failed");
      },
    );
    clientRef.current = client;
    client.connect("viewer");
  }, [attachAndPlay, cleanup, token]);

  useEffect(() => {
    if (roomToken) void join(roomToken);
    // Initial QR route join only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomToken]);

  const disconnect = useCallback(() => {
    cleanup(true);
    setStatus("ended");
  }, [cleanup]);

  const playNow = useCallback(async () => {
    try {
      await videoRef.current?.play();
      setNeedsPlay(false);
    } catch {
      setNeedsPlay(true);
    }
  }, []);

  const statusText = {
    idle: "Paste or scan a Direct View link",
    joining: "Joining room",
    "waiting-approval": "Waiting for camera approval",
    connecting: "Connecting peer-to-peer",
    connected: "Connected",
    failed: "Connection failed",
    ended: "Session ended",
  }[status];

  return (
    <div className="direct-view">
      <Header live={status === "connected"} />
      {onBack && (
        <button type="button" className="direct-link" onClick={onBack}>
          Back to receiver mode
        </button>
      )}

      <section className="direct-card">
        <div className="direct-title">
          <Video size={18} />
          Direct View: View another phone
        </div>
        <div className="direct-badges">
          <span>Cloudflare signaling only</span>
          <span>No cloud video relay</span>
          <span>Video path: Phone -&gt; Viewer</span>
        </div>
      </section>

      <div className={`direct-video ${status === "connected" ? "direct-video--live" : ""}`}>
        <video ref={videoRef} autoPlay playsInline muted={muted} controls={status === "connected"} />
        {needsPlay && (
          <button type="button" className="direct-play" onClick={() => void playNow()}>
            Tap to play live video
          </button>
        )}
      </div>

      <div className="direct-status">
        <span className={`dot ${status === "failed" ? "dot--red" : status === "connected" ? "dot--green" : "dot--amber"}`} />
        <span>{statusText}</span>
      </div>

      {error && <div className="direct-error">{error}</div>}

      {!roomToken && (
        <section className="direct-card direct-controls">
          <label>
            Room token
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste room token" />
          </label>
          <button type="button" className="btn btn--primary" onClick={() => void join()}>
            Join Direct View
          </button>
        </section>
      )}

      {status === "waiting-approval" && (
        <section className="direct-card direct-approval">
          <div className="direct-title">
            <ShieldCheck size={18} />
            Waiting for camera approval
          </div>
          <p>The camera phone must tap Allow before WebRTC negotiation starts.</p>
        </section>
      )}

      {status === "connected" && (
        <button type="button" className="btn" onClick={() => setMuted((next) => !next)}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          {muted ? "Unmute" : "Mute"}
        </button>
      )}

      {status !== "idle" && status !== "ended" && (
        <button type="button" className="btn btn--danger direct-end" onClick={disconnect}>
          Disconnect
        </button>
      )}
    </div>
  );
}
