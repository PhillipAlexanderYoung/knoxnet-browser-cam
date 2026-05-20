# WireGuard Remote Camera Mode

Knoxnet Browser Cam can work when the phone is away from the LAN, but Cloudflare
Pages is not a video relay. `https://cam.knoxnetvms.com` only serves the static
phone app shell. The phone must still reach the receiver/bridge directly over a
private network. The recommended remote mode is WireGuard.

The receiver dashboard includes a guided **Remote Camera Setup (WireGuard)**
wizard. Use that first when possible: it checks for the local `wg` tool,
generates server/iPhone configs, shows a WireGuard import QR, and then creates a
separate Knoxnet VPN pairing QR. This document remains the fallback/manual
reference for environments where the dashboard wizard is not available.

```text
iPhone
  -> https://cam.knoxnetvms.com static app
  -> wss://10.44.0.1:8787/ws receiver over WireGuard
  -> local bridge http://10.44.0.1:8790
  -> stable RTSP URL rtsp://10.44.0.1:8554/<path>
  -> Knoxnet VMS
```

## Security Warnings

- A VPN exposes private services to VPN peers. Only add phones/users you trust.
- Keep WireGuard private keys and peer configs private. Anyone with a peer config
  can join the VPN until you remove or rotate that key.
- Restrict peers with `/32` addresses and tight firewall rules.
- Do not expose RTSP, MediaMTX, or the receiver directly to the public internet.
  Keep ports `8787`, `8790`, and `8554` reachable only from LAN/VPN unless you
  fully understand the risk.
- Rotate keys when a phone is lost, sold, or no longer trusted.
- Keep the receiver OS, Node.js, WireGuard, MediaMTX, and Knoxnet VMS updated.

## Recommended IP Plan

| Service | Address |
| --- | --- |
| WireGuard server / receiver | `10.44.0.1/24` |
| iPhone peer | `10.44.0.10/32` |
| Receiver dashboard | `https://10.44.0.1:8787/` |
| Receiver WSS | `wss://10.44.0.1:8787/ws` |
| Bridge API | `http://10.44.0.1:8790` |
| RTSP URL pattern | `rtsp://10.44.0.1:8554/<path>` |

Use a different VPN subnet if `10.44.0.0/24` conflicts with an existing network.

## Receiver Commands

Run these on the receiver/VMS machine. Commands marked `CUSTOMIZE` must be
changed for your environment.

```bash
sudo apt update
sudo apt install -y wireguard qrencode ufw
umask 077
wg genkey | tee server_private.key | wg pubkey > server_public.key
wg genkey | tee iphone_private.key | wg pubkey > iphone_public.key
```

Choose the public endpoint that the iPhone can reach from the internet:

```bash
# CUSTOMIZE: use your router public IP or DNS name.
export WG_ENDPOINT="vpn.example.com:51820"

# CUSTOMIZE: use the outbound internet interface on the receiver.
# Common values are eth0, enp3s0, ens18, or wlan0.
export WAN_IFACE="eth0"
```

Create `/etc/wireguard/wg0.conf`:

```bash
sudo install -m 600 /dev/null /etc/wireguard/wg0.conf
sudo tee /etc/wireguard/wg0.conf >/dev/null <<EOF
[Interface]
Address = 10.44.0.1/24
ListenPort = 51820
PrivateKey = $(sudo cat server_private.key)

# Optional NAT if VPN peers need broader LAN/internet access through this host.
# CUSTOMIZE WAN_IFACE before enabling these lines.
# PostUp = ufw route allow in on wg0 out on ${WAN_IFACE}
# PostUp = iptables -t nat -A POSTROUTING -o ${WAN_IFACE} -j MASQUERADE
# PostDown = iptables -t nat -D POSTROUTING -o ${WAN_IFACE} -j MASQUERADE

[Peer]
# iPhone
PublicKey = $(cat iphone_public.key)
AllowedIPs = 10.44.0.10/32
EOF
```

Enable forwarding only if you need routed LAN access beyond this receiver:

