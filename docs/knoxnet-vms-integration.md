# Knoxnet VMS integration

> Status: **Future work for MVP.** Today, the receiver terminates the WebRTC
> media stream in the dashboard browser tab acting as a `viewer`. A second
> hop is needed to feed that stream into the existing Knoxnet VMS Python NVR
> (`/home/operator1/Documents/Knoxnet-VMS`).

This document outlines three concrete bridging options, sorted by recommended
effort. Search the codebase for `TODO(knoxnet-vms):` markers for the exact
integration seams.

## Option 1 — `mediamtx` WHIP ingest + RTSP egress *(recommended)*

The Knoxnet VMS repo already ships `mediamtx/` (a single-binary media server
that speaks WebRTC, WHIP/WHEP, RTSP, HLS, etc.).

Flow:

```
phone browser ── WebRTC (WHIP) ──▶ mediamtx ── RTSP ──▶ Knoxnet VMS NVR
```

Wiring steps:

1. Configure a WHIP path in `mediamtx.yml`, e.g. `phone1` with
   `source: publisher` and `sourceProtocol: webrtc`.
2. In this project's `receiver/`, replace (or run alongside) the dashboard
   viewer with a small WHIP relay that POSTs the phone-side SDP offer to
   mediamtx and forwards its answer back through our signaling WS. This keeps
   the existing pairing/operator-accept flow intact.
3. Knoxnet VMS reads the resulting `rtsp://localhost:8554/phone1` like any
   other camera.

Tradeoffs:

- **Pros:** Almost no new code; mediamtx is already in the VMS repo; battle-
  tested transcoding to H.264/AAC where needed.
- **Cons:** Adds a separate process to operate. Requires careful pairing-code
  enforcement on the WHIP endpoint (e.g. via a JWT shim in `receiver/`).

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
| `receiver/src/server.ts` | On `camera-update` when `status` transitions to `streaming`, hand off the sessionId + a one-time bridge token to whichever Option-1/2/3 bridge is configured. |
| `receiver/src/signaling.ts` | Allow a third role (`bridge`) that the chosen sidecar uses to play the `viewer` part (negotiates SDP/ICE in place of the dashboard tab). |
| `web/src/components/network/NetworkPage.tsx` | The "Port (RTSP)" advanced row exists today to surface this future hop to the operator. Update its sublabel once a bridge is configured. |

## Why this isn't done in the MVP

The phone-side capture and the operator-accepts-and-views loop are the
risky/novel parts. Restreaming via mediamtx is mostly configuration, so it is
deliberately deferred to keep MVP scope tight.
