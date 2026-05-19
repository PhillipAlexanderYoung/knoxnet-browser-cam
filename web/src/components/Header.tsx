import "./Header.css";

interface HeaderProps {
  live: boolean;
}

export function Header({ live }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <div className="topbar__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <path
              d="M12 2.5 3.5 6v6c0 5.2 3.6 8.6 8.5 9.9 4.9-1.3 8.5-4.7 8.5-9.9V6L12 2.5z"
              stroke="#22C55E"
              strokeWidth="1.75"
              strokeLinejoin="round"
              fill="rgba(34,197,94,0.12)"
            />
            <text
              x="12"
              y="15"
              textAnchor="middle"
              fontFamily="-apple-system, Inter, system-ui, sans-serif"
              fontWeight="700"
              fontSize="9"
              fill="#22C55E"
            >
              K
            </text>
          </svg>
        </div>
        <span className="topbar__title">Knoxnet Browser Cam</span>
      </div>
      {live && (
        <div className="topbar__live" aria-label="Streaming live">
          <span className="topbar__live-dot" />
          <span>LIVE</span>
        </div>
      )}
    </header>
  );
}
