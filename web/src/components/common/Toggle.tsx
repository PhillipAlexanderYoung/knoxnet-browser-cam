import "./Toggle.css";

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Toggle({ checked, onChange, disabled, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`toggle ${checked ? "toggle--on" : ""}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="toggle__knob" />
    </button>
  );
}
