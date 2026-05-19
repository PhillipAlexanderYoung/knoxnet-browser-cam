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
npm run dev:all
```

`npm run dev:all` is the recommended phone-testing command. It starts the
RTSP bridge, the receiver with HTTPS/WSS signaling, and the HTTPS Vite phone app
together:

| Process  | Default URL                     | Purpose                          |
| -------- | ------------------------------- | -------------------------------- |
| bridge   | http://localhost:8790           | RTSP path API + bridge dashboard |
| receiver | https://<lan-ip>:8787           | Dashboard + WSS signaling + /api |
| web      | https://<lan-ip>:5173           | The phone-side UI (Vite HTTPS)   |

Open the receiver dashboard on the desktop:

```bash
https://<lan-ip>:8787/
```

The browser may warn about the local self-signed certificate. Accept it for the
desktop dashboard and for the phone app origin. On iPhone, also open
`https://<lan-ip>:8787/` in Safari once and accept the receiver certificate
before scanning the QR; otherwise Safari may allow the camera app on `:5173`
while still rejecting the `wss://<lan-ip>:8787/ws` signaling upgrade. This is
local dev TLS only.
Before scanning, you can confirm that the QR points at the phone app, not the
dashboard:

```bash
curl -k https://<lan-ip>:8787/api/info | jq .phonePairingUrl
```

You can smoke-test the receiver's local HTTPS/WSS upgrade from the desktop with:

```bash
npm run test:wss
```

The test starts a temporary WSS receiver on a high localhost port. Set
`WSS_SMOKE_PORT=18878` first if you want to force a specific port.

For a receiver + web app without the RTSP bridge:

```bash
npm run dev:https
```

For just the receiver with phone-friendly HTTPS/WSS URL defaults:

```bash
npm run receiver:dev-phone
```

For desktop-only HTTP testing:

```bash
npm run dev
```

On boot, the receiver prints its **pairing code** and a **pairing URL**
(plus an ASCII QR). Example log:

```
[receiver] Knoxnet browser-cam receiver listening on https://0.0.0.0:8787
[receiver] WebSocket signaling at wss://192.168.1.42:8787/ws
[receiver] Pairing code (one-time print): X7K9PA
[receiver] Phone app URL: https://192.168.1.42:5173
[receiver] Pairing URL: https://192.168.1.42:5173/?receiver=wss%3A%2F%2F192.168.1.42%3A8787%2Fws&pair=X7K9PA&autostart=1
[receiver] Scan this URL with the iPhone Camera app to open the phone app.
[receiver] Dashboard:    https://192.168.1.42:8787/
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

1. **On desktop:** run `npm run dev:all`, then open `https://<lan-ip>:8787/`.
   This is the receiver dashboard. It shows the phone pairing URL/QR separately
   from the dashboard URL.
2. **On iPhone:** scan the dashboard QR with the native Camera app. It opens
   `https://<lan-ip>:5173/?receiver=wss://<lan-ip>:8787/ws&pair=<code>&autostart=1`.
3. **Phone:** before or after scanning, open `https://<lan-ip>:8787/` in Safari
   and accept the local receiver certificate. Then open/return to the QR URL,
   accept the phone app certificate if prompted, and allow camera permission.
   The app fills the receiver URL and pairing code automatically and tries to
   start streaming. If iOS requires a user gesture, tap **Allow camera and start
   streaming**.
4. **Desktop dashboard:** click **Accept** on the pending camera. With
   `npm run dev:all`, the receiver already has
   `BRIDGE_URL=http://localhost:8790`, so it allocates a MediaMTX path and shows
   the RTSP URL after accept.
5. **RTSP clients / Knoxnet VMS:** add the displayed
   `rtsp://<host>:8554/<camera-slug>` URL. The phone still does not host RTSP;
   MediaMTX does.

## Standalone bridge mode

The bridge is intentionally separate from Knoxnet VMS:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm run bridge
curl http://localhost:8790/api/health
```

Open the standalone bridge dashboard at:

```text
http://<host>:8790/
```

The dashboard is a dense dark/green camera list for bridge-managed RTSP paths.
It shows each camera name, session/path, ingest status, RTSP URL, last-seen
time, copy/remove actions, and a detail preview panel. Browser previews are
honest: browsers cannot play RTSP directly, so the bridge only embeds a live
preview when MediaMTX WebRTC egress is configured and the path is publishing.
The generated MediaMTX config enables WebRTC on `MEDIAMTX_WEBRTC_PORT` and the
dashboard uses `http://<BRIDGE_PUBLIC_HOST>:8889/<camera-path>` as the preview
candidate. If that URL is unavailable, the dashboard shows a placeholder and
instructions to use VLC/Knoxnet VMS with the RTSP URL or enable MediaMTX
WebRTC/HLS egress.

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

