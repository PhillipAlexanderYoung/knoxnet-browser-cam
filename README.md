# knoxnet-browser-cam

> Turn an old phone into a **local WebRTC camera** for the
> [Knoxnet VMS](../Knoxnet-VMS) — no cloud, no third-party video services,
> just a mobile-first web app and a small Node.js receiver running on your
> LAN.

This repo contains:

- `web/` — React + Vite + TypeScript mobile web app (the camera UI).
- `receiver/` — Node.js + Express + WebSocket signaling server with a
  dashboard for accepting cameras and previewing their live streams.
- `bridge/` — standalone Node.js bridge that manages MediaMTX, allocates local
  RTSP paths, and relays accepted browser-camera WebRTC offers into MediaMTX
  via WHIP.
- `docs/` — security model + Knoxnet VMS integration plan.

## Reality constraints (read me first)

Browsers cannot:

- Expose RTSP / ONVIF directly. The phone remains a browser WebRTC publisher.
  The optional local `bridge/` service receives that WebRTC flow through
  MediaMTX WHIP and exposes RTSP on the desktop/NVR host.
- Read the device IP / MAC, or assign DHCP/static IP on the phone. The
  Network page surfaces this honestly.
- Run `getUserMedia` over plain `http://` on most phones — see the HTTPS
  caveat below.

## Architecture

```
┌────────────────────┐   WebSocket signaling   ┌────────────────────┐
│  Phone browser     │ ◀────────────────────▶ │  receiver/          │
│  (web/, the cam)   │                         │  pairing dashboard │
└─────────┬──────────┘                         └─────────┬──────────┘
          │ WebRTC media after operator accepts           │ BRIDGE_URL
          ▼                                               ▼
┌────────────────────┐      WHIP ingest       ┌────────────────────┐
│  MediaMTX          │ ◀───────────────────── │  bridge/            │
│  local restreamer  │                        │  path/API wrapper   │
└─────────┬──────────┘                        └────────────────────┘
          │
          ▼
rtsp://<host>:8554/<camera-slug>  →  Knoxnet VMS or any RTSP client
```

## Prerequisites

- **Node.js ≥ 20** and npm ≥ 10.
- A phone + a desktop on the **same Wi-Fi**.

## Setup

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm install
npm run dev
```

`npm run dev` starts two processes:

| Process  | Default URL                    | Purpose                          |
| -------- | ------------------------------ | -------------------------------- |
| receiver | http://localhost:8787          | Dashboard + signaling + /api     |
| web      | http://localhost:5173          | The phone-side UI (Vite)         |

To run the bridge as well:

```bash
npm run bridge
# or, in another shell:
BRIDGE_URL=http://localhost:8790 npm run receiver
```

`npm run dev:all` starts bridge + receiver + web together. Set
`BRIDGE_URL=http://localhost:8790` for the receiver when you want accepted
cameras to allocate RTSP paths and publish into MediaMTX.

For phone testing over a LAN IP, prefer:

```bash
npm run dev:https
```

This keeps the receiver local on `http://<lan-ip>:8787` / `ws://<lan-ip>:8787/ws`
and serves the Vite camera UI from `https://<lan-ip>:5173` with a local
self-signed certificate.

On boot, the receiver prints its **pairing code** and a **pairing URL**
(plus an ASCII QR). Example log:

```
[receiver] Knoxnet browser-cam receiver listening on http://0.0.0.0:8787
[receiver] WebSocket signaling at ws://192.168.1.42:8787/ws
[receiver] Pairing code (one-time print): X7K9PA
[receiver] Pairing URL: http://192.168.1.42:8787/?receiver=ws%3A%2F%2F192.168.1.42%3A8787%2Fws&pair=X7K9PA
[receiver] Open this URL on the phone (must be on the same LAN).
[receiver] Dashboard:    http://192.168.1.42:8787/
[receiver] From now on, the pairing code is redacted: X****A
```

## How to discover your LAN IP

```bash
ip addr show | awk '/inet 192\.|inet 10\.|inet 172\./{print $2}'
# or
ifconfig | grep -E 'inet (192|10|172)\.'
```

Use that address as `<lan-ip>` everywhere below.

## Pairing flow walkthrough

1. **On desktop:** open `http://<lan-ip>:8787/` — this is the receiver
   dashboard. You'll see the pairing code, a QR, and an empty "Cameras"
   list.
2. **On phone:** scan the QR (or browse to the printed pairing URL). The web
   app loads with `?receiver=…&pair=…` pre-filled.
3. **Phone:** allow camera permission. The Camera page shows the live local
   preview, the LIVE pill is hidden, status reads "Idle".
4. **Phone:** tap the large green ring (`TAP TO RECORD`). The phone WebSocket
   connects, the receiver registers the camera as `pending`, and the dashboard
   list updates live.
5. **Desktop dashboard:** click **Accept** on the new camera. Without a bridge,
   the phone streams to the dashboard viewer as before. With `BRIDGE_URL` set,
   the receiver allocates a MediaMTX path, relays the phone offer to WHIP, and
   shows the local RTSP URL in the camera metadata.
6. **RTSP clients / Knoxnet VMS:** add the displayed
   `rtsp://<host>:8554/<camera-slug>` URL. The phone still does not host RTSP;
   MediaMTX does.

## Standalone bridge mode

