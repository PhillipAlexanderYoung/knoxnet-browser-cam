import "./Header.css";

interface HeaderProps {
  live: boolean;
}

export function Header({ live }: HeaderProps) {
  return (
    <header className="topbar">
      <div className="topbar__brand">
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
