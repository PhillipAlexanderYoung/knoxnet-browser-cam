# Knoxnet VMS integration

> Status: **Receiver/bridge VMS API implemented.** This repo now exposes an
> authenticated receiver-side `/api/vms/v1/*` namespace that lets Knoxnet VMS
> manage pairing, trusted devices, RTSP credentials, credentialed RTSP URLs, and
> diagnostics without opening the standalone dashboard. Knoxnet VMS
> (`/home/operator1/Documents/Knoxnet-VMS`) is not modified here.

This document outlines the chosen bridge architecture and the remaining
packaging steps. Search the codebase for `TODO(knoxnet-vms):` markers for the
exact future integration points.

## Chosen architecture — `bridge/` + MediaMTX WHIP ingest

The bridge is separate on purpose: it can run today next to the receiver, and
Knoxnet VMS can later package or supervise the same service. The phone browser
does not and cannot host RTSP/ONVIF.

Flow:

```
phone browser ── WebSocket signaling ──▶ receiver/
phone browser ── WebRTC media ─────────▶ MediaMTX WHIP
receiver/ ────── bridge REST API ──────▶ bridge/ path + WHIP relay
MediaMTX ─────── RTSP egress ──────────▶ Knoxnet VMS NVR
```

What exists now:

- `bridge/` starts as an independent TypeScript workspace.
- The bridge writes a local MediaMTX config with `all_others: source: publisher`,
  starts `mediamtx` by default, and exposes:
  - `GET /api/health`
  - `GET /api/cameras`
  - `POST /api/cameras`
  - `POST /api/cameras/:id/whip`
- `receiver/` accepts `BRIDGE_URL=http://localhost:8790`. On camera accept, it
  allocates a path and shows `rtsp://<host>:8554/<camera-slug>` in the dashboard.
- When a bridged camera sends its WebRTC offer, the receiver relays that SDP to
  the bridge WHIP endpoint and sends MediaMTX's SDP answer back to the phone.
- `receiver/` exposes `/api/vms/v1/*` for Knoxnet VMS. All endpoints require
  `Authorization: Bearer <token>` or `X-Knoxnet-VMS-Token: <token>`.
- The receiver generates a local VMS integration token on first start unless
  `VMS_INTEGRATION_TOKEN` is set. The generated token is saved to
  `VMS_INTEGRATION_TOKEN_FILE` or `receiver/data/vms-integration-token` with
  restrictive permissions and is logged once.
- The phone browser never receives RTSP credentials. Credential-bearing URLs are
  only returned through the authenticated VMS API.

Current limitations:

- A complete RTSP stream requires a working `mediamtx` binary on `PATH` or
  `MEDIAMTX_BINARY`.
- The phone-side offer now waits briefly for ICE gathering so the WHIP POST has
  candidates in SDP. WHIP trickle-ICE `PATCH` support is still a TODO marker.
- The browser dashboard live viewer is bypassed for bridged cameras. Use the
  displayed RTSP URL in Knoxnet VMS, VLC, ffplay, or another RTSP client.

## Receiver VMS API

Base URL: `http(s)://<receiver-host>:8787/api/vms/v1`

Authentication:

```bash
curl -H "Authorization: Bearer $VMS_INTEGRATION_TOKEN" \
  http://127.0.0.1:8787/api/vms/v1/status
```

Endpoints:

- `GET /status` returns receiver health, bridge health, token source, and
  whether `VMS_MANAGED_MODE=true` is active.
- `GET /cameras` returns active receiver camera sessions, known devices, and
  bridge path records.
- `GET /events?since=<id>` returns receiver events after the optional event id.
- `POST /cameras/:sessionId/accept` accepts a pending phone session and
  allocates/reuses its stable bridge path.
- `POST /devices/:deviceId/trust` trusts a phone device id and enables
  auto-accept by default.
- `PATCH /devices/:deviceId` updates trusted-device metadata. Supported fields:
  `displayName`, `trusted`, `autoAccept`, and `settings` with `resolution`,
  `frameRate`, `bitrateKbps`, `audioEnabled`, and `preferredFacingMode`.
- `DELETE /devices/:deviceId` forgets the device, closes active sessions, and
  removes its bridge path.
- `GET /logs` returns receiver events and bridge MediaMTX diagnostics.
- `GET /rtsp-auth` returns RTSP auth status and credentials for VMS storage.
- `POST /rtsp-auth/rotate` rotates generated RTSP credentials and restarts
  managed MediaMTX with an updated config. If `RTSP_PASSWORD` is set in the
  environment, rotate by changing that secret and restarting.
- `GET /cameras/:deviceId/rtsp-url?credentials=1` returns the stable RTSP URL
  for a trusted phone device. Add `credentials=1` only from Knoxnet VMS.

Stable identity:

The canonical phone identity is the browser-generated `deviceId`, stored in
phone `localStorage`. Receiver reconnects from the same device replace the old
session and use bridge camera id `device-<deviceId>`, so the MediaMTX path and
RTSP URL stay stable across reconnects.

Managed mode:

Set `VMS_MANAGED_MODE=true` on the receiver when Knoxnet VMS owns the user
workflow. The standalone dashboard remains available, but it labels the receiver
as managed so it is not treated as the primary source of truth.

Phone settings contract:

VMS can push settings with `PATCH /devices/:deviceId`. If the phone is connected,
the receiver sends a `settings-update` signaling message and records the phone's
`settings-ack`. The phone applies display name, resolution, frame rate, bitrate,
audio, and facing-camera preference where browser APIs allow; local camera
choices remain user-friendly for standalone operation.

