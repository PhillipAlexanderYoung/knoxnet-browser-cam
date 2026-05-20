# knoxnet-browser-cam

> Turn an old phone into a **local WebRTC camera** for the
> [Knoxnet VMS](../Knoxnet-VMS) — no cloud, no third-party video services,
> just a mobile-first web app and a small Node.js receiver running on your
> LAN.

Free open source software under the Apache License 2.0. The phone web app can
be hosted publicly as a static site, while signaling, WebRTC media, RTSP, and
pairing stay on your local network.

This repo contains:

- `web/` — React + Vite + TypeScript mobile web app (the camera UI).
- `receiver/` — Node.js + Express + WebSocket signaling server with a
  dashboard for accepting cameras and previewing their live streams.
- `bridge/` — standalone Node.js bridge that manages MediaMTX, allocates local
  RTSP paths, and relays accepted browser-camera WebRTC offers into MediaMTX
  via WHIP.
- `docs/` — security model + Knoxnet VMS integration plan.

Publishing guides:

- [Cloudflare Pages hosting](docs/cloudflare-pages.md) for
  `https://cam.knoxnetvms.com`.
- [WireGuard remote camera mode](docs/wireguard-remote-camera.md) for phones
  away from the receiver LAN.
- [GitHub publishing and releases](docs/github-release.md).
- [Knoxnet VMS sidecar/plugin model](docs/knoxnet-vms-plugin.md).

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
- A phone + a desktop on the **same Wi-Fi**, or a WireGuard VPN where the phone
  can reach the receiver.

## Setup

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm install
npm run local:cloud-phone
```

For normal local use, start the bridge + receiver and let the QR open the
Cloudflare-hosted phone app:

```bash
npm run local:cloud-phone
```

That QR opens `https://cam.knoxnetvms.com`, but embeds a local receiver URL such
as `wss://<lan-or-vpn-ip>:8787/ws`. Cloudflare serves only the phone app shell;
signaling, video, bridge, and RTSP stay direct to your receiver/bridge over LAN
or WireGuard. Because the phone app is HTTPS, use WSS for the receiver.

For active development of the phone app, use `npm run dev:all`. It starts the
RTSP bridge, the receiver with HTTPS/WSS signaling, and the HTTPS Vite phone app
together:

| Process  | Default URL                     | Purpose                          |
| -------- | ------------------------------- | -------------------------------- |
| bridge   | http://localhost:8790           | RTSP path API + bridge dashboard |
| receiver | https://<lan-ip>:8787           | Dashboard + WSS signaling + /api |
| web      | https://<lan-ip>:5173           | The phone-side UI (Vite HTTPS)   |

On this development machine, MediaMTX is available at:

```bash
MEDIAMTX_BINARY="/home/operator1/Documents/Knoxnet-VMS/mediamtx/mediamtx" npm run dev:all
```

The bridge also auto-detects that path. Run `npm run doctor` if RTSP does not
come up; an RTSP URL is playable only after the bridge ingest status says
`publishing`.

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

For just the receiver with the Cloudflare-hosted phone app:

```bash
npm run receiver:cloud-phone
```

For just the receiver with local Vite phone-app URL defaults:

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
[receiver] Phone app URL: https://cam.knoxnetvms.com
[receiver] Pairing URL: https://cam.knoxnetvms.com/?receiver=wss%3A%2F%2F192.168.1.42%3A8787%2Fws&pair=X7K9PA&autostart=1
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

1. **On desktop:** run `npm run local:cloud-phone` for normal use, or
   `npm run dev:all` when editing `web/`. Then open the receiver dashboard.
   The dashboard shows the phone app origin, the embedded receiver WSS URL, and
   the dashboard URL separately.
2. **On iPhone:** scan the dashboard QR with the native Camera app. It opens
   `https://cam.knoxnetvms.com/?receiver=wss://<lan-ip>:8787/ws&pair=<code>&autostart=1`
   for normal use, or `https://<lan-ip>:5173/...` in dev mode.
3. **Phone:** if the receiver uses a self-signed local TLS certificate, open
   `https://<lan-ip>:8787/` in Safari once and accept it before scanning. Then
   open/return to the QR URL and allow camera permission. The app fills the
   receiver URL and pairing code automatically and tries to start streaming. If
   permission was blocked, allow camera access in the browser prompt or Settings,
   then tap **Retry camera access**.
4. **Desktop dashboard:** click **Accept** on the pending camera. With
   `npm run dev:all`, the receiver already has
   `BRIDGE_URL=http://localhost:8790`, so it allocates a MediaMTX path and shows
   the RTSP URL after accept.
