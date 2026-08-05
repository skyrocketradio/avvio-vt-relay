"use strict";
// Avvio Voice Tracking — full read-only log + console-style (arrow-key) recording.

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem("vt_token") || null;
let me = { userID: Number(sessionStorage.getItem("vt_uid") || 0), displayName: sessionStorage.getItem("vt_name") || "" };
let ctx = null;
let dates = [], currentDate = null, logRows = [];
let cur = null;           // editor working state
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
function show(view) { for (const v of ["loginView", "logView", "editorView"]) $(v).classList.toggle("hidden", v !== view); }
function logout() { token = null; sessionStorage.clear(); $("whoami").classList.add("hidden"); show("loginView"); }

$("loginForm").onsubmit = async e => {
  e.preventDefault();
  $("loginError").classList.add("hidden");
  try {
    const res = await fetch("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("username").value.trim(), password: $("password").value }) });
    if (!res.ok) throw new Error("Wrong username or password.");
    const data = await res.json();
    token = data.token; me = { userID: data.userID, displayName: data.displayName };
    sessionStorage.setItem("vt_token", token); sessionStorage.setItem("vt_uid", data.userID); sessionStorage.setItem("vt_name", data.displayName);
    ensureCtx(); afterLogin();
  } catch (err) { $("loginError").textContent = err.message; $("loginError").classList.remove("hidden"); }
};
$("logout").onclick = logout;
$("refresh").onclick = () => loadLog(currentDate);
$("back").onclick = () => { stopEverything(); show("logView"); loadLog(currentDate); };
$("datePicker").onchange = () => { currentDate = $("datePicker").value; loadLog(currentDate); };

async function afterLogin() {
  $("displayName").textContent = me.displayName;
  $("whoami").classList.remove("hidden");
  show("logView");
  try {
    dates = await (await api("/v1/me/logdates")).json();
    const dp = $("datePicker"); dp.innerHTML = "";
    for (const d of dates) { const o = document.createElement("option"); o.value = d; o.textContent = prettyDate(d); dp.appendChild(o); }
    currentDate = dates[dates.length - 1] || null;
    if (currentDate) { dp.value = currentDate; await loadLog(currentDate); }
    else { $("emptyLog").classList.remove("hidden"); $("log").innerHTML = ""; }
  } catch (err) { alert(err.message); }
}

// ---------- Full log ----------
async function loadLog(date) {
  if (!date) return;
  try {
    const view = await (await api("/v1/me/log/" + encodeURIComponent(date))).json();
    logRows = view.entries || [];
    $("logTitle").textContent = "Log — " + prettyDate(date);
    renderLog(view);
  } catch (err) {
    if (String(err.message).includes("404")) { $("log").innerHTML = ""; $("emptyLog").classList.remove("hidden"); }
    else alert(err.message);
  }
}

function renderLog(view) {
  const now = view.nowISO ? Date.parse(view.nowISO) : 0;
  const ol = $("log"); ol.innerHTML = "";
  $("emptyLog").classList.toggle("hidden", logRows.length > 0);
  let nowDrawn = false;
  for (const e of logRows) {
    const at = e.airTimeISO ? Date.parse(e.airTimeISO) : 0;
    if (!nowDrawn && now && at >= now) { nowDrawn = true; ol.appendChild(nowDivider()); }
    ol.appendChild(row(e, now));
  }
}

function nowDivider() {
  const li = document.createElement("li"); li.className = "nowline";
  li.innerHTML = `<span>● ON AIR NOW</span>`;
  return li;
}

function row(e, now) {
  const li = document.createElement("li");
  const at = e.airTimeISO ? Date.parse(e.airTimeISO) : 0;
  const past = now && at && at < now;
  const mineEmpty = e.isEmptyVoiceTrack && e.assignedUserID === me.userID;
  li.className = "row" + (e.isRemark ? " remark" : "") + (e.isVoiceTrack ? " vt" : "")
    + (mineEmpty ? " mine" : "") + (past ? " past" : "") + (e.kind === "stopSet" ? " spot" : "");

  const time = e.airTimeISO ? new Date(e.airTimeISO).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  let title = e.title, sub = e.artist || "";
  if (e.isRemark) { title = e.markerLabel || e.title || "Liner"; sub = ""; }
  else if (e.kind === "stopSet") { title = "Commercial break"; sub = ""; }
  else if (e.isEmptyVoiceTrack) { sub = mineEmpty ? "Your voice track — tap to record" : "Voice track"; }
  else if (e.isVoiceTrack) { sub = "Voice track — recorded"; }

  li.innerHTML = `<div class="time">${time}</div>
    <div class="body"><div class="title">${escapeHtml(title)}</div>${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}</div>
    <div class="tag"></div>`;
  const tag = li.querySelector(".tag");
  if (e.isEmptyVoiceTrack && mineEmpty) { tag.innerHTML = `<button class="rec">● Record</button>`; li.onclick = () => openSlot(e.slotId); }
  else if (e.kind === "voiceTrack") { tag.innerHTML = `<span class="badge done">Recorded</span>`; }
  else if (e.isEmptyVoiceTrack) { tag.innerHTML = `<span class="badge">VT</span>`; }
  return li;
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
      phase: "idle", recStart: 0, recChunks: null, recProc: null, recStream: null, recMute: null,
      upFileMs: session.outgoing ? session.outgoing.snippetStartMs + Math.floor((session.outgoing.snippetDurationMs) * 0.7) : 0,
      rightMs: 0, duck: Math.round((session.duckGain ?? 0.35) * 100),
      outSrc: null, outGain: null, auditionStart: 0,
    };
    window._cur = cur; window._ctx = ctx;
    $("editorLabel").textContent = session.label;
    $("outTitle").textContent = session.outgoing ? session.outgoing.title : "—";
    $("inTitle").textContent = session.incoming ? session.incoming.title : "—";
    $("duckRange").value = cur.duck; $("duckVal").textContent = cur.duck + "%";
    $("submitBtn").disabled = true; $("stopBtn").disabled = true; $("editorMsg").textContent = "";
    setPhase("idle");
    show("editorView");
    requestAnimationFrame(redrawAll);
  } catch (err) { alert(err.message); }
}

