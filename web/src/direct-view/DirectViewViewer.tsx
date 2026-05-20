import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode, ShieldCheck, Video, Volume2, VolumeX } from "lucide-react";
import { Header } from "../components/Header";
import { DirectViewScanner } from "./DirectViewScanner";
import { parseDirectViewInvite, type DirectViewQrResult } from "./qr";
import {
  describeThisDevice,
  directReconnectTokenKey,
  DirectSignalingClient,
  getOrCreateDirectClientId,
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
  | "reconnecting-camera"
  | "reconnecting-viewer"
  | "failed"
  | "ended";

interface DirectViewViewerProps {
  roomToken?: string;
  onBack?: () => void;
  onRoomToken?: (roomToken: string) => void;
  onReceiverInvite?: (invite: Extract<DirectViewQrResult, { type: "receiver" }>) => void;
}

export function DirectViewViewer({ roomToken, onBack, onRoomToken, onReceiverInvite }: DirectViewViewerProps) {
  const [token, setToken] = useState(roomToken ?? "");
  const [status, setStatus] = useState<ViewerStatus>(roomToken ? "joining" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [needsPlay, setNeedsPlay] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const clientRef = useRef<DirectSignalingClient | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reconnectingRef = useRef(false);

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
    const tokenKey = directReconnectTokenKey("viewer", cleanToken);
    const client = new DirectSignalingClient(
      wsUrlForToken(cleanToken),
      async (message) => {
        if (message.type === "room-ready") {
          client.send({ type: "viewer-hello", device: describeThisDevice() });
          if (message.state === "camera_reconnecting" || message.state === "connected" || message.state === "negotiating") {
            setStatus("reconnecting-camera");
          }
        } else if (message.type === "session") {
          // handled by the client so it can persist reconnect identity
        } else if (message.type === "waiting-approval") {
          setStatus("waiting-approval");
        } else if (message.type === "approved") {
          setStatus("connecting");
          reconnectingRef.current = false;
          pcRef.current?.close();
          const pc = createDirectPeerConnection(
            (candidate) => client.send({ type: "ice", candidate }),
            () => {
              if (!reconnectingRef.current) {
                reconnectingRef.current = true;
                setStatus("reconnecting-camera");
                return;
              }
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
              reconnectingRef.current = false;
              setStatus("connected");
              client.send({ type: "connected" });
            } else if (pc.connectionState === "disconnected") {
              setStatus("reconnecting-camera");
            } else if (pc.connectionState === "failed") {
              if (!reconnectingRef.current) {
                reconnectingRef.current = true;
                setStatus("reconnecting-camera");
              } else {
                setError(DIRECT_P2P_FAILURE_MESSAGE);
                setStatus("failed");
              }
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
          client.close(false);
          setError(message.reason);
          setStatus("failed");
        } else if (message.type === "peer-reconnecting") {
          if (message.role === "camera") setStatus("reconnecting-camera");
        } else if (message.type === "peer-reconnected") {
          setStatus("connecting");
        } else if (message.type === "peer-left" || message.type === "ended") {
          client.close(false);
          setStatus("ended");
        } else if (message.type === "error") {
          client.close(false);
          setError(message.message);
          setStatus("failed");
        }
      },
      () => setStatus((current) => (current === "ended" ? current : "failed")),
      (message) => {
        setError(message);
      },
    );
    clientRef.current = client;
    client.connect("viewer", {
      clientId: getOrCreateDirectClientId(),
      reconnectToken: localStorage.getItem(tokenKey),
      onReconnectToken: (nextToken) => localStorage.setItem(tokenKey, nextToken),
      onReconnecting: () => setStatus((current) => (current === "ended" ? current : "reconnecting-viewer")),
    });
  }, [attachAndPlay, cleanup, token]);

  const openRoomToken = useCallback((nextToken: string) => {
    setScannerOpen(false);
    setError(null);
    setToken(nextToken);
    if (onRoomToken) {
      onRoomToken(nextToken);
      return;
    }
    window.history.pushState({}, "", `/join/${encodeURIComponent(nextToken)}`);
    void join(nextToken);
  }, [join, onRoomToken]);

  const handleQrResult = useCallback((result: DirectViewQrResult) => {
    if (result.type === "direct-view") {
      openRoomToken(result.roomToken);
      return;
    }

    setScannerOpen(false);
    if (onReceiverInvite) {
      onReceiverInvite(result);
      return;
    }
    setError("Receiver QR found. Return to Local VMS Camera mode to use it.");
  }, [onReceiverInvite, openRoomToken]);

  useEffect(() => {
    if (roomToken) void join(roomToken);
    // Initial QR route join only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomToken]);

  useEffect(() => {
    if (roomToken) setScannerOpen(false);
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

  const submitInvite = useCallback(() => {
    const nextToken = parseDirectViewInvite(token);
    if (!nextToken) {
      setError("Paste a Direct View invite link or room token.");
      return;
    }
    openRoomToken(nextToken);
  }, [openRoomToken, token]);

  const statusText = {
    idle: "Scan or paste a Direct View invite",
    joining: "Joining room",
    "waiting-approval": "Waiting for camera approval",
    connecting: "Connecting peer-to-peer",
    connected: "Connected",
    "reconnecting-camera": "Camera disconnected, reconnecting",
    "reconnecting-viewer": "Reconnecting signaling",
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
        {scannerOpen ? (
          <DirectViewScanner onResult={handleQrResult} onStop={() => setScannerOpen(false)} />
        ) : (
          <>
            <video ref={videoRef} autoPlay playsInline muted={muted} controls={status === "connected"} />
            {needsPlay && (
              <button type="button" className="direct-play" onClick={() => void playNow()}>
                Tap to play live video
              </button>
            )}
          </>
        )}
      </div>

      <div className="direct-status">
        <span className={`dot ${status === "failed" ? "dot--red" : status === "connected" ? "dot--green" : "dot--amber"}`} />
        <span>{statusText}</span>
      </div>

      {error && <div className="direct-error">{error}</div>}

      {!roomToken && (
        <section className="direct-card direct-controls direct-viewer-options">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setError(null);
              setScannerOpen(true);
            }}
          >
            <QrCode size={14} /> Scan QR in app
          </button>
          <label>
            Paste/open invite link
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="https://cam.knoxnetvms.com/join/..."
            />
          </label>
          <button type="button" className="btn" onClick={submitInvite}>
            Join Direct View
          </button>
          <p className="direct-note">You can also scan the QR with your phone's Camera app.</p>
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
