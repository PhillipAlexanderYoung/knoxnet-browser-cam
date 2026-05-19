# Cloudflare Pages Hosting

This project can host the phone web app as a static Cloudflare Pages site at
`https://cam.knoxnetvms.com`.

The hosted phone app is static-only. It does not proxy video, signaling, pairing
codes, or receiver traffic through Cloudflare. The phone still connects directly
to the local receiver over the LAN with a URL like:

```text
https://cam.knoxnetvms.com/?receiver=wss://<local-ip>:8787/ws&pair=<pair-code>&autostart=1
```

WebRTC media and WebSocket signaling remain between the phone and the local
receiver/bridge. Cloudflare only serves the HTML, CSS, and JavaScript for the
phone UI.

## Local Build

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm install
npm run build:web
```

The Pages output directory is:

```text
web/dist
```

`web/public/_redirects` is copied into the Vite build so deep links and query
parameter URLs load the SPA. `web/public/_headers` adds basic browser security
headers while still allowing camera and microphone access from the Pages origin.

## One-Time Cloudflare Setup

Install dependencies and log in:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
npm install
npx wrangler@latest login
npx wrangler@latest whoami
```

Create the Pages project if it does not already exist:

```bash
npx wrangler@latest pages project create knoxnet-browser-cam --production-branch main
```

Deploy the current local build:

```bash
npm run build:web
npm run deploy:pages
```

After deploy, attach the custom domain:

```bash
npx wrangler@latest pages project domain add knoxnet-browser-cam cam.knoxnetvms.com
```

If Wrangler reports that the command is unavailable for your installed version,
use the Cloudflare dashboard:

1. Open Cloudflare Dashboard -> Workers & Pages -> `knoxnet-browser-cam`.
2. Go to Custom domains.
3. Add `cam.knoxnetvms.com`.
4. Follow the DNS prompt. If `knoxnetvms.com` is already on Cloudflare, Pages
   usually creates the correct DNS record automatically.
5. Wait for the certificate status to become active.

## Cloudflare Pages Git Integration

Instead of deploying from the CLI, connect the GitHub repo in Cloudflare:

1. Push this repository to GitHub.
2. Open Cloudflare Dashboard -> Workers & Pages -> Create application -> Pages
   -> Connect to Git.
3. Select the `knoxnet-browser-cam` repository.
4. Use these build settings:

```text
Framework preset: Vite
Build command: npm run build:web
Build output directory: web/dist
Root directory: /
Production branch: main
```

Then add the custom domain `cam.knoxnetvms.com` in the Pages project settings.

## Optional Pages CI Deploy

If you later want GitHub Actions to deploy Pages, add repository secrets named:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Use a token scoped to Cloudflare Pages edits for the account. Do not commit
tokens or account-specific secrets to the repository.
