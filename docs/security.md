# Security model — knoxnet-browser-cam

This project is intentionally **local-only by design**. The threat model is a
home / small-business LAN where a phone browser becomes a camera source, and
the local Knoxnet VMS receiver is the only consumer.

## What protects a stream

- **Pairing code (required).** The receiver generates a random alphanumeric
  pairing code on every boot (unless `PAIRING_CODE` is supplied via env). The
  code is required for both `camera` and `viewer` WebSocket roles; without it,
  the connection is closed with `4001 bad-pairing-code`.
- **Operator-controlled acceptance.** Cameras connect in `pending` state and
  must be **Accepted** from the receiver dashboard before any SDP/ICE is
  forwarded. Operators can trust a known device after first pairing; with
  `AUTO_ACCEPT_KNOWN=true` that device can reconnect quickly after it presents
  the current pairing code. `AUTO_ACCEPT_ALL=true` (or the legacy
  `AUTO_ACCEPT=true`) is for closed-network test rigs only.
- **No anonymous open streaming.** There is no public listing of streams. The
  receiver only relays SDP/ICE between a matched `camera` and `viewer`
  bound to the same `sessionId`.
- **One-time pairing-code log.** The code is printed once on boot. All
  subsequent receiver logs print a redacted form (`A****Z`).
- **localStorage scope.** Only harmless preferences are persisted by the
  phone-side app: camera display name, last receiver URL, last pairing code,
  discoverable toggle, browser-generated `deviceId`, and selected
  camera/resolution/fps/bitrate. No tokens, no media data, no IP/MAC
  information.
- **Known-device metadata.** The receiver stores trusted-device metadata in a
  local JSON file (`receiver/data/known-devices.json` by default). Entries
  contain device ID, display name, first/last seen timestamps, trust/auto-accept
  flags, and last session ID only.
- **STUN-only.** The peer connection uses public STUN servers
  (`stun.l.google.com:19302`). There is intentionally no TURN relay — this
  enforces that both phone and receiver are on a network that can reach each
  other directly (LAN, mesh VPN, etc.). If they cannot, the stream simply
  does not connect.

## What this design does NOT protect

- **Wire encryption between phone and receiver dashboard signaling** when
  served over plain `ws://`. Operators should run the receiver behind a TLS
  reverse proxy (or use `wrangler dev`-style tunnels) if signaling traverses
  untrusted segments. Note that WebRTC media (SRTP/DTLS) is **always**
  encrypted in transit regardless of the signaling transport.
- **Replay protection on the pairing code beyond its lifetime.** A pairing
  code lasts as long as the receiver process; restart to rotate.
- **Browser-level limitations the app cannot work around.** Browsers cannot:
  - Read or set the device IP, MAC, or routing tables.
  - Configure DHCP / static IP on the phone. The Network page's `STATIC`
    fields are stored as local preferences for documentation/labeling only;
    they are not applied to the operating system.
  - Expose RTSP/ONVIF directly — see `knoxnet-vms-integration.md`.

## Operational guidance

1. Treat the pairing URL printed at boot as a **secret for the duration of
   the receiver session**. Anyone on the LAN with that URL and code can
   register a camera.
2. Restart the receiver to rotate the pairing code.
3. Run the receiver on a host that is reachable from the phone over LAN only
   (don't expose port 8787 over the public internet without TLS + auth in
   front of it).
4. Keep `AUTO_ACCEPT_ALL` / legacy `AUTO_ACCEPT` off in production. Use
   `AUTO_ACCEPT_KNOWN` only for devices you have explicitly trusted from the
   receiver dashboard.
