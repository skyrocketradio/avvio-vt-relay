"use strict";
// Avvio Voice Tracking — browser client. Talks to the same-origin relay.

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem("vt_token") || null;
let me = { displayName: sessionStorage.getItem("vt_name") || "", userID: Number(sessionStorage.getItem("vt_uid") || 0) };
let ctx = null;                 // AudioContext (created on first gesture)
let cur = null;                 // current slot working state
let previewNodes = [];

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { logout(); throw new Error("Session expired — sign in again."); }
  if (!res.ok) throw new Error((await res.text()) || ("Error " + res.status));
  return res;
}
function ensureCtx() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); return ctx; }

// ---------- Views ----------
function show(view) { for (const v of ["loginView", "listView", "editorView"]) $(v).classList.toggle("hidden", v !== view); }
function logout() { token = null; sessionStorage.clear(); $("whoami").classList.add("hidden"); show("loginView"); }

$("loginForm").onsubmit = async e => {
  e.preventDefault();
  $("loginError").classList.add("hidden");
  try {
    const res = await fetch("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("username").value.trim(), password: $("password").value }) });
    if (!res.ok) throw new Error("Wrong username or password.");
    const data = await res.json();
    token = data.token; me = { displayName: data.displayName, userID: data.userID };
    sessionStorage.setItem("vt_token", token); sessionStorage.setItem("vt_name", data.displayName); sessionStorage.setItem("vt_uid", data.userID);
    ensureCtx();
    afterLogin();
  } catch (err) { $("loginError").textContent = err.message; $("loginError").classList.remove("hidden"); }
};
$("logout").onclick = logout;
$("refresh").onclick = loadSlots;
$("back").onclick = () => { stopPreview(); show("listView"); loadSlots(); };

function afterLogin() {
  $("displayName").textContent = me.displayName;
  $("whoami").classList.remove("hidden");
  show("listView"); loadSlots();
}

async function loadSlots() {
  try {
    const slots = await (await api("/v1/me/slots")).json();
    const ul = $("slots"); ul.innerHTML = "";
    $("emptyList").classList.toggle("hidden", slots.length > 0);
    for (const s of slots) {
      const li = document.createElement("li"); li.className = "slot";
      const when = s.airTimeISO ? new Date(s.airTimeISO).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
      li.innerHTML = `<div><div>${escapeHtml(s.label)}</div><div class="when">${when}</div></div>
        <span class="badge ${s.hasResult ? "done" : ""}">${s.hasResult ? "Recorded" : s.status}</span>`;
      li.onclick = () => openSlot(s.slotId);
      ul.appendChild(li);
    }
  } catch (err) { alert(err.message); }
}

// ---------- Editor ----------
async function openSlot(slotId) {
  ensureCtx();
  try {
    const session = await (await api("/v1/me/slots/" + encodeURIComponent(slotId))).json();
    const outBuf = session.outgoing ? await fetchAudio(slotId, "outgoing") : null;
    const inBuf = session.incoming ? await fetchAudio(slotId, "incoming") : null;
    cur = {
      slotId, session, outBuf, inBuf, vtBuf: null, wavBlob: null,
      upFileMs: session.outgoing ? (session.outgoing.cues.occurrenceSegueMs
        ?? (session.outgoing.snippetStartMs + Math.floor(session.outgoing.snippetDurationMs * 0.8))) : 0,
      rightMs: 0, duck: Math.round((session.duckGain ?? 0.35) * 100),
    };
    $("editorLabel").textContent = session.label;
    $("outTitle").textContent = session.outgoing ? session.outgoing.title : "—";
    $("inTitle").textContent = session.incoming ? session.incoming.title : "—";
    window._cur = cur; window._ctx = ctx;   // for diagnostics
    // Sliders
    const snip = session.outgoing ? session.outgoing.snippetDurationMs : 1000;
    $("upRange").max = snip; $("upRange").value = cur.upFileMs - (session.outgoing ? session.outgoing.snippetStartMs : 0);
    $("duckRange").value = cur.duck;
    $("rightRange").value = 0; $("rightRange").disabled = true;
    $("recStatus").textContent = "No take yet";
    $("recordBtn").classList.remove("recording"); $("recordBtn").textContent = "● Record";
    $("previewBtn").disabled = true; $("submitBtn").disabled = true; $("stopBtn").disabled = true;
    $("editorMsg").textContent = "";
    show("editorView");
    requestAnimationFrame(redrawAll);   // draw once the lanes have a width
  } catch (err) { alert(err.message); }
}

async function fetchAudio(slotId, role) {
  const buf = await (await api(`/v1/me/slots/${encodeURIComponent(slotId)}/audio/${role}`)).arrayBuffer();
  return await ensureCtx().decodeAudioData(buf.slice(0));
}

// Cue sliders
$("upRange").oninput = () => { const s = cur.session.outgoing; cur.upFileMs = (s ? s.snippetStartMs : 0) + Number($("upRange").value); updateCueLabels(); };
$("rightRange").oninput = () => { cur.rightMs = Number($("rightRange").value); updateCueLabels(); };
$("duckRange").oninput = () => { cur.duck = Number($("duckRange").value); updateCueLabels(); };

function updateCueLabels() {
  const s = cur.session.outgoing;
  const upInSnip = s ? (cur.upFileMs - s.snippetStartMs) : 0;
  $("upVal").textContent = fmt(upInSnip) + " into the outro";
  $("rightVal").textContent = cur.vtBuf ? ("at " + fmt(cur.rightMs) + " of your VT") : "record first";
  $("duckVal").textContent = cur.duck + "%";
  if (s) drawWave($("outWave"), s.waveform, upInSnip / Math.max(1, s.snippetDurationMs));
  if (cur.vtBuf) drawWave($("vtWave"), peaksFromBuffer(cur.vtBuf), cur.rightMs / Math.max(1, bufMs(cur.vtBuf)));
}

// ---------- Recording (PCM → WAV, universally decodable by the Mac) ----------
let rec = null;
$("recordBtn").onclick = async () => {
  if (rec) { stopRecording(); return; }
  try {
    ensureCtx();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const chunks = [];
    proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    rec = { stream, src, proc, mute, chunks };
    $("recordBtn").classList.add("recording"); $("recordBtn").textContent = "■ Stop";
    $("recStatus").textContent = "Recording…";
    $("previewBtn").disabled = true; $("submitBtn").disabled = true;
  } catch (err) { alert("Microphone unavailable: " + err.message); }
};
function stopRecording() {
  if (!rec) return;
  rec.proc.disconnect(); rec.src.disconnect(); rec.mute.disconnect();
  rec.stream.getTracks().forEach(t => t.stop());
  const total = rec.chunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let o = 0; for (const c of rec.chunks) { samples.set(c, o); o += c.length; }
  const sr = ctx.sampleRate;
  const vtBuf = ctx.createBuffer(1, Math.max(1, samples.length), sr); vtBuf.copyToChannel(samples, 0);
  cur.vtBuf = vtBuf; cur.wavBlob = encodeWAV(samples, sr);
  const ms = bufMs(vtBuf);
  cur.rightMs = ms;
  $("rightRange").disabled = false; $("rightRange").max = ms; $("rightRange").value = ms;
  $("recStatus").textContent = "Take: " + fmt(ms);
  $("recordBtn").classList.remove("recording"); $("recordBtn").textContent = "● Re-record";
  $("previewBtn").disabled = false; $("submitBtn").disabled = false;
  rec = null;
  updateCueLabels();
}

// ---------- Composite preview (mirrors the console: outgoing ducks under VT into incoming) ----------
$("previewBtn").onclick = () => {
  stopPreview();
  const c = ctx, t0 = c.currentTime + 0.12, duck = cur.duck / 100;
  const s = cur.session.outgoing;
  const upInBuf = s ? (cur.upFileMs - s.snippetStartMs) / 1000 : 0;
  const lead = Math.min((cur.session.leadMs || 7000) / 1000, upInBuf);
  const vtStart = t0 + lead;
  const vtDur = bufMs(cur.vtBuf) / 1000;
  // Outgoing tail, ducking as the VT opens.
  if (cur.outBuf) {
    const g = c.createGain(); const src = c.createBufferSource(); src.buffer = cur.outBuf; src.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(1, t0); g.gain.setValueAtTime(1, vtStart); g.gain.linearRampToValueAtTime(duck, vtStart + 0.5);
    src.start(t0, Math.max(0, upInBuf - lead)); previewNodes.push(src, g);
  }
  // The voice track.
  { const src = c.createBufferSource(); src.buffer = cur.vtBuf; src.connect(c.destination); src.start(vtStart); previewNodes.push(src); }
  // Incoming, firing at RIGHT into the VT and ducked until the VT ends.
  if (cur.inBuf) {
    const inAt = vtStart + cur.rightMs / 1000;
    const g = c.createGain(); const src = c.createBufferSource(); src.buffer = cur.inBuf; src.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(duck, inAt); g.gain.linearRampToValueAtTime(1, vtStart + vtDur + 0.4);
    src.start(inAt); previewNodes.push(src, g);
  }
  $("stopBtn").disabled = false;
};
$("stopBtn").onclick = stopPreview;
function stopPreview() { for (const n of previewNodes) { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch (e) {} } previewNodes = []; $("stopBtn").disabled = true; }

// ---------- Submit ----------
$("submitBtn").onclick = async () => {
  if (!cur.wavBlob) return;
  $("submitBtn").disabled = true; $("editorMsg").textContent = "Sending…";
  const result = {
    version: 1, fingerprint: cur.session.fingerprint,
    voice: { filename: "voice.wav", container: "wav", sampleRate: ctx.sampleRate, channels: 1, durationMs: bufMs(cur.vtBuf) },
    voiceDurationMs: bufMs(cur.vtBuf),
    cues: { outgoingSegueMs: cur.upFileMs, vtSegueMs: cur.rightMs, fadeEndMs: null, fadeTargetGain: cur.duck / 100 },
    recordedByUserID: me.userID, recordedByName: me.displayName, recordedAtISO: new Date().toISOString(),
  };
  const fd = new FormData();
  fd.append("result", JSON.stringify(result));
  fd.append("voice", cur.wavBlob, "voice.wav");
  try {
    await api(`/v1/me/slots/${encodeURIComponent(cur.slotId)}/result`, { method: "POST", body: fd });
    $("editorMsg").textContent = "Sent! It will import at the station.";
    setTimeout(() => { show("listView"); loadSlots(); }, 900);
  } catch (err) { $("editorMsg").textContent = "Failed: " + err.message; $("submitBtn").disabled = false; }
};

// ---------- Helpers ----------
function bufMs(b) { return Math.round(b.length / b.sampleRate * 1000); }
function fmt(ms) { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function peaksFromBuffer(buf, n = 400) {
  const data = buf.getChannelData(0), block = Math.max(1, Math.floor(data.length / n)), out = [];
  for (let i = 0; i < n; i++) { let peak = 0; for (let j = 0; j < block; j++) { const v = Math.abs(data[i * block + j] || 0); if (v > peak) peak = v; } out.push(peak); }
  return out;
}
function drawWave(canvas, peaks, markerFrac) {
  const dpr = window.devicePixelRatio || 1, H = 70, w = canvas.clientWidth;
  if (!w) return;                                  // not laid out yet
  canvas.width = w * dpr; canvas.height = H * dpr;
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
  g.fillStyle = "#46525f";
  const n = peaks.length, bw = n ? w / n : w;
  for (let i = 0; i < n; i++) { const ph = Math.max(1, peaks[i] * (H - 6)); g.fillRect(i * bw, (H - ph) / 2, Math.max(1, bw - 1), ph); }
  if (markerFrac != null && markerFrac >= 0 && markerFrac <= 1) { g.fillStyle = "#c79510"; g.fillRect(markerFrac * w - 1, 0, 2, H); }
}

function redrawAll() {
  if (!cur) return;
  if (!$("outWave").clientWidth) { requestAnimationFrame(redrawAll); return; }   // wait for layout
  const s = cur.session;
  drawWave($("outWave"), s.outgoing ? s.outgoing.waveform : []);
  drawWave($("inWave"), s.incoming ? s.incoming.waveform : []);
  drawWave($("vtWave"), cur.vtBuf ? peaksFromBuffer(cur.vtBuf) : []);
  updateCueLabels();
}
window.addEventListener("resize", redrawAll);

// Boot
if (token) { ensureCtx(); afterLogin(); } else { show("loginView"); }
