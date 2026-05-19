import { useEffect } from "react";

interface ToastProps {
  message: string | null;
  onDone: () => void;
  durationMs?: number;
}

export function Toast({ message, onDone, durationMs = 2200 }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(onDone, durationMs);
    return () => window.clearTimeout(t);
  }, [message, durationMs, onDone]);
  if (!message) return null;
  return <div className="toast" role="status">{message}</div>;
}
