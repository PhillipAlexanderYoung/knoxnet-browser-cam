// Receiver dashboard: connects to /ws as a "viewer", lists cameras and lets
// the operator accept/remove/view-live. WebRTC viewer logic lives here.

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const el = (id) => document.getElementById(id);

const state = {
  pairingCode: "",
  info: null,
  lobbyWs: null,
  viewer: null, // { sessionId, ws, pc, stats interval }
  cameras: new Map(),
};

function setStatus(label, mode) {
  const pill = el("status-pill");
  pill.className = `status status--${mode}`;
  el("status-text").textContent = label;
}

async function fetchInfo() {
  const res = await fetch("/api/info", { cache: "no-store" });
  if (!res.ok) throw new Error(`info ${res.status}`);
  return res.json();
}

function renderInfo(info) {
  state.info = info;
  state.pairingCode = info.pairingCode;
  const phonePairingUrl = info.phonePairingUrl ?? info.pairingUrl;
  const receiverDashboardUrl =
    info.dashboardUrl ?? `${info.tls ? "https" : "http"}://${info.publicHost}:${info.httpPort}/`;
  el("receiver-name").textContent = `${info.name} • ${receiverDashboardUrl}`;
  el("pairing-code").textContent = info.pairingCode;
  el("pairing-url").textContent = phonePairingUrl;
  const dashboardUrl = el("dashboard-url");
  if (dashboardUrl) {
    dashboardUrl.textContent = receiverDashboardUrl;
  }
  const qrUrl = el("pairing-qr-url");
  if (qrUrl) {
    qrUrl.textContent = phonePairingUrl;
    qrUrl.href = phonePairingUrl;
  }
  el("pairing-qr").src = `/api/pair-qr?ts=${Date.now()}`;
  const bridge = el("bridge-status");
  if (bridge) {
    bridge.textContent = info.bridgeUrl
      ? `Bridge connected: ${info.bridgeUrl}. RTSP paths appear after you accept a camera.`
      : "RTSP bridge disabled. Use npm run receiver:dev-phone for phone pairing only, or npm run dev:all for the RTSP bridge too.";
  }
}

el("copy-url").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      state.info?.phonePairingUrl ?? state.info?.pairingUrl ?? "",
    );
    el("copy-url").textContent = "Copied!";
    setTimeout(() => (el("copy-url").textContent = "Copy URL"), 1200);
  } catch (e) {
    console.warn("clipboard fail", e);
  }
});

function statusForCamera(cam) {
  return cam.status;
}

function bridgePhase(cam) {
  if (!cam.bridge) return "";
  if (cam.bridge.ingestStatus === "publishing") return "RTSP live";
  if (cam.bridge.ingestStatus === "error") return `RTSP error${cam.bridge.lastError ? ": " + cam.bridge.lastError : ""}`;
  return "RTSP allocated; waiting for WHIP media";
}

function bridgePreviewUrl(cam) {
  return cam.bridge?.preview?.webRtcUrl || cam.bridge?.previewUrls?.webRtc || "";
}

function renderCameras() {
  const list = Array.from(state.cameras.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const root = el("cameras");
  if (list.length === 0) {
    root.innerHTML = `<div class="empty">No cameras connected yet. Scan the QR with your phone.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const cam of list) {
    const div = document.createElement("div");
    div.className = "camera";
    const dotClass = `camera__dot camera__dot--${statusForCamera(cam)}`;
    const capBits = [];
    if (cam.capabilities?.audio) capBits.push("audio");
    if (cam.capabilities?.torch) capBits.push("torch");
    const rtsp = cam.bridge?.rtspUrl
      ? `<div class="camera__rtsp">
          <span>${cam.bridge.ingestStatus === "publishing" ? "RTSP live" : "RTSP not live yet"}</span>
          <code>${escapeHtml(cam.bridge.rtspUrl)}</code>
          <button class="btn btn--ghost" data-action="copy-rtsp" data-id="${cam.sessionId}">Copy</button>
        </div>`
      : "";
    const bridge = bridgePhase(cam);
    div.innerHTML = `
      <span class="${dotClass}"></span>
      <div>
        <div class="camera__name">${escapeHtml(cam.name)}</div>
        <div class="camera__meta">
          status: ${escapeHtml(cam.status)} • session: ${escapeHtml(cam.sessionId.slice(0, 6))}
          ${cam.remoteAddress ? "• " + escapeHtml(cam.remoteAddress) : ""}
          ${capBits.length ? "• " + capBits.join(", ") : ""}
          ${bridge ? "• bridge: " + escapeHtml(bridge) : ""}
        </div>
        ${rtsp}
      </div>
      <div class="camera__actions">
        ${cam.status === "pending"
          ? `<button class="btn btn--primary" data-action="accept" data-id="${cam.sessionId}">Accept</button>`
          : ""}
        ${(cam.status === "accepted" || cam.status === "streaming") && !cam.bridge
          ? `<button class="btn btn--primary" data-action="view" data-id="${cam.sessionId}">View Live</button>`
          : ""}
        ${cam.bridge?.ingestStatus === "publishing" && bridgePreviewUrl(cam)
          ? `<button class="btn btn--primary" data-action="bridge-preview" data-id="${cam.sessionId}">View Live</button>`
          : ""}
        <button class="btn btn--danger" data-action="remove" data-id="${cam.sessionId}">Remove</button>
      </div>
    `;
    root.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const action = t.getAttribute("data-action");
  const id = t.getAttribute("data-id");
  if (!action || !id) return;
  if (action === "accept") {
    await fetch(`/api/cameras/${encodeURIComponent(id)}/accept`, {
      method: "POST",
    });
  } else if (action === "remove") {
    if (!confirm("Remove this camera?")) return;
    await fetch(`/api/cameras/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (state.viewer?.sessionId === id) closeViewer();
  } else if (action === "view") {
    await openViewer(id);
  } else if (action === "bridge-preview") {
    const cam = state.cameras.get(id);
    const url = bridgePreviewUrl(cam);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  } else if (action === "copy-rtsp") {
    const cam = state.cameras.get(id);
    if (cam?.bridge?.rtspUrl) {
      await navigator.clipboard.writeText(cam.bridge.rtspUrl);
      t.textContent = "Copied!";
      setTimeout(() => (t.textContent = "Copy"), 1200);
    }
  }
});

function openLobbyWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  state.lobbyWs = ws;
  ws.onopen = () => {
    setStatus("Connected", "connected");
    ws.send(
      JSON.stringify({
        type: "hello",
        role: "viewer",
        pairingCode: state.pairingCode,
      }),
    );
  };
  ws.onclose = () => {
    setStatus("Disconnected", "error");
    setTimeout(openLobbyWs, 1500);
  };
  ws.onerror = () => setStatus("Connection error", "error");
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello-ack") {
      if (!msg.paired) {
        setStatus("Bad pairing code", "error");
      }
    } else if (msg.type === "camera-list") {
      state.cameras = new Map(msg.cameras.map((c) => [c.sessionId, c]));
      renderCameras();
    } else if (msg.type === "camera-update") {
      state.cameras.set(msg.camera.sessionId, msg.camera);
      renderCameras();
    } else if (msg.type === "error") {
      console.warn("server error", msg.message);
    }
  };
}

function closeViewer() {
  const v = state.viewer;
  if (!v) return;
  if (v.statsInterval) clearInterval(v.statsInterval);
  if (v.pc) {
    try {
      v.pc.close();
    } catch {}
  }
  if (v.ws && v.ws.readyState === WebSocket.OPEN) {
    try {
      v.ws.send(JSON.stringify({ type: "bye", sessionId: v.sessionId }));
    } catch {}
    try {
      v.ws.close();
    } catch {}
  }
  state.viewer = null;
  const vid = el("viewer-video");
  vid.srcObject = null;
  el("viewer-section").classList.add("hidden");
  el("viewer-meta").innerHTML = "";
}

el("close-viewer").addEventListener("click", closeViewer);

async function openViewer(sessionId) {
  closeViewer();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  const viewer = { sessionId, ws, pc, statsInterval: null };
  state.viewer = viewer;

  el("viewer-section").classList.remove("hidden");
  el("viewer-meta").innerHTML = `<div class="viewer__meta-row"><span>session</span><span>${escapeHtml(sessionId)}</span></div><div class="viewer__meta-row"><span>state</span><span id="pc-state">…</span></div>`;

  pc.ontrack = (ev) => {
    const vid = el("viewer-video");
    if (vid.srcObject !== ev.streams[0]) {
      vid.srcObject = ev.streams[0];
    }
  };
  pc.onicecandidate = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "ice",
        sessionId,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      }),
    );
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const node = document.getElementById("pc-state");
    if (node) node.textContent = s;
  };

  // We don't add tracks; we only receive video (and optional audio).
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        role: "viewer",
        pairingCode: state.pairingCode,
        sessionId,
      }),
    );
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello-ack" && msg.paired) {
      // Wait for the camera's offer.
    } else if (msg.type === "offer" && msg.sessionId === sessionId) {
      try {
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(
          JSON.stringify({
            type: "answer",
            sessionId,
            sdp: { type: answer.type, sdp: answer.sdp },
          }),
        );
      } catch (err) {
        console.error("answer failed", err);
      }
    } else if (msg.type === "ice" && msg.sessionId === sessionId) {
      if (msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          console.warn("addIceCandidate", err);
        }
      }
    } else if (msg.type === "bye" && msg.sessionId === sessionId) {
      closeViewer();
    } else if (msg.type === "camera-update") {
      state.cameras.set(msg.camera.sessionId, msg.camera);
      renderCameras();
    }
  };

  ws.onclose = () => {
    if (state.viewer === viewer) closeViewer();
  };

  viewer.statsInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let kbps = 0;
      let bytesPrev = viewer.lastBytes || 0;
      let lastT = viewer.lastT || 0;
      let total = 0;
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && (s.kind === "video" || s.mediaType === "video")) {
          if (typeof s.bytesReceived === "number") total += s.bytesReceived;
        }
      });
      const now = performance.now();
      if (lastT > 0) {
        const dt = (now - lastT) / 1000;
        if (dt > 0) kbps = Math.round(((total - bytesPrev) * 8) / 1000 / dt);
      }
      viewer.lastBytes = total;
      viewer.lastT = now;
      const meta = document.getElementById("viewer-meta");
      if (meta) {
        meta.innerHTML = `
          <div class="viewer__meta-row"><span>session</span><span>${escapeHtml(sessionId)}</span></div>
          <div class="viewer__meta-row"><span>pc state</span><span>${pc.connectionState}</span></div>
          <div class="viewer__meta-row"><span>bitrate</span><span>${kbps} kbps</span></div>
        `;
      }
    } catch {}
  }, 1000);
}

(async () => {
  try {
    setStatus("Loading…", "");
    const info = await fetchInfo();
    renderInfo(info);
  } catch (e) {
    console.error(e);
    setStatus("Server error", "error");
    return;
  }
  openLobbyWs();
})();