async function fetchAudio(slotId, role) {
  const buf = await (await api(`/v1/me/slots/${encodeURIComponent(slotId)}/audio/${role}`)).arrayBuffer();
  return await ensureCtx().decodeAudioData(buf.slice(0));
}

function setPhase(p) {
  cur.phase = p;
  const hints = {
    idle: "Press ← to hear the outro, ↑ to start recording.",
    audition: "Hearing the outro… press ↑ when you want to start talking.",
    recording: "Recording — talk over the outro. Press → when the next song should start.",
    recordingNext: "Next song is playing under you — press ↓ to stop.",
    recorded: "Take ready. ▶ Preview, then Send — or ↑ to re-record.",
  };
  $("phaseHint").textContent = hints[p] || "";
  $("btnUp").textContent = (p === "recorded") ? "↑ Re-record" : "↑ Record";
}

// ← audition the outgoing outro
function auditionOutro() {
  if (!cur || !cur.outBuf) return;
  stopAudioSources();
  const c = ctx, dur = cur.outBuf.duration;
  const lead = Math.min(dur, (cur.session.leadMs || 7000) / 1000 + 5);
  const g = c.createGain(); const s = c.createBufferSource();
  s.buffer = cur.outBuf; s.connect(g); g.connect(c.destination);
  s.start(0, Math.max(0, dur - lead));
  cur.outSrc = s; cur.outGain = g; cur.auditionStart = c.currentTime - Math.max(0, dur - lead);
  if (cur.phase === "idle" || cur.phase === "recorded") setPhase("audition");
}

