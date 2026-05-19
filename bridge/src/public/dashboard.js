const el = (id) => document.getElementById(id);

const state = {
  cameras: [],
  health: null,
  selectedId: null,
  refreshTimer: null,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function setStatus(label, mode) {
  const pill = el("status-pill");
  pill.className = `status${mode ? ` status--${mode}` : ""}`;
  el("status-text").textContent = label;
}

function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("hidden"), 1600);
}

async function fetchJson(path, init) {
  const res = await fetch(path, { cache: "no-store", ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `${path} ${res.status}`);
  return body;
}

function cameraId(cam) {
  return cam.id || cam.cameraId;
}

function cameraStatus(cam) {
  return cam.status || cam.ingestStatus || "allocated";
}

function previewUrl(cam) {
  return cam.preview?.webRtcUrl || cam.previewUrls?.webRtc || cam.preview?.hlsUrl || cam.previewUrls?.hls || "";
}

function canShowPreview(cam) {
  return cameraStatus(cam) === "publishing" && Boolean(cam.previewAvailable && previewUrl(cam));
}

function previewType(cam) {
  return cam.preview?.type === "hls" ? "HLS" : "WebRTC";
}

function qualityLabel(quality) {
  if (!quality) return "-";
  const current = quality.currentResolution || (quality.height ? `${quality.height}p` : "");
  const mode = quality.mode === "auto"
    ? `Auto${current ? ` (${current})` : ""}`
    : (quality.currentResolution || quality.requestedResolution || quality.mode);
  const details = [];
  if (quality.frameRate) details.push(`${Math.round(quality.frameRate)}fps`);
  if (quality.bitrateKbps) details.push(`${Math.round(quality.bitrateKbps)} kbps`);
  return [mode, ...details].filter(Boolean).join(" / ");
}

function formatWhen(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return date.toLocaleString();
}

function renderThumb(cam) {
  const label = escapeHtml(cam.name || cam.path || cameraId(cam));
  if (canShowPreview(cam)) {
    const src = escapeAttr(previewUrl(cam));
    return `
      <div class="thumb" title="Live ${previewType(cam)} preview">
        <iframe src="${src}" loading="lazy" allow="autoplay; fullscreen; encrypted-media" referrerpolicy="no-referrer"></iframe>
        <div class="thumb__label">${previewType(cam)} LIVE</div>
      </div>
    `;
  }

  const message = cameraStatus(cam) === "publishing"
    ? "Preview unavailable until WebRTC/HLS egress is enabled"
    : "Waiting for publisher";
  return `
    <div class="thumb" title="${escapeAttr(message)}">
      <div class="thumb__placeholder">${escapeHtml(message)}</div>
      <div class="thumb__label">${label}</div>
    </div>
  `;
}

function statusPill(cam) {
  const status = cameraStatus(cam);
  const label =
    status === "allocated"
      ? "allocated-no-media"
      : status === "offline" || status === "recovering"
        ? `${status}-stable-url`
        : status;
  return `<span class="pill pill--${escapeAttr(status)}">${escapeHtml(label)}</span>`;
}

function actionButtons(cam) {
  const id = escapeAttr(cameraId(cam));
  const url = previewUrl(cam);
  return `
    <div class="actions">
      <button class="btn btn--primary" type="button" data-action="detail" data-id="${id}">Open</button>
      <button class="btn btn--ghost" type="button" data-action="copy-rtsp" data-id="${id}">${cameraStatus(cam) === "publishing" ? "Copy Stable RTSP URL" : "Copy Stable RTSP URL (not live)"}</button>
      ${url ? `<button class="btn btn--ghost" type="button" data-action="open-preview" data-id="${id}">Preview URL</button>` : ""}
      <button class="btn btn--danger" type="button" data-action="delete" data-id="${id}">Remove</button>
    </div>
  `;
}

function renderTable(cameras) {
  const root = el("camera-rows");
  if (cameras.length === 0) {
    root.innerHTML = `<tr><td colspan="8" class="empty">No bridge camera paths registered yet. Accept a camera in the receiver dashboard to allocate RTSP.</td></tr>`;
    return;
  }

  root.innerHTML = cameras
    .map((cam) => {
      const id = cameraId(cam);
      return `
        <tr data-action="detail" data-id="${escapeAttr(id)}">
          <td>${renderThumb(cam)}</td>
          <td>
            <div class="name-cell">
              <div class="name-cell__title">${escapeHtml(cam.name || id)}</div>
              <div class="name-cell__sub">${escapeHtml(id)}</div>
            </div>
          </td>
          <td>
            <div class="mono">session ${escapeHtml(id)}</div>
            <div class="mono">path ${escapeHtml(cam.path || "-")}</div>
            <div class="mono">quality ${escapeHtml(qualityLabel(cam.quality))}</div>
          </td>
          <td>${statusPill(cam)}</td>
          <td>
            <div class="mono">Stable RTSP URL / NVR URL</div>
            <code class="mono rtsp-url">${escapeHtml(cam.rtspUrl || "-")}</code>
            <div class="mono">Use this in VLC/VMS/NVR; it is retained while the phone reconnects.</div>
          </td>
          <td class="mono">${escapeHtml(formatWhen(cam.lastSeen || cam.updatedAt))}</td>
          <td>
            <div class="mono">${escapeHtml(cam.ingestStatus || cameraStatus(cam))}</div>
            ${cam.lastError ? `<div class="mono">${escapeHtml(cam.lastError)}</div>` : ""}
          </td>
          <td>${actionButtons(cam)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCards(cameras) {
  const root = el("camera-cards");
  if (cameras.length === 0) {
    root.innerHTML = `<div class="empty">No bridge camera paths registered yet.</div>`;
    return;
  }

  root.innerHTML = cameras
    .map((cam) => {
      const id = cameraId(cam);
      return `
        <article class="camera-card" data-action="detail" data-id="${escapeAttr(id)}">
          ${renderThumb(cam)}
          <div class="camera-card__body">
            <div class="camera-card__top">
              <div class="name-cell">
                <div class="name-cell__title">${escapeHtml(cam.name || id)}</div>
                <div class="name-cell__sub">${escapeHtml(cam.path || "-")}</div>
              </div>
              ${statusPill(cam)}
            </div>
            <div class="camera-card__meta">
              <div class="mono">Stable RTSP URL / NVR URL</div>
              <code class="mono rtsp-url">${escapeHtml(cam.rtspUrl || "-")}</code>
              <div class="mono">Retained across phone reconnects.</div>
              <div class="mono">last seen ${escapeHtml(formatWhen(cam.lastSeen || cam.updatedAt))}</div>
              <div class="mono">bridge ${escapeHtml(cam.ingestStatus || cameraStatus(cam))}</div>
              <div class="mono">quality ${escapeHtml(qualityLabel(cam.quality))}</div>
            </div>
            <div class="camera-card__actions">${actionButtons(cam)}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSummary() {
  const cameras = state.cameras;
  const publishing = cameras.filter((cam) => cameraStatus(cam) === "publishing").length;
  el("metric-cameras").textContent = String(cameras.length);
  el("metric-publishing").textContent = String(publishing);
  el("metric-rtsp").textContent = state.health?.urls?.rtspBase || "rtsp://<host>:8554";

  const anyPreview = cameras.some((cam) => cam.previewAvailable);
  const healthPreview = state.health?.urls?.webRtcBase || state.health?.urls?.whipBase;
  el("metric-preview").textContent = anyPreview || healthPreview
    ? `MediaMTX WebRTC ${healthPreview || "configured"}`
    : "Placeholder only";
}

function render() {
  const cameras = [...state.cameras].sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
  );
  renderSummary();
  renderTable(cameras);
  renderCards(cameras);
  if (state.selectedId) {
    const selected = cameras.find((cam) => cameraId(cam) === state.selectedId);
    if (selected) renderDetail(selected);
  }
}

async function refresh() {
  try {
    const [health, list] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/cameras"),
    ]);
    state.health = health;
    state.cameras = list.cameras || [];
    const mediaMtxState = health.mediamtx?.apiReachable
      ? "MediaMTX API reachable"
      : health.mediamtx?.running
        ? "MediaMTX starting"
        : "MediaMTX unavailable";
    el("bridge-subtitle").textContent = `${location.origin}/ - ${mediaMtxState} - ${health.mediamtx?.binary || "mediamtx"}`;
    setStatus("Connected", "connected");
    render();
  } catch (err) {
    console.error(err);
    setStatus("API error", "error");
    el("bridge-subtitle").textContent = "Bridge API unavailable";
  }
}

async function copyText(value, label = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    toast(label);
  }
}

