# knoxnet-browser-cam

> Turn an old phone into a **local WebRTC camera** for the
> [Knoxnet VMS](../Knoxnet-VMS) — no cloud, no third-party video services,
> just a mobile-first web app and a small Node.js receiver running on your
> LAN.

This repo contains:

- `web/` — React + Vite + TypeScript mobile web app (the camera UI).
- `receiver/` — Node.js + Express + WebSocket signaling server with a
  dashboard for accepting cameras and previewing their live streams.
- `docs/` — security model + Knoxnet VMS integration plan.

## Reality constraints (read me first)

Browsers cannot:

- Expose RTSP / ONVIF directly. WebRTC is used over the LAN; the receiver
  terminates the stream. A future sidecar (see
  [`docs/knoxnet-vms-integration.md`](docs/knoxnet-vms-integration.md)) is
  needed to bridge into RTSP for the existing Python NVR.
- Read the device IP / MAC, or assign DHCP/static IP on the phone. The
  Network page surfaces this honestly.
- Run `getUserMedia` over plain `http://` on most phones — see the HTTPS
  caveat below.

## Architecture

```
┌────────────────────┐       WebRTC (DTLS/SRTP, LAN)        ┌────────────────────┐
│  Phone browser     │ ───────────── media ─────────────▶  │  Receiver dashboard │
│  (web/, the cam)   │                                      │  (viewer in browser)│
│                    │ ◀────── WebSocket signaling ──────  │                    │
│                    │       (ws://<host>:8787/ws)          │                    │
└────────┬───────────┘                                      └─────────┬──────────┘
         │                                                            │
         │       HTTP /api/info, /api/cameras, /api/pair-qr           │
         └──────────────────────── on the same Node host ─────────────┘
                                  (receiver/, Express)

                              ┌───────────────────────────┐
                              │  TODO(knoxnet-vms):       │
                              │  mediamtx WHIP → RTSP     │
                              │  → Knoxnet VMS NVR        │
                              └───────────────────────────┘
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
5. **Desktop dashboard:** click **Accept** on the new camera. The phone
   transitions `pending → accepted → streaming`, creates an SDP offer, and
   sends it over the signaling channel.
6. **Desktop dashboard:** click **View Live** — the dashboard opens a viewer
   `<video>` and answers the offer. Media flows phone → desktop.

## HTTPS caveat (important for phones)

Most phone browsers refuse `getUserMedia` on plain `http://<lan-ip>` (only
`http://localhost` is exempt). Pick one workaround:

### Option A — treat the LAN origin as secure (Chrome / Chromium dev)

1. On the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Add `http://<lan-ip>:5173` (or `:8787`, whichever you'll use) to the list.
3. **Relaunch** Chrome on the phone.

### Option B — run Vite with HTTPS

Vite can self-sign a cert:

```bash
# from repo root
npx --yes -p vite vite --https --host 0.0.0.0
# or modify web/vite.config.ts to set server.https = true and use a real cert
```

Then on the phone visit `https://<lan-ip>:5173/?receiver=…&pair=…` and accept
the self-signed cert prompt.

### Option C — local TLS reverse proxy

Use something like `caddy` with `--internal` CAs, or `mkcert` + `nginx`, to
front both ports with a single HTTPS origin. Out of scope here; see Caddy's
[`tls internal`](https://caddyserver.com/docs/caddyfile/directives/tls) docs.

## npm scripts

| Script             | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `npm install`      | Installs both workspaces (web + receiver).                                  |
| `npm run dev`      | Runs receiver and Vite dev server concurrently.                             |
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

## Production hosting note

The frontend can be served from a static public origin (eventually
`https://cam.knoxnetvms.com`) and still work LAN-only for media:

- The static frontend is just HTML+JS — it has no server-side logic.
- The phone's `?receiver=ws://<lan-ip>:8787/ws` parameter directs WebRTC
  signaling at the **local** receiver. Media never traverses the public host.
- Pairing codes and operator acceptance still gate every connection.

## Roadmap / TODOs

- Bridge the receiver into Knoxnet VMS via `mediamtx` WHIP ingest — see
  [`docs/knoxnet-vms-integration.md`](docs/knoxnet-vms-integration.md).
- Multi-camera per receiver (already supported by the data model; UI exists,
  needs polish under load).
- Optional TURN server for when phone/desktop aren't on the same subnet.

## Security

See [`docs/security.md`](docs/security.md).