// ↑ start recording (captures UP = current outro position)
async function startRecording() {
  if (!cur) return;
  stopPreview();
  ensureCtx();
  // Capture UP point from the outro's current playback position (if auditioning).
  if (cur.outBuf && cur.outSrc) {
    const elapsed = Math.min(cur.outBuf.duration, Math.max(0, ctx.currentTime - cur.auditionStart));
    cur.upFileMs = (cur.session.outgoing.snippetStartMs || 0) + Math.round(elapsed * 1000);
    if (cur.outGain) cur.outGain.gain.setTargetAtTime(cur.duck / 100, ctx.currentTime, 0.1); // duck under the voice
  } else if (cur.outBuf) {
    auditionOutro();
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const chunks = [];
    proc.onaudioprocess = ev => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    cur.recChunks = chunks; cur.recProc = proc; cur.recStream = stream; cur.recMute = mute; cur.recSrc = src;
    cur.recStart = ctx.currentTime;
    cur.vtBuf = null; cur.wavBlob = null; cur.rightMs = 0;
    setPhase("recording"); $("submitBtn").disabled = true;
  } catch (err) { alert("Microphone unavailable: " + err.message); }
}

// → mark where the next song starts (fires the incoming intro)
function markNext() {
  if (!cur || cur.phase !== "recording") return;
  cur.rightMs = Math.round((ctx.currentTime - cur.recStart) * 1000);
  if (cur.inBuf) {
    const g = ctx.createGain(); const s = ctx.createBufferSource();
    s.buffer = cur.inBuf; s.connect(g); g.connect(ctx.destination);
    g.gain.value = cur.duck / 100; s.start(0);
    cur.inSrc = s; cur.inGain = g;
  }
  setPhase("recordingNext");
}

// ↓ stop recording
function stopRecording() {
  if (!cur || (cur.phase !== "recording" && cur.phase !== "recordingNext")) return;
  const ms = Math.round((ctx.currentTime - cur.recStart) * 1000);
  if (cur.recProc) { cur.recProc.disconnect(); cur.recSrc.disconnect(); cur.recMute.disconnect(); }
  if (cur.recStream) cur.recStream.getTracks().forEach(t => t.stop());
  stopAudioSources();
  if (!cur.rightMs) cur.rightMs = ms;                       // never marked → next fires at end
  const total = (cur.recChunks || []).reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let o = 0; for (const c of cur.recChunks) { samples.set(c, o); o += c.length; }
  const sr = ctx.sampleRate;
  const vt = ctx.createBuffer(1, Math.max(1, samples.length), sr); vt.copyToChannel(samples, 0);
  cur.vtBuf = vt; cur.wavBlob = encodeWAV(samples, sr);
  cur.recProc = cur.recStream = null;
  setPhase("recorded"); $("submitBtn").disabled = false;
  redrawAll();
}

// space — preview the composite
function previewComposite() {
  if (!cur || !cur.vtBuf) return;
  stopPreview();
  const c = ctx, t0 = c.currentTime + 0.12, duck = cur.duck / 100;
  const s = cur.session.outgoing;
  const upInBuf = s ? (cur.upFileMs - s.snippetStartMs) / 1000 : 0;
  const lead = Math.min((cur.session.leadMs || 7000) / 1000, Math.max(0, upInBuf));
  const vtAt = t0 + lead, vtDur = cur.vtBuf.duration;
  if (cur.outBuf) {
    const g = c.createGain(); const src = c.createBufferSource(); src.buffer = cur.outBuf; src.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(1, t0); g.gain.setValueAtTime(1, vtAt); g.gain.linearRampToValueAtTime(duck, vtAt + 0.5);
    src.start(t0, Math.max(0, upInBuf - lead)); previewNodes.push(src, g);
  }
  { const src = c.createBufferSource(); src.buffer = cur.vtBuf; src.connect(c.destination); src.start(vtAt); previewNodes.push(src); }
  if (cur.inBuf) {
    const inAt = vtAt + cur.rightMs / 1000;
    const g = c.createGain(); const src = c.createBufferSource(); src.buffer = cur.inBuf; src.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(duck, inAt); g.gain.linearRampToValueAtTime(1, vtAt + vtDur + 0.4);
    src.start(inAt); previewNodes.push(src, g);
  }
  $("stopBtn").disabled = false;
}

