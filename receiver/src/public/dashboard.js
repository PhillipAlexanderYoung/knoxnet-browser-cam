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
  knownDevices: new Map(),
  events: [],
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

async function fetchKnownDevices() {
  const res = await fetch("/api/known-devices", { cache: "no-store" });
  if (!res.ok) throw new Error(`known-devices ${res.status}`);
  return res.json();
}

async function fetchEvents() {
  const res = await fetch("/api/events", { cache: "no-store" });
  if (!res.ok) throw new Error(`events ${res.status}`);
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
  const mode = el("accept-mode");
  if (mode) {
    mode.textContent = `Auto-accept known: ${info.autoAcceptKnown ? "on" : "off"} • Auto-accept all: ${info.autoAcceptAll ? "on" : "off"} • stale TTL: ${Math.round((info.staleCameraTtlMs ?? 0) / 1000)}s`;
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
  renderCounts(list);
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
    const known = cam.deviceId ? state.knownDevices.get(cam.deviceId) : null;
    const staleText =
      cam.status === "disconnected" && cam.disconnectReason
        ? ` • reason: ${escapeHtml(cam.disconnectReason)}`
        : "";
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
          ${cam.deviceId ? "• device: " + escapeHtml(cam.deviceId.slice(0, 8)) : ""}
          ${known?.trusted || cam.trusted ? "• trusted" : ""}
          ${cam.reconnectCount ? "• reconnects: " + escapeHtml(cam.reconnectCount) : ""}
          ${cam.remoteAddress ? "• " + escapeHtml(cam.remoteAddress) : ""}
          ${capBits.length ? "• " + capBits.join(", ") : ""}
          ${bridge ? "• bridge: " + escapeHtml(bridge) : ""}
          ${staleText}
        </div>
        ${rtsp}
      </div>
      <div class="camera__actions">
        ${cam.status === "pending"
          ? `<button class="btn btn--primary" data-action="accept" data-id="${cam.sessionId}">Accept</button>`
          : ""}
        ${cam.deviceId && !(known?.trusted || cam.trusted)
          ? `<button class="btn btn--ghost" data-action="trust-camera" data-id="${cam.sessionId}">Trust this device</button>`
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

function renderCounts(list = Array.from(state.cameras.values())) {
  const counts = { active: 0, pending: 0, disconnected: 0 };
  for (const cam of list) {
    if (cam.status === "pending") counts.pending += 1;
    else if (cam.status === "disconnected") counts.disconnected += 1;
    else counts.active += 1;
  }
  const root = el("camera-counts");
  if (!root) return;
  root.innerHTML = `
    <span>active ${counts.active}</span>
    <span>pending ${counts.pending}</span>
    <span>disconnected ${counts.disconnected}</span>
  `;
}

function renderKnownDevices() {
  const list = Array.from(state.knownDevices.values()).sort((a, b) =>
    b.lastSeen.localeCompare(a.lastSeen),
  );
  const root = el("known-devices");
  if (!root) return;
  if (list.length === 0) {
    root.innerHTML = `<div class="empty">Trusted phones will appear after first pairing.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const device of list) {
    const row = document.createElement("div");
    row.className = "known-device";
    row.innerHTML = `
      <div>
        <div class="known-device__name">${escapeHtml(device.name)}</div>
        <div class="known-device__meta">
          ${escapeHtml(device.deviceId.slice(0, 12))} • last seen ${formatTime(device.lastSeen)}
          ${device.lastSessionId ? "• session " + escapeHtml(device.lastSessionId.slice(0, 6)) : ""}
        </div>
      </div>
      <div class="known-device__actions">
        <label class="toggle-row">
          <input type="checkbox" data-action="toggle-auto-accept" data-id="${device.deviceId}" ${device.autoAccept ? "checked" : ""} />
          <span>Auto-accept</span>
        </label>
        ${device.trusted
          ? `<button class="btn btn--danger" data-action="forget-device" data-id="${device.deviceId}">Forget</button>`
          : `<button class="btn btn--primary" data-action="trust-device" data-id="${device.deviceId}">Trust</button>`}
      </div>
    `;
    root.appendChild(row);
  }
}

function renderEvents() {
  const root = el("events");
  if (!root) return;
  const list = state.events.slice(-200).reverse();
  if (list.length === 0) {
    root.innerHTML = `<div class="empty">No connection events yet.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const event of list) {
    const row = document.createElement("div");
    row.className = "event";
    row.innerHTML = `
      <div class="event__type">${escapeHtml(event.type)}</div>
      <div class="event__body">
        <div>${escapeHtml(event.message)}${event.reason ? " - " + escapeHtml(event.reason) : ""}</div>
        <div class="event__meta">
          ${formatTime(event.ts)}
          ${event.name ? "• " + escapeHtml(event.name) : ""}
          ${event.sessionId ? "• session " + escapeHtml(event.sessionId.slice(0, 6)) : ""}
          ${event.deviceId ? "• device " + escapeHtml(event.deviceId.slice(0, 8)) : ""}
        </div>
      </div>
    `;
    root.appendChild(row);
  }
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

async function refreshKnownDevices() {
  const known = await fetchKnownDevices();
  state.knownDevices = new Map((known.devices ?? []).map((d) => [d.deviceId, d]));
  renderKnownDevices();
  renderCameras();
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
  } else if (action === "trust-camera") {
    const cam = state.cameras.get(id);
    if (!cam?.deviceId) return;
    await fetch(`/api/known-devices/${encodeURIComponent(cam.deviceId)}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoAccept: true }),
    });
    await refreshKnownDevices();
  } else if (action === "trust-device") {
    await fetch(`/api/known-devices/${encodeURIComponent(id)}/trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoAccept: true }),
    });
    await refreshKnownDevices();
  } else if (action === "forget-device") {
    if (!confirm("Forget this trusted device? It will need manual accept next time.")) return;
    await fetch(`/api/known-devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshKnownDevices();
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

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  const action = t.getAttribute("data-action");
  const id = t.getAttribute("data-id");
  if (action !== "toggle-auto-accept" || !id) return;
  await fetch(`/api/known-devices/${encodeURIComponent(id)}/auto-accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoAccept: t.checked }),
  });
  await refreshKnownDevices();
});

el("clear-stale")?.addEventListener("click", async () => {
  await fetch("/api/cameras/clear-stale", { method: "POST" });
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
    } else if (msg.type === "event-log") {
      state.events = msg.events ?? [];
      renderEvents();
    } else if (msg.type === "event") {
      state.events.push(msg.event);
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
      renderEvents();
      void refreshKnownDevices().catch((err) => console.warn("refresh known", err));
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
    const [known, events] = await Promise.all([fetchKnownDevices(), fetchEvents()]);
    state.knownDevices = new Map((known.devices ?? []).map((d) => [d.deviceId, d]));
    state.events = events.events ?? [];
    renderKnownDevices();
    renderEvents();
  } catch (e) {
    console.error(e);
    setStatus("Server error", "error");
    return;
  }
  openLobbyWs();
})();