### Option B — run receiver + Vite with HTTPS/WSS

The root script starts the receiver with WSS and Vite HTTPS together:

```bash
# from repo root
npm run dev:https
```

It creates a local self-signed cert in `.cert/` using `openssl`, then runs the
receiver and Vite dev server with that cert. On the phone, scan the dashboard QR
or visit `https://<lan-ip>:5173/?receiver=wss://<lan-ip>:8787/ws&pair=…`.
Accept the certificate warning. The receiver and WebRTC media path remain on
your LAN; no cloud video service is introduced.

### Option C — local TLS reverse proxy

Use something like `caddy` with `--internal` CAs, or `mkcert` + `nginx`, to
front both ports with a single HTTPS origin. Out of scope here; see Caddy's
[`tls internal`](https://caddyserver.com/docs/caddyfile/directives/tls) docs.

## npm scripts

| Script             | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `npm install`      | Installs all workspaces (web + receiver + bridge).                          |
| `npm run dev`      | Runs receiver and Vite dev server over HTTP for desktop-only testing.        |
| `npm run dev:all`  | Recommended phone flow: bridge + WSS receiver + HTTPS Vite app.             |
| `npm run dev:cert` | Creates/reuses `.cert/knoxnet-dev.*` for local HTTPS/WSS.                   |
| `npm run bridge`   | Just the bridge (`tsx watch src/server.ts`).                                |
| `npm run dev:bridge` | Alias for the bridge dev server.                                          |
| `npm run dev:https`| Runs WSS receiver and HTTPS Vite app without the RTSP bridge.                |
| `npm run receiver:dev-phone` | Just the WSS receiver with phone-app URL defaults for `https://<lan-ip>:5173`. |
| `npm run receiver` | Just the receiver (`tsx watch src/server.ts`); set `PHONE_APP_URL` if the phone app is not on the default derived origin. |
| `npm run web`      | Just the Vite dev server on `:5173`.                                        |
| `npm run build`    | `tsc --noEmit` + `vite build` for `web/`; `tsc -p` + static-copy for receiver. |
| `npm run test:urls`| Checks receiver URL builders so QR pairing stays on the phone app origin.   |
| `npm run test:wss` | Starts a temporary TLS receiver and verifies the localhost WSS upgrade accepts `hello`. |
| `npm run typecheck`| Type-check both workspaces without emitting.                                |
| `npm start`        | Runs the compiled receiver from `receiver/dist`.                            |

## Receiver environment variables

| Var           | Default                       | Purpose                                                                                  |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`        | `8787`                        | HTTP + WS port                                                                           |
| `HOST`        | `0.0.0.0`                     | Bind address                                                                             |
| `PUBLIC_HOST` | auto-detected LAN IP          | Hostname printed into the pairing URL and `/api/info`                                    |
| `PHONE_APP_URL` | derived from `PHONE_APP_SCHEME://PUBLIC_HOST:PHONE_APP_PORT` | Full phone web app origin, e.g. `https://cam.knoxnetvms.com` or `https://192.168.1.42:5173`. |
| `PHONE_APP_SCHEME` | `https` when `WSS=true`, else `http` | Scheme used for the derived phone app URL. |
| `PHONE_APP_PORT` | `5173` | Port used for the derived phone app URL. |
| `WSS` / `HTTPS` | `false` | If `true`, receiver serves HTTPS dashboard and WSS signaling using `TLS_KEY_PATH` / `TLS_CERT_PATH`. |
| `TLS_KEY_PATH` | `.cert/knoxnet-dev.key` | TLS key used when `WSS=true`. |
| `TLS_CERT_PATH` | `.cert/knoxnet-dev.crt` | TLS certificate used when `WSS=true`. |
| `PAIRING_CODE`| random                        | Override the random code (e.g. for tests). Stored uppercased.                            |
| `AUTO_ACCEPT` | `false`                       | If `true`, cameras are auto-accepted on hello. **Closed-network test rigs only.**        |
| `RECEIVER_NAME` | `<hostname>-knoxnet-receiver` | Display name surfaced in `/api/info` and on the phone status row.                       |
| `BRIDGE_URL` | unset | Optional bridge API URL, e.g. `http://localhost:8790`, used to allocate RTSP paths and relay WHIP offers. |

## Production hosting note

The frontend can be served from a static public origin (eventually
`https://cam.knoxnetvms.com`) and still work LAN-only for media:

- The static frontend is just HTML+JS — it has no server-side logic.
- The phone's `?receiver=ws://<lan-ip>:8787/ws` or
  `?receiver=wss://<lan-ip>:8787/ws` parameter directs WebRTC
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
