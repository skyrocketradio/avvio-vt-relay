"use strict";
// Avvio Voice Tracking — full read-only log + console-style (arrow-key) recording.

const $ = id => document.getElementById(id);
let token = sessionStorage.getItem("vt_token") || null;
let me = { userID: Number(sessionStorage.getItem("vt_uid") || 0), displayName: sessionStorage.getItem("vt_name") || "" };
let ctx = null;
let dates = [], currentDate = null, logRows = [];
let cur = null;           // editor working state
let previewNodes = [];
let hourChips = {}, hourObserver = null;
let inDeviceId = localStorage.getItem("vt_in") || "";
let outDeviceId = localStorage.getItem("vt_out") || "";
let meterStream = null, meterRAF = 0;

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { logout(); throw new Error("Session expired — sign in again."); }
  if (!res.ok) throw new Error((await res.text()) || ("Error " + res.status));
  return res;
}
function ensureCtx() { if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); applyOutput(); } if (ctx.state === "suspended") ctx.resume(); return ctx; }

// ---------- Views ----------
function show(view) { for (const v of ["loginView", "logView"]) $(v).classList.toggle("hidden", v !== view); }
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
$("refresh").onclick = () => { closeEditor(); loadLog(currentDate); };
$("back").onclick = closeEditor;
$("datePicker").onchange = () => { closeEditor(); currentDate = $("datePicker").value; loadLog(currentDate); };

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
async function loadLog(date, focusSlot) {
  if (!date) return;
  try {
    const view = await (await api("/v1/me/log/" + encodeURIComponent(date))).json();
    logRows = view.entries || [];
    $("logTitle").textContent = "Log — " + prettyDate(date);
    renderLog(view, focusSlot);
  } catch (err) {
    if (String(err.message).includes("404")) { $("log").innerHTML = ""; $("emptyLog").classList.remove("hidden"); }
    else alert(err.message);
  }
}

function renderLog(view, focusSlot) {
  const now = view.nowISO ? Date.parse(view.nowISO) : 0;
  const ol = $("log"); ol.innerHTML = "";
  $("emptyLog").classList.toggle("hidden", logRows.length > 0);
  let nowDrawn = false;
  const hoursSeen = [], anchors = {};
  for (const e of logRows) {
    const at = e.airTimeISO ? Date.parse(e.airTimeISO) : 0;
    if (!nowDrawn && now && at >= now) { nowDrawn = true; ol.appendChild(nowDivider()); }
    const li = row(e, now);
    if (e.airTimeISO) {
      const h = new Date(e.airTimeISO).getHours();
      if (!(h in anchors)) { anchors[h] = li; hoursSeen.push(h); li.id = "hour-" + h; li.dataset.hour = h; }
    }
    ol.appendChild(li);
  }
  buildHourBar(hoursSeen, anchors);
  if (focusSlot && scrollToRow(focusSlot, "auto")) return;   // returning from editor → land on that VT
  landInitial(hoursSeen);
}

