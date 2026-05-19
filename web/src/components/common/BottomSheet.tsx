import { type ReactNode, useEffect } from "react";
import { X } from "lucide-react";
import "./BottomSheet.css";

interface BottomSheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function BottomSheet({ open, title, onClose, children }: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="sheet__backdrop"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="sheet__panel">
        <div className="sheet__header">
          <span className="sheet__title">{title}</span>
          <button
            type="button"
            className="sheet__close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="sheet__content">{children}</div>
      </div>
    </div>
  );
}

interface SheetOptionProps {
  active: boolean;
  label: string;
  sublabel?: string;
  disabled?: boolean;
  onClick: () => void;
}

export function SheetOption({
  active,
  label,
  sublabel,
  disabled,
  onClick,
}: SheetOptionProps) {
  return (
    <button
      type="button"
      className={`sheetopt ${active ? "sheetopt--active" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="sheetopt__col">
        <span className="sheetopt__label">{label}</span>
        {sublabel && <span className="sheetopt__sub">{sublabel}</span>}
      </span>
      {active && <span className="sheetopt__dot" />}
    </button>
  );
}
