import { Info, Video, Wifi } from "lucide-react";
import "./TabBar.css";

export type TabKey = "camera" | "network" | "info";

interface TabBarProps {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}

export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav className="tabbar" aria-label="Primary">
      <TabButton
        active={active === "camera"}
        label="Camera"
        Icon={Video}
        onClick={() => onChange("camera")}
      />
      <TabButton
        active={active === "network"}
        label="Network"
        Icon={Wifi}
        onClick={() => onChange("network")}
      />
      <TabButton
        active={active === "info"}
        label="Info"
        Icon={Info}
        onClick={() => onChange("info")}
      />
    </nav>
  );
}

interface TabButtonProps {
  active: boolean;
  label: string;
  Icon: typeof Video;
  onClick: () => void;
}

function TabButton({ active, label, Icon, onClick }: TabButtonProps) {
  return (
    <button
      type="button"
      className={`tabbar__btn ${active ? "tabbar__btn--active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={22} strokeWidth={1.9} />
      <span className="tabbar__label">{label}</span>
      <span className="tabbar__underline" aria-hidden="true" />
    </button>
  );
}