function selectedCamera(id) {
  return state.cameras.find((cam) => cameraId(cam) === id);
}

function openDetail(id) {
  const cam = selectedCamera(id);
  if (!cam) return;
  state.selectedId = id;
  renderDetail(cam);
  el("detail-modal").classList.remove("hidden");
}

function closeDetail() {
  state.selectedId = null;
  el("detail-modal").classList.add("hidden");
  el("detail-preview").innerHTML = "";
}

function previewInstructions(cam) {
  const url = cam.rtspUrl || "rtsp://<host>:8554/<camera-path>";
  const configured = cam.previewAvailable && previewUrl(cam);
  if (cameraStatus(cam) !== "publishing") {
    return `
      <strong>No live preview yet.</strong>
      This path is allocated, but the bridge has not seen a successful MediaMTX publish session.
      Start or accept the phone camera, then use <code>${escapeHtml(url)}</code> in VLC or Knoxnet VMS.
    `;
  }
  if (!configured) {
    return `
      <strong>Browser preview unavailable.</strong>
      Browsers cannot play RTSP directly in a video element. Use VLC or Knoxnet VMS with
      <code>${escapeHtml(url)}</code>, or enable MediaMTX WebRTC/HLS egress and expose that port to this browser.
    `;
  }
  return `
    <strong>Preview could not be embedded.</strong>
    Open the MediaMTX preview URL directly, or use VLC/Knoxnet VMS with
    <code>${escapeHtml(url)}</code>.
  `;
}