The bridge is intentionally separate from Knoxnet VMS:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm run bridge
curl http://localhost:8790/api/health
```

Important bridge environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Bridge REST API bind address. Keep local unless another trusted host must allocate paths. |
| `BRIDGE_HTTP_PORT` | `8790` | Bridge REST API port. |
| `BRIDGE_PUBLIC_HOST` | auto-detected LAN IP | Host placed in generated RTSP URLs. |
| `MEDIAMTX_BINARY` | `mediamtx` | MediaMTX executable to spawn. |
| `MEDIAMTX_MANAGE_PROCESS` | `true` | Set `false` to point at an already-running MediaMTX. |
| `MEDIAMTX_BIND_HOST` | `0.0.0.0` | MediaMTX RTSP/WebRTC bind host. |
| `MEDIAMTX_RTSP_PORT` | `8554` | RTSP egress port. |
| `MEDIAMTX_WEBRTC_PORT` | `8889` | MediaMTX WHIP/WHEP HTTP port. |
| `MEDIAMTX_API_PORT` | `9997` | MediaMTX local control API port. |

Current RTSP status: the bridge implements path allocation, MediaMTX config
generation/process management, receiver-side WHIP relay, and dashboard RTSP URL
display. A complete end-to-end RTSP stream requires a MediaMTX binary available
on `PATH` (or `MEDIAMTX_BINARY`) and a browser/MediaMTX codec/ICE combination
that succeeds with gathered SDP candidates. WHIP trickle-ICE PATCH support is
marked as follow-up in code.

## HTTPS caveat (important for phones)

Most phone browsers refuse `getUserMedia` on plain `http://<lan-ip>` (only
`http://localhost` is exempt). Pick one workaround:

### Option A — treat the LAN origin as secure (Chrome / Chromium dev)

1. On the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Add `http://<lan-ip>:5173` (or `:8787`, whichever you'll use) to the list.
3. **Relaunch** Chrome on the phone.

### Option B — run Vite with HTTPS

The root script starts the receiver and Vite HTTPS together:

```bash
# from repo root
npm run dev:https
```

It creates a local self-signed cert in `.cert/` using `openssl`, then runs the
Vite dev server with built-in HTTPS options. On the phone visit
`https://<lan-ip>:5173/?receiver=…&pair=…` and accept the certificate warning.
The receiver and WebRTC media path remain on your LAN; no cloud video service is
introduced.

### Option C — local TLS reverse proxy

Use something like `caddy` with `--internal` CAs, or `mkcert` + `nginx`, to
front both ports with a single HTTPS origin. Out of scope here; see Caddy's
[`tls internal`](https://caddyserver.com/docs/caddyfile/directives/tls) docs.

## npm scripts

| Script             | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `npm install`      | Installs all workspaces (web + receiver + bridge).                          |
| `npm run dev`      | Runs receiver and Vite dev server concurrently.                             |
| `npm run dev:all`  | Runs bridge, receiver, and Vite dev server concurrently.                    |
| `npm run bridge`   | Just the bridge (`tsx watch src/server.ts`).                                |
| `npm run dev:bridge` | Alias for the bridge dev server.                                          |
| `npm run dev:https`| Runs receiver and Vite over local HTTPS for phone camera testing.            |
| `npm run receiver` | Just the receiver (`tsx watch src/server.ts`).                              |
| `npm run web`      | Just the Vite dev server on `:5173`.                                        |
| `npm run build`    | `tsc --noEmit` + `vite build` for `web/`; `tsc -p` + static-copy for receiver. |
| `npm run typecheck`| Type-check both workspaces without emitting.                                |
| `npm start`        | Runs the compiled receiver from `receiver/dist`.                            |

## Receiver environment variables

| Var           | Default                       | Purpose                                                                                  |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`        | `8787`                        | HTTP + WS port                                                                           |
| `HOST`        | `0.0.0.0`                     | Bind address                                                                             |
| `PUBLIC_HOST` | auto-detected LAN IP          | Hostname printed into the pairing URL and `/api/info`                                    |
| `PAIRING_CODE`| random                        | Override the random code (e.g. for tests). Stored uppercased.                            |
| `AUTO_ACCEPT` | `false`                       | If `true`, cameras are auto-accepted on hello. **Closed-network test rigs only.**        |
| `RECEIVER_NAME` | `<hostname>-knoxnet-receiver` | Display name surfaced in `/api/info` and on the phone status row.                       |
| `BRIDGE_URL` | unset | Optional bridge API URL, e.g. `http://localhost:8790`, used to allocate RTSP paths and relay WHIP offers. |

## Production hosting note

The frontend can be served from a static public origin (eventually
`https://cam.knoxnetvms.com`) and still work LAN-only for media:

- The static frontend is just HTML+JS — it has no server-side logic.
- The phone's `?receiver=ws://<lan-ip>:8787/ws` parameter directs WebRTC
  signaling at the **local** receiver. Media never traverses the public host.
- Pairing codes and operator acceptance still gate every connection.

## Roadmap / TODOs

- Package the standalone `bridge/` service into Knoxnet VMS and manage its
  lifecycle/config there — see
  [`docs/knoxnet-vms-integration.md`](docs/knoxnet-vms-integration.md).
- Multi-camera per receiver (already supported by the data model; UI exists,
  needs polish under load).
- Optional TURN server for when phone/desktop aren't on the same subnet.

## Security

See [`docs/security.md`](docs/security.md).
