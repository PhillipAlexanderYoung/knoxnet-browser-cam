# Cloudflare Deployment

The static phone app stays on Cloudflare Pages at `https://cam.knoxnetvms.com`. The Direct View signaling Worker should be routed only for API/WebSocket paths:

`https://cam.knoxnetvms.com/api/direct/*`

Pages continues to serve the SPA, including `/join/<roomToken>` through `web/public/_redirects`.

## Install

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm install
```

## Build And Test

```bash
npm run typecheck
npm run build
npm run test:urls
npm run test:wss
npm --workspace @knoxnet-browser-cam/signaling-relay run test
```

## Local Worker Dev

```bash
cd /home/operator1/Documents/knoxnet-browser-cam/cloudflare/signaling-relay
npm install
npm run dev -- --env dev --port 8787
```

For a local Vite app using that Worker, start the web app with:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
VITE_DIRECT_SIGNAL_BASE=http://localhost:8787 npm --workspace web run dev
```

## Deploy Worker

```bash
cd /home/operator1/Documents/knoxnet-browser-cam/cloudflare/signaling-relay
npm run deploy
```

Configure the Worker route in Cloudflare:

```text
cam.knoxnetvms.com/api/direct/*
```

The Worker config is `cloudflare/signaling-relay/wrangler.jsonc`.

## Redeploy Pages

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm run build:web
npm run deploy:pages
```

## Alternative Signaling Host

If routing a Worker under the same Pages hostname is not desirable, deploy the Worker to `signal.knoxnetvms.com/*` and set the web app environment variable at build time:

```bash
VITE_DIRECT_SIGNAL_BASE=https://signal.knoxnetvms.com npm run build:web
```

In that case, add `https://cam.knoxnetvms.com` to `ALLOWED_ORIGINS` in the Worker config and route the Worker hostname in Cloudflare DNS/routes.