function renderDetail(cam) {
  const id = cameraId(cam);
  el("detail-title").textContent = cam.name || id;
  el("detail-subtitle").textContent = `${id} / ${cam.path || "-"}`;

  const detailPreview = el("detail-preview");
  if (canShowPreview(cam)) {
    detailPreview.innerHTML = `
      <iframe src="${escapeAttr(previewUrl(cam))}" allow="autoplay; fullscreen; encrypted-media" referrerpolicy="no-referrer"></iframe>
    `;
  } else {
    detailPreview.innerHTML = `<div class="preview-message">${previewInstructions(cam)}</div>`;
  }

  const webRtc = previewUrl(cam);
  el("detail-meta").innerHTML = `
    ${metaRow("Status", cameraStatus(cam))}
    ${metaRow("Bridge ingest", cam.ingestStatus || cameraStatus(cam))}
    ${metaRow("Quality", escapeHtml(qualityLabel(cam.quality)))}
    ${metaRow("RTSP URL", `<code>${escapeHtml(cam.rtspUrl || "-")}</code>`)}
    ${metaRow("MediaMTX preview", webRtc ? `<code>${escapeHtml(webRtc)}</code>` : "Not configured")}
    ${metaRow("Created", cam.createdAt ? new Date(cam.createdAt).toLocaleString() : "-")}
    ${metaRow("Updated", cam.updatedAt ? new Date(cam.updatedAt).toLocaleString() : "-")}
    ${metaRow("Last seen", cam.lastSeen ? new Date(cam.lastSeen).toLocaleString() : "Never")}
    ${cam.lastError ? metaRow("Last error", escapeHtml(cam.lastError)) : ""}
    <div class="meta-actions">
      <button class="btn btn--ghost" type="button" data-action="copy-rtsp" data-id="${escapeAttr(id)}">Copy RTSP</button>
      ${webRtc ? `<button class="btn btn--ghost" type="button" data-action="open-preview" data-id="${escapeAttr(id)}">Open Preview URL</button>` : ""}
      <button class="btn btn--danger" type="button" data-action="delete" data-id="${escapeAttr(id)}">Remove</button>
    </div>
  `;
}

function metaRow(label, value) {
  return `
    <div class="meta-row">
      <div class="meta-row__label">${escapeHtml(label)}</div>
      <div class="meta-row__value">${value}</div>
    </div>
  `;
}

async function deleteCamera(id) {
  const cam = selectedCamera(id);
  if (!cam) return;
  if (!confirm(`Remove bridge path for ${cam.name || id}?`)) return;
  await fetchJson(`/api/cameras/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (state.selectedId === id) closeDetail();
  toast("Removed");
  await refresh();
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const actionNode = target.closest("[data-action]");
  if (!(actionNode instanceof HTMLElement)) return;

  const action = actionNode.dataset.action;
  const id = actionNode.dataset.id;
  if (action) event.stopPropagation();

  try {
    if (action === "detail" && id) {
      openDetail(id);
    } else if (action === "close-detail") {
      closeDetail();
    } else if (action === "copy-rtsp" && id) {
      const cam = selectedCamera(id);
      if (cam?.rtspUrl) await copyText(cam.rtspUrl, "RTSP copied");
    } else if (action === "open-preview" && id) {
      const cam = selectedCamera(id);
      const url = cam ? previewUrl(cam) : "";
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } else if (action === "delete" && id) {
      await deleteCamera(id);
    }
  } catch (err) {
    console.error(err);
    toast("Action failed");
  }
});

el("refresh-now").addEventListener("click", () => void refresh());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetail();
});

void refresh();
state.refreshTimer = setInterval(refresh, 2500);
