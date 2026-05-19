# Knoxnet VMS integration

> Status: **Bridge scaffold implemented.** This repo now has a standalone
> `bridge/` service that manages MediaMTX, allocates RTSP paths, and lets the
> receiver relay accepted phone-browser WebRTC offers into MediaMTX via WHIP.
> Knoxnet VMS (`/home/operator1/Documents/Knoxnet-VMS`) is not modified.

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

Current limitations:

- A complete RTSP stream requires a working `mediamtx` binary on `PATH` or
  `MEDIAMTX_BINARY`.
- The phone-side offer now waits briefly for ICE gathering so the WHIP POST has
  candidates in SDP. WHIP trickle-ICE `PATCH` support is still a TODO marker.
- The browser dashboard live viewer is bypassed for bridged cameras. Use the
  displayed RTSP URL in Knoxnet VMS, VLC, ffplay, or another RTSP client.

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
the allocated RTSP URL. Add that URL to Knoxnet VMS as a normal RTSP camera,
for example:

```text
rtsp://<bridge-host>:8554/<camera-slug>
```

## Knoxnet VMS packaging plan

Knoxnet VMS can package this without changing the browser camera:

1. Ship or locate a MediaMTX binary using the same pattern as the existing
   `/home/operator1/Documents/Knoxnet-VMS/mediamtx/` directory.
2. Start the bridge service as a local sidecar when browser-camera support is
   enabled.
3. Set receiver `BRIDGE_URL` to the bridge API URL.
4. Read `camera.bridge.rtspUrl` from the receiver API/dashboard payload and add
   it to the VMS camera model as an RTSP source.
5. Later, move path lifecycle, auth policy, recording policy, and firewall
   prompts into Knoxnet VMS while leaving `web/` as a browser-only camera.

Security/locality notes:

- The bridge REST API defaults to `127.0.0.1:8790` and should stay local unless
  a trusted host needs to allocate paths.
- MediaMTX defaults to `0.0.0.0` for RTSP/WebRTC so phones and RTSP clients on
  the LAN can reach it. Treat that LAN as trusted or restrict it with host
  firewall rules.
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
