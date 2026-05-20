# Cloudflare Signaling Security

The Direct View Worker is a signaling relay only. Its Durable Object stores temporary room state and relays validated JSON messages between one camera and one approved viewer.

## Security Model

- Room tokens use 32 random bytes encoded as base64url, giving at least 128-bit entropy.
- There is no public room listing.
- The QR/share link contains the room token.
- Rooms expire through Durable Object alarms.
- Rooms lock after one viewer is approved.
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

## Media Path

Cloudflare never handles video/audio media. WebRTC media flows directly:

`Phone camera -> Viewer browser`

If peer-to-peer ICE fails, the app displays:

`Direct peer-to-peer connection failed. This can happen on some cellular networks. Try same Wi-Fi, WireGuard receiver mode, or local receiver mode.`

TURN/cloud relay is intentionally not configured.