// ---------- Hour quick-links ----------
function hourLabel(h) { const p = h < 12 ? "a" : "p"; let x = h % 12; if (x === 0) x = 12; return x + p; }
function hourbarOffset() {
  const tb = document.querySelector(".topbar"), hb = $("hourbar");
  return (tb ? tb.offsetHeight : 48) + (hb && !hb.classList.contains("hidden") ? hb.offsetHeight : 0) + 8;
}
function buildHourBar(hours, anchors) {
  const bar = $("hourbar"); bar.innerHTML = ""; hourChips = {};
  bar.classList.toggle("hidden", hours.length === 0);
  for (const h of hours) {
    const b = document.createElement("button");
    b.className = "hourchip"; b.textContent = hourLabel(h); b.dataset.hour = h;
    b.onclick = () => scrollToHour(h, "smooth");
    bar.appendChild(b); hourChips[h] = b;
  }
  setupHourSpy(anchors);
}
function setActiveChip(h) {
  for (const k in hourChips) hourChips[k].classList.toggle("active", Number(k) === Number(h));
}
function scrollToHour(h, behavior) {
  const el = document.getElementById("hour-" + h); if (!el) return;
  const y = el.getBoundingClientRect().top + window.scrollY - hourbarOffset();
  window.scrollTo({ top: Math.max(0, y), behavior: behavior || "auto" });
  setActiveChip(h);
}
function scrollToRow(slotId, behavior) {
  const el = $("log").querySelector(`.row[data-slot="${slotId}"]`);
  if (!el) return false;
  const y = el.getBoundingClientRect().top + window.scrollY - hourbarOffset();
  window.scrollTo({ top: Math.max(0, y), behavior: behavior || "auto" });
  const ent = logRows.find(e => e.slotId === slotId);
  if (ent && ent.airTimeISO) setActiveChip(new Date(ent.airTimeISO).getHours());
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1300);
  return true;
}
function landInitial(hours) {
  if (!hours.length) return;
  if (!isTodayDate(currentDate)) { window.scrollTo({ top: 0 }); setActiveChip(hours[0]); return; }
  const nowH = new Date().getHours();
  let target = hours[0];
  for (const h of hours) { if (h <= nowH) target = h; }
  requestAnimationFrame(() => scrollToHour(target, "auto"));
}
function isTodayDate(d) {
  if (!d) return false;
  const t = new Date();
  return d === `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function setupHourSpy(anchors) {
  if (hourObserver) hourObserver.disconnect();
  if (!("IntersectionObserver" in window)) return;
  const off = hourbarOffset();
  hourObserver = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) setActiveChip(Number(en.target.dataset.hour));
  }, { rootMargin: `-${off}px 0px -70% 0px`, threshold: 0 });
  for (const h in anchors) hourObserver.observe(anchors[h]);
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
  if (e.slotId) li.dataset.slot = e.slotId;
  return li;
}

// ---------- Editor ----------
// Collapse the inline editor and park its node back on <body> so a log re-render
// (which clears #log) never destroys the canvas + its event wiring.
function closeEditor() {
  disarmSend();
  stopEverything();
  const h = $("editorHost");
  if (h) { h.classList.add("hidden"); document.body.appendChild(h); }
  cur = null;
}
async function openSlot(slotId) {
  if (cur) closeEditor();
  ensureCtx();
  try {
    const session = await (await api("/v1/me/slots/" + encodeURIComponent(slotId))).json();
    const outBuf = session.outgoing ? await fetchAudio(slotId, "outgoing") : null;
    const inBuf = session.incoming ? await fetchAudio(slotId, "incoming") : null;
    cur = {
      slotId, session, outBuf, inBuf, vtBuf: null, wavBlob: null,
      phase: "idle", recStart: 0, recChunks: null, recProc: null, recStream: null, recMute: null,
      duck: Number(localStorage.getItem("vt_duck")) || Math.round((session.duckGain ?? 0.35) * 100),
      outSrc: null, outGain: null, auditionStart: 0,
      outAtT: 0,
      vtAtT: session.outgoing ? Math.round(session.outgoing.snippetDurationMs * 0.7) : 0,
      inAtT: session.outgoing ? Math.round(session.outgoing.snippetDurationMs * 0.7) : 0,
      viewStartT: null, viewMs: null, playMs: null, playRAF: 0, playing: false, geo: null,
    };
    window._cur = cur; window._ctx = ctx;
    $("editorLabel").textContent = session.label;
    $("outTitle").textContent = ctxLabel(session.outgoing);
    $("inTitle").textContent = ctxLabel(session.incoming);
    $("introInfo").textContent = introText(session.incoming);
    $("duckRange").value = cur.duck; $("duckVal").textContent = cur.duck + "%";
    $("submitBtn").disabled = true; $("stopBtn").disabled = true; $("editorMsg").textContent = "";
    const host = $("editorHost");
    const row = $("log").querySelector(`.row[data-slot="${slotId}"]`);
    if (row) row.after(host); else $("log").appendChild(host);
    host.classList.remove("hidden");
    setPhase("idle");
    requestAnimationFrame(() => { drawTimeline(); updateReadout(); host.scrollIntoView({ block: "center", behavior: "smooth" }); });
  } catch (err) { alert(err.message); }
}

async function fetchAudio(slotId, role) {
  const buf = await (await api(`/v1/me/slots/${encodeURIComponent(slotId)}/audio/${role}`)).arrayBuffer();
  return await ensureCtx().decodeAudioData(buf.slice(0));
}

function setPhase(p) {
  cur.phase = p;
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
  disarmSend();
  stopPreview();
  ensureCtx();
  // Capture UP point from the outro's current playback position (if auditioning).
  if (cur.outBuf && cur.outSrc) {
    const elapsed = Math.min(cur.outBuf.duration, Math.max(0, ctx.currentTime - cur.auditionStart));
    cur.vtAtT = (cur.outAtT || 0) + Math.round(elapsed * 1000);   // talk starts here, over the outro
    cur.inAtT = cur.vtAtT;                                        // next song not marked yet
    if (cur.outGain) cur.outGain.gain.setTargetAtTime(cur.duck / 100, ctx.currentTime, 0.1); // duck under the voice
  } else if (cur.outBuf) {
    auditionOutro();
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    stopAudioSources();
    return micFail("This browser can't reach a microphone here. Use Safari or Chrome and open the site over https://.");
  }
  try {
    const stream = await getMicStream();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    const chunks = [];
    proc.onaudioprocess = ev => {
      const d = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      let peak = 0; for (let i = 0; i < d.length; i += 16) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
      const mf = $("meterFill"); if (mf) mf.style.width = Math.min(100, Math.round(peak * 140)) + "%";
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    cur.recChunks = chunks; cur.recProc = proc; cur.recStream = stream; cur.recMute = mute; cur.recSrc = src;
    cur.recStart = ctx.currentTime;
    cur.vtBuf = null; cur.wavBlob = null;
    setPhase("recording"); $("submitBtn").disabled = true; $("editorMsg").textContent = ""; drawTimeline();
  } catch (err) {
    stopAudioSources();
    if (err && err.name === "NotAllowedError") micFail("Microphone blocked. Click the camera/lock icon in the address bar, allow the mic for this site, then press ↑ again.");
    else if (err && err.name === "NotFoundError") micFail("No microphone found. Check your input device, then press ↑ again.");
    else micFail("Microphone error: " + (err && err.message ? err.message : err));
  }
}
function micFail(msg) { setPhase("idle"); const mf = $("meterFill"); if (mf) mf.style.width = "0"; $("editorMsg").textContent = msg; openAudio(); }

// Acquire the mic, honoring the chosen input device; fall back to default if that
// device vanished (unplugged RODE) so recording still works.
async function getMicStream() {
  const base = { echoCancellation: true, noiseSuppression: true };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: inDeviceId ? { deviceId: { exact: inDeviceId }, ...base } : base });
  } catch (err) {
    if (err && err.name === "OverconstrainedError" && inDeviceId) {
      inDeviceId = ""; localStorage.removeItem("vt_in");
      return await navigator.mediaDevices.getUserMedia({ audio: base });
    }
    throw err;
  }
}

// → mark where the next song starts (fires the incoming intro)
function markNext() {
  if (!cur || cur.phase !== "recording") return;
  cur.inAtT = (cur.vtAtT || 0) + Math.round((ctx.currentTime - cur.recStart) * 1000);
  if (cur.inBuf) {
    const g = ctx.createGain(); const s = ctx.createBufferSource();
    s.buffer = cur.inBuf; s.connect(g); g.connect(ctx.destination);
    g.gain.value = cur.duck / 100; s.start(0);
    cur.inSrc = s; cur.inGain = g;
  }
  setPhase("recordingNext"); drawTimeline(); updateReadout();
}

// ↓ stop recording
function stopRecording() {
  if (!cur || (cur.phase !== "recording" && cur.phase !== "recordingNext")) return;
  const ms = Math.round((ctx.currentTime - cur.recStart) * 1000);
  if (cur.recProc) { cur.recProc.disconnect(); cur.recSrc.disconnect(); cur.recMute.disconnect(); }
  if (cur.recStream) cur.recStream.getTracks().forEach(t => t.stop());
  stopAudioSources();
  if ((cur.inAtT || 0) <= (cur.vtAtT || 0)) cur.inAtT = (cur.vtAtT || 0) + ms;   // never marked → next fires at end
  const total = (cur.recChunks || []).reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let o = 0; for (const c of cur.recChunks) { samples.set(c, o); o += c.length; }
  const sr = ctx.sampleRate;
  const vt = ctx.createBuffer(1, Math.max(1, samples.length), sr); vt.copyToChannel(samples, 0);
  cur.vtBuf = vt; cur.wavBlob = encodeWAV(samples, sr);
  cur.recProc = cur.recStream = null;
  const mf = $("meterFill"); if (mf) mf.style.width = "0";
  setPhase("recorded"); $("submitBtn").disabled = false;
  drawTimeline(); updateReadout();
}

// space / ▶ — play or stop from the playhead (or a sensible run-up if unset)
function defaultStartMs() { const m = tlModel(); return m.out ? m.outStartT : m.tMin; }   // play from the outro's far-left start
function togglePlay() { if (!cur || cur.phase === "recording" || cur.phase === "recordingNext") return; if (cur.playing) pausePlay(); else previewFrom(cur.playMs != null ? cur.playMs : defaultStartMs()); }

// Play the composite from an arbitrary timeline position, ducking the beds under the
// VT, and sweep a playhead. Elements already underway at `fromT` start mid-buffer.
function previewFrom(fromT) {
  if (!cur) return;
  stopSources();
  ensureCtx(); applyOutput();
  const m = tlModel(), duck = cur.duck / 100;
  const from = clamp(fromT == null ? m.tMin : fromT, m.tMin, m.tMax);
  const t0 = ctx.currentTime + 0.1;
  const rt = T => t0 + (T - from) / 1000;
  if (cur.outBuf && m.outEndT > from) {                                   // outro
    const g = ctx.createGain(), s = ctx.createBufferSource(); s.buffer = cur.outBuf; s.connect(g); g.connect(ctx.destination);
    const startAt = from <= m.outStartT ? rt(m.outStartT) : t0, offset = Math.max(0, from - m.outStartT) / 1000;
    if (Math.max(m.outStartT, from) < m.vtStartT) { g.gain.setValueAtTime(1, Math.max(t0, startAt)); g.gain.setValueAtTime(1, rt(m.vtStartT)); g.gain.linearRampToValueAtTime(duck, rt(m.vtStartT) + 0.4); }
    else g.gain.setValueAtTime(duck, Math.max(t0, startAt));
    s.start(startAt, offset); previewNodes.push(s, g);
  }
  if (cur.vtBuf && m.vtEndT > from) {                                     // VT
    const s = ctx.createBufferSource(); s.buffer = cur.vtBuf; s.connect(ctx.destination);
    if (from <= m.vtStartT) s.start(rt(m.vtStartT)); else s.start(t0, (from - m.vtStartT) / 1000);
    previewNodes.push(s);
  }
  if (cur.inBuf && m.inEndT > from) {                                     // incoming
    const g = ctx.createGain(), s = ctx.createBufferSource(); s.buffer = cur.inBuf; s.connect(g); g.connect(ctx.destination);
    const startAt = from <= m.inStartT ? rt(m.inStartT) : t0, offset = Math.max(0, from - m.inStartT) / 1000;
    if (Math.max(m.inStartT, from) < m.vtEndT) { g.gain.setValueAtTime(duck, Math.max(t0, startAt)); g.gain.setValueAtTime(duck, rt(m.vtEndT)); g.gain.linearRampToValueAtTime(1, rt(m.vtEndT) + 0.4); }
    else g.gain.setValueAtTime(1, Math.max(t0, startAt));
    s.start(startAt, offset); previewNodes.push(s, g);
  }
  cur.playing = true; $("stopBtn").disabled = false;
  const step = () => {
    if (!cur || !cur.playing) return;
    cur.playMs = from + (ctx.currentTime - t0) * 1000;
    drawTimeline();
    if (cur.playMs < m.tMax + 300) cur.playRAF = requestAnimationFrame(step); else stopPreview();
  };
  cur.playRAF = requestAnimationFrame(step);
}

function stopSources() { for (const n of previewNodes) { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch (e) {} } previewNodes = []; }
function pausePlay() { stopSources(); if (cur) { cur.playing = false; if (cur.playRAF) cancelAnimationFrame(cur.playRAF); cur.playRAF = 0; } $("stopBtn").disabled = true; if (cur) drawTimeline(); }   // keeps the playhead
function stopPreview() { stopSources(); if (cur) { cur.playing = false; if (cur.playRAF) cancelAnimationFrame(cur.playRAF); cur.playRAF = 0; cur.playMs = null; } $("stopBtn").disabled = true; if (cur && !$("editorHost").classList.contains("hidden")) drawTimeline(); }
function stopAudioSources() { for (const n of [cur && cur.outSrc, cur && cur.inSrc]) { try { n && n.stop(); n && n.disconnect(); } catch (e) {} } if (cur) { cur.outSrc = cur.inSrc = null; } }
function stopEverything() { stopPreview(); stopAudioSources(); if (cur && cur.recStream) { try { cur.recProc.disconnect(); cur.recStream.getTracks().forEach(t => t.stop()); } catch (e) {} } }

// Buttons + keyboard (mirror the console)
$("btnLeft").onclick = auditionOutro;
$("btnUp").onclick = () => startRecording();
$("btnRight").onclick = markNext;
$("btnDown").onclick = stopRecording;
$("btnSpace").onclick = togglePlay;
$("stopBtn").onclick = stopPreview;
$("duckRange").oninput = () => {
  const v = Number($("duckRange").value); $("duckVal").textContent = v + "%"; localStorage.setItem("vt_duck", v);
  if (cur) { cur.duck = v; if (!$("editorHost").classList.contains("hidden")) drawTimeline(); }
};

// Info + Audio setup
$("infoBtn").onclick = () => $("infoModal").classList.remove("hidden");
$("infoClose").onclick = () => $("infoModal").classList.add("hidden");
$("audioBtn").onclick = openAudio;
$("audioClose").onclick = closeAudio;
$("testSpk").onclick = playTestTone;
$("micRetry").onclick = () => setupDevices(true);
$("inDevice").onchange = () => { inDeviceId = $("inDevice").value; localStorage.setItem("vt_in", inDeviceId); startMeter(); };
$("outDevice").onchange = () => { outDeviceId = $("outDevice").value; localStorage.setItem("vt_out", outDeviceId); applyOutput(); };
document.addEventListener("keydown", e => {
  if ($("editorHost").classList.contains("hidden")) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const k = e.key;
  if (k === "Enter") { confirmSend(); e.preventDefault(); return; }
  if (k === "ArrowLeft") { disarmSend(); auditionOutro(); e.preventDefault(); }
  else if (k === "ArrowUp") { disarmSend(); startRecording(); e.preventDefault(); }
  else if (k === "ArrowRight") { markNext(); e.preventDefault(); }
  else if (k === "ArrowDown") { stopRecording(); e.preventDefault(); }
  else if (k === " ") { disarmSend(); togglePlay(); e.preventDefault(); }
});

// ---------- Audio setup ----------
async function openAudio() {
  const dv = cur ? cur.duck : (Number(localStorage.getItem("vt_duck")) || 30);
  $("duckRange").value = dv; $("duckVal").textContent = dv + "%";
  $("audioModal").classList.remove("hidden"); await setupDevices(true);
}
function closeAudio() { stopMeter(); $("audioModal").classList.add("hidden"); }

async function setupDevices(requestPermission) {
  $("audioMsg").textContent = "";
  ensureCtx();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("audioMsg").textContent = "This browser can't access audio devices here. Open the site in Safari or Chrome directly.";
    return;
  }
  if (requestPermission) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
    catch (err) { $("audioMsg").textContent = micErrorText(err); return; }
  }
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const ins = devices.filter(d => d.kind === "audioinput");
  const outs = devices.filter(d => d.kind === "audiooutput");
  fillSelect($("inDevice"), ins, inDeviceId, "Microphone");
  if (!inDeviceId && ins[0]) inDeviceId = ins[0].deviceId;
  const canSink = ctx && typeof ctx.setSinkId === "function";
  $("outRow").classList.toggle("hidden", !(canSink && outs.length));
  if (canSink && outs.length) { fillSelect($("outDevice"), outs, outDeviceId, "Speakers"); applyOutput(); }
  if (!ins.length) { $("audioMsg").textContent = "No microphone detected. Enable your browser in macOS System Settings → Privacy & Security → Microphone, then Re-check."; return; }
  startMeter();
}
function fillSelect(sel, devices, chosen, fallback) {
  sel.innerHTML = "";
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId; o.textContent = d.label || `${fallback} ${i + 1}`;
    if (d.deviceId === chosen) o.selected = true;
    sel.appendChild(o);
  });
}
async function startMeter() {
  stopMeter();
  try { meterStream = await navigator.mediaDevices.getUserMedia({ audio: inDeviceId ? { deviceId: { exact: inDeviceId } } : true }); }
  catch (err) { $("audioMsg").textContent = micErrorText(err); return; }
  const src = ctx.createMediaStreamSource(meterStream);
  const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  const tick = () => {
    an.getByteTimeDomainData(buf);
    let peak = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128) / 128; if (v > peak) peak = v; }
    const m = $("testMeter"); if (m) m.style.width = Math.min(100, Math.round(peak * 160)) + "%";
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
  $("micHint").textContent = "Talk — the bar should move.";
}
function stopMeter() {
  if (meterRAF) { cancelAnimationFrame(meterRAF); meterRAF = 0; }
  if (meterStream) { meterStream.getTracks().forEach(t => t.stop()); meterStream = null; }
  const m = $("testMeter"); if (m) m.style.width = "0";
}
async function applyOutput() {
  try { if (ctx && typeof ctx.setSinkId === "function" && outDeviceId) await ctx.setSinkId(outDeviceId); } catch (e) {}
}
function playTestTone() {
  ensureCtx(); applyOutput();
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 440; o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  o.start(t); o.stop(t + 0.65);
}
function micErrorText(err) {
  if (!err) return "Microphone unavailable.";
  if (err.name === "NotAllowedError") return "Microphone blocked. Allow it via the site-info icon in the address bar, and enable your browser in macOS System Settings → Privacy & Security → Microphone.";
  if (err.name === "NotFoundError") return "No microphone found. Connect your RODE and click Re-check.";
  return "Microphone error: " + (err.message || err.name || err);
}
function introText(el) {
  if (!el || !el.cues) return "";
  const start = el.cues.startMs || 0, post = el.cues.introEndMs;
  if (post == null || post <= start) return "Intro: none (vocal at top)";
  return `Intro to post: ${((post - start) / 1000).toFixed(1)}s`;
}

// ---------- Submit (Enter-twice / click-to-confirm, for fast keyboard sends) ----------
let sendArmed = false, sendArmTimer = 0;
function disarmSend() {
  sendArmed = false; if (sendArmTimer) { clearTimeout(sendArmTimer); sendArmTimer = 0; }
  const b = $("submitBtn"); if (b && !b.disabled) { b.textContent = "Send to station"; b.classList.remove("armed"); }
}
function armSend() {
  if (!cur || !cur.wavBlob) { $("editorMsg").textContent = "Record a take first (↑ then ↓)."; return; }
  sendArmed = true;
  $("submitBtn").textContent = "Press Enter again to send ✓"; $("submitBtn").classList.add("armed");
  $("editorMsg").textContent = "Confirm: press Enter again (or click) to send.";
  if (sendArmTimer) clearTimeout(sendArmTimer);
  sendArmTimer = setTimeout(disarmSend, 6000);
}
function confirmSend() { if (!cur || !cur.wavBlob) return armSend(); if (sendArmed) doSend(); else armSend(); }
async function doSend() {
  if (!cur || !cur.wavBlob) return;
  disarmSend();
  $("submitBtn").disabled = true; $("editorMsg").textContent = "Sending…";
  const c = cuesFromPositions();
  const result = {
    version: 1, fingerprint: cur.session.fingerprint,
    voice: { filename: "voice.wav", container: "wav", sampleRate: ctx.sampleRate, channels: 1, durationMs: bufMs(cur.vtBuf) },
    voiceDurationMs: bufMs(cur.vtBuf),
    cues: { outgoingSegueMs: c.upFileMs, vtSegueMs: c.rightMs, fadeEndMs: null, fadeTargetGain: cur.duck / 100 },
    recordedByUserID: me.userID, recordedByName: me.displayName, recordedAtISO: new Date().toISOString(),
  };
  const fd = new FormData();
  fd.append("result", JSON.stringify(result));
  fd.append("voice", cur.wavBlob, "voice.wav");
  try {
    await api(`/v1/me/slots/${encodeURIComponent(cur.slotId)}/result`, { method: "POST", body: fd });
    $("editorMsg").textContent = "Sent! It will import at the station.";
    setTimeout(() => { const d = currentDate; closeEditor(); loadLog(d); }, 900);
  } catch (err) { $("editorMsg").textContent = "Failed: " + err.message; $("submitBtn").disabled = false; }
}
$("submitBtn").onclick = confirmSend;

// ---------- Helpers ----------
function ctxLabel(el) { return el ? (el.artist ? `${el.title} — ${el.artist}` : el.title) : "—"; }
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
// ---------- Timeline (draggable, zoomable transition editor) ----------
const TL = { TOP: 8, LANE_H: 52, GAP: 12, PADX: 10, RULER: 20 };  // LANE_H/GAP/RULER recomputed per draw for mobile
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Each block's left edge lives on `cur` as an absolute ms position (outAtT/vtAtT/inAtT).
// Dragging a block moves ONLY that block; station cues are derived from the positions.
function tlModel() {
  const s = cur.session, out = s.outgoing, inc = s.incoming;
  const outDur = out ? out.snippetDurationMs : 0;
  const inDur = inc ? inc.snippetDurationMs : 0;
  const vtDur = cur.vtBuf ? bufMs(cur.vtBuf) : 0;
  const outAtT = cur.outAtT || 0, vtAtT = cur.vtAtT || 0, inAtT = cur.inAtT || 0;
  const outStartT = outAtT, outEndT = outAtT + outDur;
  const vtStartT = vtAtT, vtEndT = vtAtT + vtDur;
  const inStartT = inAtT, inEndT = inAtT + inDur;
  const upT = clamp(vtAtT, outStartT, outEndT);                                 // talk-up marker, drawn on the outro
  const postT = (inc && inc.cues && inc.cues.introEndMs != null) ? inAtT + (inc.cues.introEndMs - inc.snippetStartMs) : null;
  const tMin = Math.min(outStartT, vtStartT, inStartT, 0);
  const tMax = Math.max(outEndT, vtEndT, inEndT, 1000);
  return { out, inc, outDur, inDur, vtDur, outAtT, vtAtT, inAtT, outStartT, outEndT, vtStartT, vtEndT, inStartT, inEndT, upT, postT, tMin, tMax, total: tMax - tMin };
}

// Station cues derived from block positions: where the VT enters the outro, and how
// far into the VT the next song fires.
function cuesFromPositions() {
  const m = tlModel(), outStart = m.out ? m.out.snippetStartMs : 0;
  const upFileMs = m.out ? Math.round(clamp(outStart + (m.vtAtT - m.outAtT), outStart, outStart + m.outDur)) : 0;
  const rightMs = Math.max(0, Math.round(m.inAtT - m.vtAtT));
  return { upFileMs, rightMs };
}

function roundRect(g, x, y, w, h, r) {
  w = Math.max(2, w); r = Math.min(r, h / 2, w / 2);
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function vline(g, x, y, h, color) { g.fillStyle = color; g.fillRect(x - 1, y, 2, h); }
function tlLabel(g, text, x, y, color) { g.fillStyle = color; g.font = "10px -apple-system, BlinkMacSystemFont, sans-serif"; g.fillText(text, x, y); }
function drawBlock(g, x, y, w, h, peaks, wave, bg, border) {
  g.save(); roundRect(g, x, y, w, h, 6); g.clip();
  g.fillStyle = bg; g.fillRect(x, y, Math.max(2, w), h);
  const n = peaks ? peaks.length : 0;
  if (n) { const bw = Math.max(2, w) / n; g.fillStyle = wave; for (let i = 0; i < n; i++) { const ph = Math.max(1, peaks[i] * (h - 12)); g.fillRect(x + i * bw, y + (h - ph) / 2, Math.max(1, bw - 0.5), ph); } }
  g.restore();
  g.strokeStyle = border; g.lineWidth = 1.5; roundRect(g, x, y, w, h, 6); g.stroke();
}

function drawTimeline() {
  const cv = $("timeline"); if (!cv || !cur) return;
  const W = cv.clientWidth; if (!W) { requestAnimationFrame(drawTimeline); return; }
  const small = W < 540;
  TL.LANE_H = small ? 38 : 52; TL.GAP = small ? 8 : 12; TL.RULER = small ? 16 : 20;
  const dpr = window.devicePixelRatio || 1;
  const H = TL.TOP + 3 * TL.LANE_H + 2 * TL.GAP + TL.RULER;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);

  const m = tlModel();
  if (cur.viewMs == null) { cur.viewStartT = m.tMin; cur.viewMs = m.total; }        // frame everything on first draw
  const innerW = W - 2 * TL.PADX;
  const pxPerMs = innerW / cur.viewMs;
  const xOf = T => TL.PADX + (T - cur.viewStartT) * pxPerMs;
  const yOut = TL.TOP, yVt = TL.TOP + TL.LANE_H + TL.GAP, yIn = TL.TOP + 2 * (TL.LANE_H + TL.GAP);

  for (const y of [yOut, yVt, yIn]) { g.fillStyle = "#0e1216"; roundRect(g, TL.PADX, y, innerW, TL.LANE_H, 6); g.fill(); }

  let outRect = null;
  if (m.out) {
    const ox = xOf(m.outStartT), ow = m.outDur * pxPerMs;
    drawBlock(g, ox, yOut, ow, TL.LANE_H, m.out.waveform, "#46525f", "#131a20", "rgba(255,255,255,.10)");
    g.fillStyle = "rgba(226,59,59,.12)"; g.fillRect(xOf(m.upT), yOut, (m.outEndT - m.upT) * pxPerMs, TL.LANE_H);
    vline(g, xOf(m.upT), yOut, TL.LANE_H, "#e23b3b");
    outRect = { x: ox, y: yOut, w: ow, h: TL.LANE_H };
  }
  let vtRect = null;
  if (m.vtDur > 0) {
    const x0 = xOf(m.vtStartT), w = m.vtDur * pxPerMs;
    drawBlock(g, x0, yVt, w, TL.LANE_H, peaksFromBuffer(cur.vtBuf), "#74d69a", "#16341f", "#2f7d4f");
    vtRect = { x: x0, y: yVt, w, h: TL.LANE_H };
  }
  let inRect = null;
  if (m.inc) {
    const x0 = xOf(m.inStartT), w = m.inDur * pxPerMs;
    drawBlock(g, x0, yIn, w, TL.LANE_H, m.inc.waveform, "#8ea3b8", "#141b22", "#3a444f");
    if (m.postT != null) {
      g.fillStyle = "rgba(199,149,16,.16)"; g.fillRect(xOf(m.inStartT), yIn, (m.postT - m.inStartT) * pxPerMs, TL.LANE_H);
      vline(g, xOf(m.postT), yIn, TL.LANE_H, "#c79510"); tlLabel(g, "POST", xOf(m.postT) + 4, yIn + 13, "#e8c874");
    }
    inRect = { x: x0, y: yIn, w, h: TL.LANE_H };
  }

  tlLabel(g, "OUT", TL.PADX + 5, yOut + 13, "#8b97a6");
  tlLabel(g, "VT", TL.PADX + 5, yVt + 13, "#8b97a6");
  tlLabel(g, "IN", TL.PADX + 5, yIn + 13, "#8b97a6");

  const rulerY = yIn + TL.LANE_H + 5;
  g.fillStyle = "#242c34"; g.fillRect(TL.PADX, rulerY, innerW, 1);
  const stepS = cur.viewMs > 60000 ? 15 : cur.viewMs > 30000 ? 10 : cur.viewMs > 12000 ? 5 : cur.viewMs > 5000 ? 2 : 1;
  for (let s = Math.ceil(cur.viewStartT / 1000 / stepS) * stepS; s * 1000 <= cur.viewStartT + cur.viewMs; s += stepS) {
    if (s < 0) continue;
    const x = xOf(s * 1000); if (x < TL.PADX - 1 || x > W - TL.PADX + 1) continue;
    g.fillStyle = "#2c343d"; g.fillRect(x, rulerY, 1, 4);
    g.fillStyle = "#6b7684"; g.font = "10px -apple-system, sans-serif"; g.fillText(s + "s", x + 2, rulerY + 14);
  }

  if (cur.playMs != null && cur.playMs >= cur.viewStartT && cur.playMs <= cur.viewStartT + cur.viewMs)
    vline(g, xOf(cur.playMs), TL.TOP, 3 * TL.LANE_H + 2 * TL.GAP, "#ffffff");

  cur.geo = { outRect, vtRect, inRect, pxPerMs };
}

function updateReadout() {
  if (!cur || !cur.session) return;
  const m = tlModel(), bits = [];
  if (m.out) bits.push(`Talk-up: ${((m.outEndT - m.vtStartT) / 1000).toFixed(1)}s of outro left when you start`);
  if (m.vtDur) bits.push(`VT ${(m.vtDur / 1000).toFixed(1)}s`);
  if (m.inc) bits.push(`next song at +${((m.inAtT - m.vtAtT) / 1000).toFixed(1)}s`);
  const post = introText(m.inc);
  $("introInfo").textContent = bits.join(" · ") + (post ? " · " + post : "");
}

function tlZoom(factor, anchorX) {
  if (!cur) return;
  if (cur.viewMs == null) drawTimeline();
  const cv = $("timeline"), W = cv.clientWidth, ax = anchorX == null ? W / 2 : anchorX;
  const pxPerMs = (W - 2 * TL.PADX) / cur.viewMs;
  const anchorT = cur.viewStartT + (ax - TL.PADX) / pxPerMs;
  const m = tlModel();
  cur.viewMs = clamp(cur.viewMs / factor, 500, Math.max(2000, m.total) * 4);
  const px2 = (W - 2 * TL.PADX) / cur.viewMs;
  cur.viewStartT = anchorT - (ax - TL.PADX) / px2;
  drawTimeline();
}

let tlDrag = null;
function tlXY(e) { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function tlHit(rect, x, y) { return rect && x >= rect.x - 7 && x <= rect.x + rect.w + 7 && y >= rect.y - 2 && y <= rect.y + rect.h + 2; }

(function wireTimeline() {
  const cv = $("timeline"); if (!cv) return;
  cv.addEventListener("wheel", e => { if (!cur) return; e.preventDefault(); tlZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, tlXY(e).x); }, { passive: false });
  cv.addEventListener("pointerdown", e => {
    if (!cur || !cur.geo) return;
    const { x, y } = tlXY(e);
    const t = tlHit(cur.geo.vtRect, x, y) ? "vt" : tlHit(cur.geo.outRect, x, y) ? "out" : tlHit(cur.geo.inRect, x, y) ? "in" : "pan";
    tlDrag = { t, moved: false, startX: x, pxPerMs: cur.geo.pxPerMs,
               origOut: cur.outAtT || 0, origVt: cur.vtAtT || 0, origIn: cur.inAtT || 0, origView: cur.viewStartT || 0 };
    cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing";
  });
  cv.addEventListener("pointermove", e => {
    if (!tlDrag) return;
    const x = tlXY(e).x, dxMs = (x - tlDrag.startX) / tlDrag.pxPerMs;
    if (Math.abs(x - tlDrag.startX) > 3) tlDrag.moved = true;
    if (tlDrag.t === "out") { cur.outAtT = Math.round(tlDrag.origOut + dxMs); updateReadout(); }
    else if (tlDrag.t === "vt") { cur.vtAtT = Math.round(tlDrag.origVt + dxMs); updateReadout(); }
    else if (tlDrag.t === "in") { cur.inAtT = Math.round(Math.max(cur.vtAtT || 0, tlDrag.origIn + dxMs)); updateReadout(); }
    else if (tlDrag.moved) { cur.viewStartT = tlDrag.origView - dxMs; }
    drawTimeline();
  });
  const end = e => {
    if (!tlDrag) return;
    if (tlDrag.t === "pan" && !tlDrag.moved && cur && cur.geo) {   // a click (no drag) → drop the playhead
      cur.playMs = cur.viewStartT + (tlXY(e).x - TL.PADX) / cur.geo.pxPerMs;
      if (cur.playing) previewFrom(cur.playMs); else drawTimeline();
    }
    tlDrag = null; cv.style.cursor = "grab";
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  $("tlIn").onclick = () => tlZoom(1.4);
  $("tlOut").onclick = () => tlZoom(1 / 1.4);
  $("tlFit").onclick = () => { if (cur) { const m = tlModel(); cur.viewStartT = m.tMin; cur.viewMs = m.total; drawTimeline(); } };
})();
window.addEventListener("resize", () => { if (cur && !$("editorHost").classList.contains("hidden")) drawTimeline(); });

// Boot
if (token) { ensureCtx(); afterLogin(); } else { show("loginView"); }