```bash
# Optional. Not required when the phone only needs 10.44.0.1 services.
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-wireguard-forward.conf
sudo sysctl --system
```

Open only the needed ports. `51820/udp` must be reachable from the internet.
The receiver, bridge, and RTSP ports should be reachable from `wg0` only:

```bash
sudo ufw allow 51820/udp comment 'WireGuard'
sudo ufw allow in on wg0 to 10.44.0.1 port 8787 proto tcp comment 'Knoxnet receiver dashboard/WSS'
sudo ufw allow in on wg0 to 10.44.0.1 port 8790 proto tcp comment 'Knoxnet bridge API'
sudo ufw allow in on wg0 to 10.44.0.1 port 8554 proto tcp comment 'MediaMTX RTSP over VPN'
sudo ufw status verbose
```

Start WireGuard:

```bash
sudo systemctl enable --now wg-quick@wg0
sudo wg show
```

Create the iPhone peer config:

```bash
cat > iphone-peer.conf <<EOF
[Interface]
PrivateKey = $(cat iphone_private.key)
Address = 10.44.0.10/32
DNS = 1.1.1.1

[Peer]
PublicKey = $(sudo cat server_public.key)
Endpoint = ${WG_ENDPOINT}
AllowedIPs = 10.44.0.1/32
PersistentKeepalive = 25
EOF
```

Show a QR for the official WireGuard iPhone app:

```bash
qrencode -t ansiutf8 < iphone-peer.conf
```

If `qrencode` is not installed or the terminal QR is hard to scan, transfer the
`iphone-peer.conf` file securely to the phone and import it in the WireGuard app.

## Receiver Startup

Start the local bridge + receiver with the Cloudflare-hosted phone app:

```bash
cd /home/operator1/Documents/knoxnet-browser-cam
PUBLIC_HOST=10.44.0.1 npm run local:cloud-phone
```

If you run only the receiver:

```bash
PUBLIC_HOST=10.44.0.1 npm run receiver:cloud-phone
```

For iPhone camera permission, the phone app is already HTTPS because it is loaded
from `cam.knoxnetvms.com`. If the receiver uses `wss://10.44.0.1:8787/ws` with a
self-signed cert, open `https://10.44.0.1:8787/` in Safari once while the VPN is
on and accept the local certificate warning before scanning the Knoxnet QR.

## iPhone Setup

1. Install the official WireGuard app from the App Store.
2. Tap Add a Tunnel -> Create from QR Code, then scan `iphone-peer.conf`.
3. Enable the VPN tunnel.
4. In Safari, test `https://10.44.0.1:8787/` and accept the local certificate if
   prompted.
5. On the receiver dashboard, scan the Knoxnet Browser Cam QR. It should open
   `https://cam.knoxnetvms.com` with `receiver=wss://10.44.0.1:8787/ws`.
6. Allow camera access, then accept/trust the camera on the receiver dashboard.
7. Add the stable RTSP URL shown by the dashboard to Knoxnet VMS.

## Troubleshooting

- Can the phone load `https://10.44.0.1:8787/` while the VPN is enabled? If not,
  check the WireGuard handshake with `sudo wg show`, router UDP forwarding to
  `51820`, and `ufw` rules.
- Does Safari trust the receiver certificate? If not, WSS can fail even though
  the hosted phone app loads.
- Does the QR show `https://cam.knoxnetvms.com` as the app URL and
  `wss://10.44.0.1:8787/ws` as the receiver URL?
- Are ports `8787/tcp` and `8554/tcp` reachable on `wg0`? Keep them closed on
  the public interface.
- Is RTSP only reachable over VPN/LAN? Do not publish `8554` to the internet.
- Is there no camera prompt? The phone app must be loaded over HTTPS. Use
  `https://cam.knoxnetvms.com`, not a plain HTTP phone app URL.
- Does bridge allocation fail? Confirm the bridge is running at
  `http://localhost:8790` and MediaMTX is available.
- Does Knoxnet VMS fail to connect to RTSP? Test from the VMS host with VLC or
  `ffprobe rtsp://10.44.0.1:8554/<path>` and make sure the phone is accepted and
  publishing.
