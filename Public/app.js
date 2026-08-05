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
$("back").onclick = () => { const s = cur && cur.slotId; stopEverything(); show("logView"); loadLog(currentDate, s); };
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
    $("outTitle").textContent = ctxLabel(session.outgoing);
    $("inTitle").textContent = ctxLabel(session.incoming);
    $("introInfo").textContent = introText(session.incoming);
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
    cur.vtBuf = null; cur.wavBlob = null; cur.rightMs = 0;
    setPhase("recording"); $("submitBtn").disabled = true; $("editorMsg").textContent = "";
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
  const mf = $("meterFill"); if (mf) mf.style.width = "0";
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

// Audio setup (device pickers + live test)
$("audioBtn").onclick = openAudio;
$("audioClose").onclick = closeAudio;
$("testSpk").onclick = playTestTone;
$("micRetry").onclick = () => setupDevices(true);
$("inDevice").onchange = () => { inDeviceId = $("inDevice").value; localStorage.setItem("vt_in", inDeviceId); startMeter(); };
$("outDevice").onchange = () => { outDeviceId = $("outDevice").value; localStorage.setItem("vt_out", outDeviceId); applyOutput(); };
document.addEventListener("keydown", e => {
  if ($("editorView").classList.contains("hidden")) return;
  const k = e.key;
  if (k === "ArrowLeft") { auditionOutro(); e.preventDefault(); }
  else if (k === "ArrowUp") { startRecording(); e.preventDefault(); }
  else if (k === "ArrowRight") { markNext(); e.preventDefault(); }
  else if (k === "ArrowDown") { stopRecording(); e.preventDefault(); }
  else if (k === " ") { previewComposite(); e.preventDefault(); }
});

// ---------- Audio setup ----------
async function openAudio() { $("audioModal").classList.remove("hidden"); await setupDevices(true); }
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
  const start = el.cues.startMs || 0;
  const post = el.cues.introEndMs;
  if (post == null || post <= start) return "No instrumental intro — the vocal is right at the top; keep it tight.";
  return `Intro to the post: ${((post - start) / 1000).toFixed(1)}s — talk up to the yellow marker.`;
}

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
function redrawAll() {
  if (!cur) return;
  if (!$("outWave").clientWidth) { requestAnimationFrame(redrawAll); return; }
  const s = cur.session;
  const upFrac = s.outgoing && s.outgoing.snippetDurationMs ? (cur.upFileMs - s.outgoing.snippetStartMs) / s.outgoing.snippetDurationMs : null;
  drawWave($("outWave"), s.outgoing ? s.outgoing.waveform : [], upFrac);
  const inFrac = s.incoming && s.incoming.snippetDurationMs && s.incoming.cues && s.incoming.cues.introEndMs != null
    ? (s.incoming.cues.introEndMs - s.incoming.snippetStartMs) / s.incoming.snippetDurationMs : null;
  drawWave($("inWave"), s.incoming ? s.incoming.waveform : [], inFrac);
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