5. **Trust for fast reconnect:** after the first successful pair, click
   **Trust this device** on the receiver dashboard. The phone keeps a harmless
   browser-generated `deviceId` in localStorage; the receiver stores only that
   ID, display name, timestamps, trust/auto-accept flags, and last session in
   `receiver/data/known-devices.json` by default. No secrets or media are stored.
6. **RTSP clients / Knoxnet VMS:** trust the device, wait until the dashboard
   shows bridge ingest `publishing`, then add the displayed **Stable RTSP URL /
   NVR URL** (`rtsp://<host>:8554/<camera-slug>`) to Knoxnet VMS, VLC, or your
   NVR. The phone still does not host RTSP; MediaMTX does.

On reconnect, trusted known devices still need the current pairing code but can
move from `hello` to accepted/streaming without another manual dashboard click
when `AUTO_ACCEPT_KNOWN=true`. The phone keeps a separate desired-streaming
state after Start is tapped, automatically retries dropped WebSocket/WebRTC/WHIP
connections with capped backoff, and keeps trying until Stop is tapped.

## Long-running reliability and RTSP durability

For VMS/NVR recording, use the dashboard's **Stable RTSP URL / NVR URL** after
the phone is trusted. The bridge keys that RTSP path by the browser-generated
`deviceId` when available instead of the transient receiver session id, so phone
reconnects republish into the same MediaMTX path whenever possible.

During a phone Wi-Fi drop, app background, receiver restart, or bridge outage,
the phone keeps retrying while Start remains active. The dashboard may show the
RTSP path as `recovering` or `offline`; clients may see temporary stream loss,
but they should retry the same URL. The bridge retains offline paths for
`RTSP_PATH_GRACE_MS` (default 10 minutes) before cleanup so VLC/Knoxnet VMS/NVR
configs do not churn during normal reconnects.

For best long-running results:

- Keep the phone on wired power and on the same Wi-Fi as the receiver/bridge.
- Keep the screen awake. Wake Lock is requested automatically where browsers
  support it, but iOS may still suspend background tabs or drop locks.
- Run the bridge/receiver under a supervisor such as systemd or PM2 for
  production use.
- Watch thermal throttling on older phones; avoid direct sun and remove thick
  cases if the phone gets hot.
- Older phones are usually happiest at `720p`, `15fps`, and `2 Mbps`.
- MediaMTX is used as a publisher-backed RTSP path here. No placeholder
  always-on video source is currently configured, so RTSP clients may disconnect
  during upstream loss; configure clients/NVRs to retry the same stable URL.

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
| `RTSP_PATH_GRACE_MS` | `600000` | How long the bridge retains an offline stable RTSP path before cleanup. |

Current RTSP status: the bridge implements stable path allocation,
MediaMTX config generation/process management, receiver-side WHIP relay, and
dashboard Stable RTSP URL / NVR URL display. The receiver marks cameras
`negotiating` while the WHIP offer is being posted to MediaMTX and only marks
the bridge `publishing` after MediaMTX returns an answer. A complete end-to-end
RTSP stream requires a MediaMTX binary available on `PATH`, in
`/home/operator1/Documents/Knoxnet-VMS/mediamtx/mediamtx`, or via
`MEDIAMTX_BINARY`. WHIP trickle-ICE PATCH support is marked as follow-up in code.

## Cloudflare-hosted phone app and remote mode

`https://cam.knoxnetvms.com` is the default phone app URL for normal receiver
pairing. This is useful because users do not need to run or trust a local Vite
HTTPS app just to open the camera UI on an iPhone.

What it does:

- Serves the static phone app shell over a trusted public HTTPS origin.
- Lets the receiver QR embed a LAN or VPN WSS URL such as
  `wss://10.44.0.1:8787/ws`.
- Keeps pairing, signaling, WebRTC media, bridge ingest, and RTSP local/direct.

What it does not do:

- It does not relay video or WebSocket signaling through Cloudflare.
- It does not make a receiver behind NAT reachable by itself.
- It does not make RTSP safe to expose to the public internet.

