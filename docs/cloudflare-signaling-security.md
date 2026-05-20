# Cloudflare Signaling Security

The Direct View Worker is a signaling relay only. Its Durable Object stores temporary room state and relays validated JSON messages between one camera and one approved viewer.

## Security Model

- Room tokens use 32 random bytes encoded as base64url, giving at least 128-bit entropy.
- There is no public room listing.
- The QR/share link contains the room token.
- The pre-approval QR/link waiting phase expires through Durable Object alarms.
- Active approved rooms do not end at the QR expiry. They stay alive while approved peers heartbeat, then enter a bounded reconnect grace period after a disconnect or missed heartbeat.
- Rooms lock after one viewer is approved. The approved viewer slot is tied to a browser client id plus reconnect token stored on that viewer device.
- A third device receives a locked/already-connected error and cannot replace the approved viewer.
- Reconnecting viewers are auto-restored only when they present the approved viewer reconnect token within the active room grace window.
- Viewer SDP/ICE is rejected until the camera approves the viewer.
- The Worker validates known message types, role permissions, room state, and maximum JSON size.
- Malformed, oversized, unknown, or out-of-state messages are rejected.
- Failed joins are counted per room and room creation is rate limited per client IP.
- Production origins are restricted with `ALLOWED_ORIGINS`; default production origin is `https://cam.knoxnetvms.com`.
- Production WebSockets must use WSS.

## Logging Rules

Do not log:

- Room tokens
- SDP bodies
- ICE candidates
- Full signaling payloads

Operational logs should stay coarse, such as status codes or aggregate error counts.

## Lifecycle Timers

- `ROOM_JOIN_TTL_SECONDS` (default `300`) controls only the unjoined/unapproved QR setup window.
- `ACTIVE_ROOM_IDLE_TTL_SECONDS` (default `120`) controls how long an approved room waits for a dropped camera/viewer to return.
- `HEARTBEAT_INTERVAL_SECONDS` and `PEER_GRACE_SECONDS` control signaling keepalive and missed-heartbeat detection.

Manual **End Session** / **Disconnect** sends an intentional leave message and ends the room; automatic reconnect is only for unexpected signaling/WebRTC loss.

## Media Path

Cloudflare never handles video/audio media. WebRTC media flows directly:

`Phone camera -> Viewer browser`

If peer-to-peer ICE fails, the app displays:

`Direct peer-to-peer connection failed. This can happen on some cellular networks. Try same Wi-Fi, WireGuard receiver mode, or local receiver mode.`

TURN/cloud relay is intentionally not configured.
