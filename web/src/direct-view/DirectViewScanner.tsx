import { useCallback, useEffect, useRef, useState } from "react";
import { ScanLine, Square } from "lucide-react";
import { parseQrInvite, type DirectViewQrResult } from "./qr";
import { stopStream } from "./webrtc";
import "./DirectView.css";

type DetectedBarcode = {
  rawValue?: string;
};

type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
};

type BarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
};

interface DirectViewScannerProps {
  onResult: (result: DirectViewQrResult) => void;
  onStop: () => void;
}

export function DirectViewScanner({ onResult, onStop }: DirectViewScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const timerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const [message, setMessage] = useState("Starting scanner...");
  const [isReady, setIsReady] = useState(false);

  const stopCamera = useCallback(() => {
    stoppedRef.current = true;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const scanFrame = useCallback(async () => {
    if (stoppedRef.current) return;
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      timerRef.current = window.setTimeout(scanFrame, 250);
      return;
    }

    try {
      const codes = await detector.detect(video);
      const rawValue = codes.find((code) => code.rawValue)?.rawValue;
      if (rawValue) {
        const result = parseQrInvite(rawValue);
        if (result) {
          setMessage(result.type === "direct-view" ? "Direct View QR found. Joining..." : "Receiver QR found. Loading settings...");
          stopCamera();
          onResult(result);
          return;
        }
        setMessage("Unsupported QR. Scan a receiver or Direct View invite.");
      }
    } catch {
      // Keep scanning; transient decode errors are common while the phone moves.
    }

    timerRef.current = window.setTimeout(scanFrame, 350);
  }, [onResult, stopCamera]);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      stoppedRef.current = false;
      const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (!Detector) {
        setMessage("This browser cannot scan QR codes in-app. Use Camera app or paste the invite link.");
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setMessage("Camera access is not available here. Use Camera app or paste the invite link.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stopStream(stream);
          return;
        }

        streamRef.current = stream;
        detectorRef.current = new Detector({ formats: ["qr_code"] });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setIsReady(true);
        setMessage("Point the camera at a receiver or Direct View QR.");
        void scanFrame();
      } catch (err) {
        stopCamera();
        const name = (err as DOMException)?.name;
        setMessage(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera permission was denied. Allow access, use Camera app, or paste the invite link."
            : "Could not start the QR scanner. Use Camera app or paste the invite link.",
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [scanFrame, stopCamera]);

  return (
    <div className="direct-scanner">
      <video ref={videoRef} autoPlay muted playsInline />
      <div className="direct-scanner__shade" aria-hidden="true">
        <ScanLine size={28} />
      </div>
      <div className="direct-scanner__bar">
        <span className={isReady ? "dot dot--green" : "dot dot--amber"} />
        <span>{message}</span>
      </div>
      <button
        type="button"
        className="btn btn--danger direct-scanner__stop"
        onClick={() => {
          stopCamera();
          onStop();
        }}
      >
        <Square size={14} /> Stop Scan
      </button>
    </div>
  );
}
