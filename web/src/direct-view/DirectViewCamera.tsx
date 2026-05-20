import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, QrCode, Share2, ShieldCheck, Square, Video } from "lucide-react";
import { Header } from "../components/Header";
import {
  createDirectRoom,
  describeThisDevice,
  DirectSignalingClient,
  type DirectRoom,
  type PeerInfo,
} from "./signalingClient";
import {
  buildDirectConstraints,
  createDirectPeerConnection,
  DIRECT_P2P_FAILURE_MESSAGE,
  stopStream,
} from "./webrtc";
import { qrDataUrl } from "./qr";
import "./DirectView.css";

type Status =
  | "idle"
  | "starting"
  | "waiting"
  | "viewer-request"
  | "connecting"
  | "connected"
  | "failed"
  | "ended";

interface DirectViewCameraProps {
  onBack: () => void;
}

export function DirectViewCamera({ onBack }: DirectViewCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<DirectSignalingClient | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [room, setRoom] = useState<DirectRoom | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<PeerInfo | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");
  const [resolution, setResolution] = useState<"480p" | "720p" | "1080p">("720p");
  const [frameRate, setFrameRate] = useState<5 | 10 | 15 | 30>(15);
  const [audioEnabled, setAudioEnabled] = useState(false);

  useEffect(() => {
    if (videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status]);

  useEffect(() => {
    if (!room) return;
    const update = () => {
      setExpiresIn(Math.max(0, Math.ceil((Date.parse(room.expiresAt) - Date.now()) / 1000)));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [room]);

  const cleanup = useCallback((sendBye = true) => {
    clientRef.current?.close(sendBye);
    clientRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
  }, []);

  useEffect(() => () => cleanup(false), [cleanup]);

  const start = useCallback(async () => {
    setStatus("starting");
    setError(null);
    setViewer(null);
    cleanup(false);
    try {
      const media = await navigator.mediaDevices.getUserMedia(
        buildDirectConstraints({ facingMode, resolution, frameRate, audioEnabled }),
      );
      streamRef.current = media;
      if (videoRef.current) videoRef.current.srcObject = media;
      const nextRoom = await createDirectRoom();
      setRoom(nextRoom);
      setQr(await qrDataUrl(nextRoom.joinUrl));
      const client = new DirectSignalingClient(
        nextRoom.wsUrl,
        async (message) => {
          if (message.type === "room-ready") {
            client.send({
              type: "camera-hello",
              device: describeThisDevice(),
              audio: audioEnabled,
            });
            setStatus("waiting");
          } else if (message.type === "viewer-request") {
            setViewer(message.device);
            setStatus("viewer-request");
          } else if (message.type === "approved") {
            setStatus("connecting");
            await createOffer(client);
          } else if (message.type === "answer") {
            await pcRef.current?.setRemoteDescription(message.sdp);
          } else if (message.type === "ice") {
            if (message.candidate?.candidate) {
              await pcRef.current?.addIceCandidate(message.candidate);
            }
          } else if (message.type === "peer-left" || message.type === "ended") {
            setStatus("ended");
          } else if (message.type === "error" || message.type === "denied") {
            setError("message" in message ? message.message : message.reason);
          }
        },
        () => setStatus((current) => (current === "ended" ? current : "failed")),
        (message) => setError(message),
      );
      clientRef.current = client;
      client.connect("camera");
    } catch (err) {
      setError((err as Error)?.message ?? "Could not start Direct View camera.");
      setStatus("failed");
    }
  }, [audioEnabled, cleanup, facingMode, frameRate, resolution]);

  const createOffer = useCallback(async (client: DirectSignalingClient) => {
    const stream = streamRef.current;
    if (!stream) throw new Error("Camera stream is not available.");
    const pc = createDirectPeerConnection(
      (candidate) => client.send({ type: "ice", candidate }),
      () => {
        setError(DIRECT_P2P_FAILURE_MESSAGE);
        setStatus("failed");
      },
    );
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setStatus("connected");
        client.send({ type: "connected" });
      } else if (pc.connectionState === "failed") {
        setError(DIRECT_P2P_FAILURE_MESSAGE);
        setStatus("failed");
      }
    };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pcRef.current = pc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    client.send({ type: "offer", sdp: pc.localDescription ?? offer });
  }, []);

  const approve = useCallback((allow: boolean) => {
    clientRef.current?.send({ type: "approve-viewer", allow });
    if (!allow) {
      setViewer(null);
      setStatus("waiting");
    }
  }, []);

  const end = useCallback(() => {
    cleanup(true);
    setStatus("ended");
  }, [cleanup]);

  const copyLink = useCallback(async () => {
    if (room?.joinUrl) await navigator.clipboard?.writeText(room.joinUrl);
  }, [room]);

  const shareLink = useCallback(async () => {
    if (!room?.joinUrl) return;
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (nav.share) await nav.share({ title: "Knoxnet Direct View", url: room.joinUrl });
    else await copyLink();
  }, [copyLink, room]);

  const statusText = useMemo(() => {
    switch (status) {
      case "starting":
        return "Starting camera and secure room...";
      case "waiting":
        return "Waiting for viewer";
      case "viewer-request":
        return "Viewer requesting access";
      case "connecting":
        return "Connecting peer-to-peer";
      case "connected":
        return "Connected";
      case "failed":
        return "Connection failed";
      case "ended":
        return "Session ended";
      default:
        return "Ready to share";
    }
  }, [status]);

  return (
    <div className="direct-view">
      <Header live={status === "connected"} />
      <button type="button" className="direct-link" onClick={onBack}>
        Back to receiver mode
      </button>

      <section className="direct-card">
        <div className="direct-title">
          <Video size={18} />
          Direct View: Use this phone as camera
        </div>
        <div className="direct-badges">
          <span>Cloudflare signaling only</span>
          <span>No cloud video relay</span>
          <span>Video path: Phone -&gt; Viewer</span>
        </div>
      </section>

      <div className={`direct-video ${status === "connected" ? "direct-video--live" : ""}`}>
        <video ref={videoRef} autoPlay muted playsInline />
      </div>

      <div className="direct-status">
        <span className={`dot ${status === "failed" ? "dot--red" : status === "connected" ? "dot--green" : "dot--amber"}`} />
        <span>{statusText}</span>
      </div>

      {error && <div className="direct-error">{error}</div>}

      {status === "idle" || status === "failed" || status === "ended" ? (
        <div className="direct-card direct-controls">
          <label>
            Camera
            <select value={facingMode} onChange={(e) => setFacingMode(e.target.value as "user" | "environment")}>
              <option value="environment">Back</option>
              <option value="user">Front</option>
            </select>
          </label>
          <label>
            Quality
            <select value={resolution} onChange={(e) => setResolution(e.target.value as "480p" | "720p" | "1080p")}>
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          <label>
            FPS
            <select value={frameRate} onChange={(e) => setFrameRate(Number(e.target.value) as 5 | 10 | 15 | 30)}>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={30}>30</option>
            </select>
          </label>
          <label className="direct-check">
            <input type="checkbox" checked={audioEnabled} onChange={(e) => setAudioEnabled(e.target.checked)} />
            Mic on
          </label>
          <button type="button" className="btn btn--primary" onClick={() => void start()}>
            Share Camera
          </button>
        </div>
      ) : null}

      {room && status !== "ended" && (
        <section className="direct-card direct-share">
          <div className="direct-share__qr">
            {qr ? <img src={qr} alt="Direct View join QR" /> : <QrCode />}
          </div>
          <div className="direct-countdown">Room expires in: {formatSeconds(expiresIn)}</div>
          <input readOnly value={room.joinUrl} onFocus={(e) => e.currentTarget.select()} />
          <div className="direct-actions">
            <button type="button" className="btn" onClick={() => void copyLink()}>
              <Copy size={14} /> Copy
            </button>
            <button type="button" className="btn" onClick={() => void shareLink()}>
              <Share2 size={14} /> Share
            </button>
          </div>
        </section>
      )}

      {status === "viewer-request" && viewer && (
        <section className="direct-card direct-approval" role="alert">
          <div className="direct-title">
            <ShieldCheck size={18} />
            Viewer wants to connect: {viewer.label}
          </div>
          <p>{viewer.platform ?? "Unknown platform"} · {viewer.language ?? "unknown language"}</p>
          <div className="direct-actions">
            <button type="button" className="btn btn--danger" onClick={() => approve(false)}>
              Deny
            </button>
            <button type="button" className="btn btn--primary" onClick={() => approve(true)}>
              Allow
            </button>
          </div>
        </section>
      )}

      {status !== "idle" && status !== "ended" && (
        <button type="button" className="btn btn--danger direct-end" onClick={end}>
          <Square size={14} /> End Session
        </button>
      )}
    </div>
  );
}

function formatSeconds(seconds: number): string {
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = Math.max(0, seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}
