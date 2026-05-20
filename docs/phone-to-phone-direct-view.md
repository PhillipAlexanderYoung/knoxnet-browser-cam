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
- Rooms are single-viewer and expire after 2-5 minutes depending on Worker config.
- Direct peer-to-peer WebRTC can fail on some NAT/cellular networks. If it fails, use same Wi-Fi, WireGuard receiver mode, or local receiver mode.

## Browser Notes

- iPhone Safari and Android Chrome require HTTPS for camera access.
- Viewer autoplay can require a tap before audio/video starts.
- Desktop Chrome, Edge, and Safari can be useful for testing the viewer side.
