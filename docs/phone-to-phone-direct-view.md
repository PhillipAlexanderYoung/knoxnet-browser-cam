# Phone-to-Phone Direct View

Direct View lets one phone share its browser camera directly to one approved viewer phone without the local receiver or RTSP bridge.

## Flow

1. Phone A opens `https://cam.knoxnetvms.com`.
2. Tap **Direct View: Use this phone as camera**.
3. Tap **Share Camera** and allow camera/microphone permission.
4. Phone A creates a temporary Cloudflare Durable Object signaling room and shows a QR/link.
5. Phone B scans the QR or opens `/join/<roomToken>`.
6. Phone B sends a viewer request.
7. Phone A sees `Viewer wants to connect: [device/browser info]` and taps **Allow** or **Deny**.
8. Only after approval, the phones exchange WebRTC offer/answer/ICE through signaling.
9. Video flows directly from Phone A to Phone B over WebRTC.

## Limits

- Cloudflare relays signaling JSON only. It does not receive, relay, store, or process camera media.
- No account, login, app install, TURN server, or cloud video relay is used.
- The QR/link waiting phase expires after `ROOM_JOIN_TTL_SECONDS` (default 5 minutes). This is only the unjoined/unapproved setup window, not an active call limit.
- Once a viewer is approved, the room stays active while the approved camera/viewer peers heartbeat over signaling. There is no 5-minute active-session cutoff.
- Rooms are single-viewer by default. After approval, the room is locked to that viewer's browser session token; another phone gets a locked/already-connected message and cannot steal the viewer slot.
- If the approved camera or viewer drops unexpectedly, the room stays recoverable for `ACTIVE_ROOM_IDLE_TTL_SECONDS` (default 120 seconds). Returning with the same stored reconnect token rejoins without creating a new room and triggers WebRTC renegotiation.
- Manual **End Session** / **Disconnect** intentionally ends the room instead of reconnecting forever.
- Direct peer-to-peer WebRTC can fail on some NAT/cellular networks. If it fails, use same Wi-Fi, WireGuard receiver mode, or local receiver mode.

## Room Lifecycle

The camera UI should say **QR expires in** before a viewer is approved. After approval, the countdown is removed because active sessions are kept alive by peer heartbeats and reconnect grace, not by the original QR expiry.

Worker timing knobs:

- `ROOM_JOIN_TTL_SECONDS` defaults to `300` for the QR/link waiting phase.
- `ACTIVE_ROOM_IDLE_TTL_SECONDS` defaults to `120` for approved-peer reconnect grace after disconnect or lost heartbeat.
- `HEARTBEAT_INTERVAL_SECONDS` defaults to `20` for client signaling pings.
- `PEER_GRACE_SECONDS` defaults to `45` for missed-heartbeat detection before marking a peer as reconnecting.

## Browser Notes

- iPhone Safari and Android Chrome require HTTPS for camera access.
- Viewer autoplay can require a tap before audio/video starts.
- Desktop Chrome, Edge, and Safari can be useful for testing the viewer side.