For phones away from the LAN, use the receiver dashboard's **Remote Camera Setup
(WireGuard)** wizard first: it generates configs, copy-paste receiver commands,
the WireGuard peer QR, and a separate Knoxnet VPN pairing QR. The phone then
joins the private VPN and reaches the receiver at a VPN IP, for example
`wss://10.44.0.1:8787/ws`. See
[`docs/wireguard-remote-camera.md`](docs/wireguard-remote-camera.md) for manual
fallback instructions.

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
| `npm run dev`      | Runs receiver and Vite dev server over HTTP for desktop-only development.    |
| `npm run dev:all`  | Active phone-app development: bridge + WSS receiver + HTTPS Vite app.        |
| `npm run dev:cert` | Creates/reuses `.cert/knoxnet-dev.*` for local HTTPS/WSS.                   |
| `npm run bridge`   | Just the bridge (`tsx watch src/server.ts`).                                |
| `npm run dev:bridge` | Alias for the bridge dev server.                                          |
| `npm run doctor`   | Prints MediaMTX detection and RTSP health check commands.                  |
| `npm run dev:https`| Runs WSS receiver and HTTPS Vite app without the RTSP bridge.                |
| `npm run receiver:dev-phone` | Just the WSS receiver with local Vite phone-app URL defaults for `https://<lan-ip>:5173`. |
| `npm run receiver:cloud-phone` | Just the WSS receiver with QR URLs opening `https://cam.knoxnetvms.com`. |
| `npm run local:cloud-phone` | Bridge + WSS receiver for local/VPN use with the Cloudflare-hosted phone app. |
| `npm run receiver` | Just the receiver (`tsx watch src/server.ts`); normal QR URLs open `https://cam.knoxnetvms.com` unless overridden. |
| `npm run web`      | Just the Vite dev server on `:5173`.                                        |
| `npm run build:web`| Builds only the static phone web app into `web/dist`.                       |
| `npm run deploy:pages` | Deploys `web/dist` to Cloudflare Pages project `knoxnet-browser-cam` without rebuilding. |
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
| `PHONE_APP_URL` | `https://cam.knoxnetvms.com` | Full phone web app origin. Set to `https://<lan-ip>:5173` for local Vite or another hosted app. |
| `PHONE_APP_ENV` | unset | Set `dev` to derive a local Vite app URL from `PHONE_APP_SCHEME://PUBLIC_HOST:PHONE_APP_PORT`. |
| `PHONE_APP_SCHEME` | `https` when `WSS=true`, else `http` in dev mode | Scheme used for the derived local phone app URL. |
| `PHONE_APP_PORT` | `5173` in dev mode | Port used for the derived local phone app URL. |
| `WSS` / `HTTPS` | `false` | If `true`, receiver serves HTTPS dashboard and WSS signaling using `TLS_KEY_PATH` / `TLS_CERT_PATH`. |
| `TLS_KEY_PATH` | `.cert/knoxnet-dev.key` | TLS key used when `WSS=true`. |
| `TLS_CERT_PATH` | `.cert/knoxnet-dev.crt` | TLS certificate used when `WSS=true`. |
| `PAIRING_CODE`| random                        | Override the random code (e.g. for tests). Stored uppercased.                            |
| `AUTO_ACCEPT_KNOWN` | `true` | Auto-accept dashboard-trusted known devices after they present the current pairing code. |
| `AUTO_ACCEPT_ALL` | `false` | If `true`, any camera with the current pairing code is auto-accepted. **Closed-network test rigs only.** |
| `AUTO_ACCEPT` | `false` | Legacy alias for `AUTO_ACCEPT_ALL=true`. Prefer the explicit flags above. |
| `STALE_CAMERA_TTL_MS` | `300000` | Pending/disconnected sessions older than this are removed; known-device records are kept. |
| `RECEIVER_DATA_DIR` | `receiver/data` | Local metadata directory for known devices. Gitignored. |
| `KNOWN_DEVICES_PATH` | `RECEIVER_DATA_DIR/known-devices.json` | Override the known-device JSON file path. |
| `RECEIVER_NAME` | `<hostname>-knoxnet-receiver` | Display name surfaced in `/api/info` and on the phone status row.                       |
| `BRIDGE_URL` | unset | Optional bridge API URL, e.g. `http://localhost:8790`, used to allocate RTSP paths and relay WHIP offers. |

## Production hosting note

The frontend is served from the static public origin
`https://cam.knoxnetvms.com` by default and still works LAN/VPN-only for media:

- The static frontend is just HTML+JS — it has no server-side logic.
- The phone's `?receiver=wss://<local-or-vpn-ip>:8787/ws&pair=<code>`
  parameter directs WebRTC signaling at the receiver. Media never traverses the
  Cloudflare Pages host.
- Pairing codes and operator acceptance still gate every connection.
- Remote cameras need a reachable private path such as WireGuard. Cloudflare
  Pages alone does not make a receiver reachable from the internet.
- Cloudflare Pages deployment commands and custom-domain setup are documented
  in [`docs/cloudflare-pages.md`](docs/cloudflare-pages.md).
- GitHub repo/release commands are documented in
  [`docs/github-release.md`](docs/github-release.md).

## Roadmap / TODOs

- Package the standalone `bridge/` service into Knoxnet VMS and manage its
  lifecycle/config there — see
  [`docs/knoxnet-vms-integration.md`](docs/knoxnet-vms-integration.md).
- Multi-camera per receiver (already supported by the data model; UI exists,
  needs polish under load).
- Optional TURN server for when phone/desktop aren't on the same subnet.

## Security

See [`docs/security.md`](docs/security.md).