function stopPreview() { for (const n of previewNodes) { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch (e) {} } previewNodes = []; $("stopBtn").disabled = true; }
function stopAudioSources() { for (const n of [cur && cur.outSrc, cur && cur.inSrc]) { try { n && n.stop(); n && n.disconnect(); } catch (e) {} } if (cur) { cur.outSrc = cur.inSrc = null; } }
function stopEverything() { stopPreview(); stopAudioSources(); if (cur && cur.recStream) { try { cur.recProc.disconnect(); cur.recStream.getTracks().forEach(t => t.stop()); } catch (e) {} } }

// Buttons + keyboard (mirror the console)
$("btnLeft").onclick = auditionOutro;
$("btnUp").onclick = () => startRecording();
$("btnRight").onclick = markNext;
$("btnDown").onclick = stopRecording;
$("btnSpace").onclick = previewComposite;
$("stopBtn").onclick = stopPreview;
$("duckRange").oninput = () => { cur.duck = Number($("duckRange").value); $("duckVal").textContent = cur.duck + "%"; };
document.addEventListener("keydown", e => {
  if ($("editorView").classList.contains("hidden")) return;
  const k = e.key;
  if (k === "ArrowLeft") { auditionOutro(); e.preventDefault(); }
  else if (k === "ArrowUp") { startRecording(); e.preventDefault(); }
  else if (k === "ArrowRight") { markNext(); e.preventDefault(); }
  else if (k === "ArrowDown") { stopRecording(); e.preventDefault(); }
  else if (k === " ") { previewComposite(); e.preventDefault(); }
});

// ---------- Submit ----------
$("submitBtn").onclick = async () => {
  if (!cur || !cur.wavBlob) return;
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
    setTimeout(() => { show("logView"); loadLog(currentDate); }, 900);
  } catch (err) { $("editorMsg").textContent = "Failed: " + err.message; $("submitBtn").disabled = false; }
};

// ---------- Helpers ----------
function bufMs(b) { return Math.round(b.length / b.sampleRate * 1000); }
function prettyDate(d) { const dt = new Date(d + "T12:00:00"); return dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, samples.length * 2, true);
  let off = 44; for (let i = 0; i < samples.length; i++) { let s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2; }
  return new Blob([view], { type: "audio/wav" });
}
function peaksFromBuffer(buf, n = 400) {
  const data = buf.getChannelData(0), block = Math.max(1, Math.floor(data.length / n)), out = [];
  for (let i = 0; i < n; i++) { let p = 0; for (let j = 0; j < block; j++) { const v = Math.abs(data[i * block + j] || 0); if (v > p) p = v; } out.push(p); }
  return out;
}
function redrawAll() {
  if (!cur) return;
  if (!$("outWave").clientWidth) { requestAnimationFrame(redrawAll); return; }
  const s = cur.session;
  const upFrac = s.outgoing && s.outgoing.snippetDurationMs ? (cur.upFileMs - s.outgoing.snippetStartMs) / s.outgoing.snippetDurationMs : null;
  drawWave($("outWave"), s.outgoing ? s.outgoing.waveform : [], upFrac);
  drawWave($("inWave"), s.incoming ? s.incoming.waveform : []);
  drawWave($("vtWave"), cur.vtBuf ? peaksFromBuffer(cur.vtBuf) : [],
    cur.vtBuf && cur.rightMs ? cur.rightMs / Math.max(1, bufMs(cur.vtBuf)) : null);
}
function drawWave(canvas, peaks, markerFrac) {
  const dpr = window.devicePixelRatio || 1, H = 70, w = canvas.clientWidth;
  if (!w) return;
  canvas.width = w * dpr; canvas.height = H * dpr;
  const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
  g.fillStyle = "#46525f";
  const n = peaks.length, bw = n ? w / n : w;
  for (let i = 0; i < n; i++) { const ph = Math.max(1, peaks[i] * (H - 6)); g.fillRect(i * bw, (H - ph) / 2, Math.max(1, bw - 1), ph); }
  if (markerFrac != null && markerFrac >= 0 && markerFrac <= 1) { g.fillStyle = "#c79510"; g.fillRect(markerFrac * w - 1, 0, 2, H); }
}
window.addEventListener("resize", redrawAll);

// Boot
if (token) { ensureCtx(); afterLogin(); } else { show("loginView"); }