WHIP diagnostics:

When MediaMTX WHIP relay fails, the bridge stores and returns diagnostics with
the attempted WHIP endpoint, MediaMTX process/API state, HTTP status/body from
MediaMTX when available, SDP media/candidate summary, configured ports, and
recent MediaMTX stdout/stderr. These details are visible through
`GET /api/vms/v1/logs` and in bridge camera records.

Tradeoffs:

- **Pros:** keeps browser/WebRTC reality honest, uses a mature local restreamer,
  avoids adding Knoxnet VMS dependencies to this repo, and gives VMS a plain
  RTSP URL.
- **Cons:** adds a local process and a LAN media listener. Firewall and network
  placement matter.

## Standalone runbook

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm install
npm run bridge
```

In a second shell:

```bash
BRIDGE_URL=http://localhost:8790 npm run receiver
```

Then pair the phone as usual and accept the camera. The receiver dashboard shows
the allocated RTSP URL. RTSP auth is enabled by default on the bridge; the phone
browser does not need those credentials because it publishes WebRTC to the local
receiver/bridge. Add the credentialed URL from the bridge dashboard to Knoxnet
VMS as a normal RTSP camera, for example:

```text
rtsp://knoxnet:<password>@<bridge-host>:8554/<camera-slug>
```

Set `RTSP_USERNAME` / `RTSP_PASSWORD` before starting the bridge if Knoxnet VMS
should use a known credential. If `RTSP_PASSWORD` is omitted, the bridge
generates one on first start, stores it in `RTSP_PASSWORD_FILE` (default
`<BRIDGE_RUNTIME_DIR>/rtsp-password`), logs it once, and redacts it in dashboard
display. Rotate generated credentials by stopping the bridge, deleting that
password file, and starting the bridge again; or set a new `RTSP_PASSWORD` and
restart. `RTSP_AUTH_REQUIRED=false` exists for development only and shows a
warning because anyone on the reachable network could view the stream.

## Knoxnet VMS packaging plan

Knoxnet VMS can package this without changing the browser camera:

1. Ship or locate a MediaMTX binary using the same pattern as the existing
   `/home/operator1/Documents/Knoxnet-VMS/mediamtx/` directory.
2. Start the bridge service as a local sidecar when browser-camera support is
   enabled.
3. Set receiver `BRIDGE_URL` to the bridge API URL.
4. Read `camera.bridge.rtspUrl` from the receiver API/dashboard payload and add
   it to the VMS camera model as an RTSP source, alongside the configured
   bridge RTSP username/password or the credentialed URL copied from the bridge
   dashboard.
5. Later, move path lifecycle, auth policy, recording policy, and firewall
   prompts into Knoxnet VMS while leaving `web/` as a browser-only camera.

Security/locality notes:

- The bridge REST API defaults to `127.0.0.1:8790` and should stay local unless
  a trusted host needs to allocate paths.
- MediaMTX defaults to `0.0.0.0` for RTSP/WebRTC so phones and RTSP clients on
  the LAN can reach it. RTSP read auth is enabled by default, but you should
  still restrict exposure with host firewall rules.
- Never expose RTSP directly to the public internet. For remote NVR/client
  access, join the client to the private WireGuard network first.
- There is no cloud service and no third-party video relay in this design.

## Option 2 — `gstreamer` `webrtcbin` → `rtspserver`

Run a small GStreamer pipeline next to (or inside of) the receiver:

```
phone ── WebRTC ──▶ webrtcbin ── rtph264depay/decodebin ──▶ rtspserver
```

Tradeoffs:

- **Pros:** No extra binary if GStreamer is already deployed.
- **Cons:** Complex pipeline lifecycle, version-dependent plugin availability,
  and you must implement signaling glue. Recommended only if you already run
  GStreamer in production.

## Option 3 — `aiortc` Python bridge directly inside Knoxnet VMS

Add a Python module that joins this signaling WebSocket as a `viewer` (using
the same `?receiver=` + pairing code) and uses
[`aiortc`](https://github.com/aiortc/aiortc) to receive video frames, then
push them into existing Knoxnet VMS frame queues.

Tradeoffs:

- **Pros:** Tightest integration — frames arrive natively in Python, no extra
  process. Best path if you want VMS analytics to run on each frame
  immediately.
- **Cons:** `aiortc` is single-threaded asyncio; CPU-bound H.264 decode can
  bottleneck. Pure-Python; needs a system `libav` for hardware accel.

## Code seams

| File | What changes |
| --- | --- |
| `bridge/src/server.ts` | Standalone API, camera path allocation, and WHIP relay to MediaMTX. |
| `bridge/src/mediamtx.ts` | Generated MediaMTX config and optional process lifecycle. |
| `receiver/src/server.ts` | Reads `BRIDGE_URL`, allocates a bridge path on accept, and exposes bridge metadata in `/api/info`/camera records. |
| `receiver/src/signaling.ts` | For bridged cameras, relays the phone offer to MediaMTX WHIP and returns the answer instead of pretending the phone hosts RTSP. |
| `web/src/webrtc/peer.ts` | Waits briefly for ICE gathering before sending the SDP offer, improving WHIP compatibility without requiring immediate trickle support. |

## Why this isn't done in the MVP

The first bridge pass establishes the package boundary and MediaMTX handoff.
Production hardening still needs end-to-end codec testing, WHIP trickle-ICE
PATCH support if needed, process supervision, auth policy, and Knoxnet VMS UI
for managing the resulting RTSP sources.
