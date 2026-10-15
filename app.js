// MFC Tracker web app: records the tracker over Web Bluetooth in the PC's session format
// (receiver/mfc/session.py) and runs the receiver's own processing on the same records in a
// worker (worker.js, Pyodide). The recording never waits for the processing.
"use strict";

const APP_VERSION = "2026.10.15-4a682e17";
const UUID = {
  nus: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  tx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",       // status text from the tracker
  rx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",       // commands to the tracker
  motionSvc: "b2e91400-2eae-4f5b-9f3c-1a2b3c4d5e6f",
  motion: "b2e91401-2eae-4f5b-9f3c-1a2b3c4d5e6f",   // binary frames
};
const T_MOTION = 1, T_TEXT = 2, T_EVENT = 3;
const MAGIC = [77, 70, 67, 82, 65, 87, 0];            // "MFCRAW\0", then u16 session format
const SESSION_FORMAT = 1, WIRE_FORMAT = 1;
const SAMPLE = { 1: 14, 2: 8, 4: 6, 8: 6 };            // bytes per sample: IMU, MAG, FSR, BATT
const FLUSH_MS = 1000;                                 // a crash or closed tab loses at most this
const FEED_MS = 100;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();

// ---------------------------------------------------------------- small helpers
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function pad(n, w = 2) { return String(n).padStart(w, "0"); }
function stampOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function timeOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function mmss(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; }
function fmt(v, d = 0) { return v === null || v === undefined || !isFinite(v) ? "-" : Number(v).toFixed(d); }
function toast(text, ms = 3500) {
  const t = $("toast");
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.style.display = "none"; }, ms);
}
const logLines = [];
function log(line) {
  const d = new Date();
  logLines.push(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  ${line}`);
  if (logLines.length > 1500) logLines.splice(0, logLines.length - 1500);
  if (currentTab === "log") $("log").textContent = logLines.join("\n");
}
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------------------------------------------------------------- storage (IndexedDB)
const DB = {
  db: null,
  open() {
    return new Promise((ok, bad) => {
      const r = indexedDB.open("mfc-web", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("sessions", { keyPath: "id" });
        d.createObjectStore("chunks");
        d.createObjectStore("kv");
      };
      r.onsuccess = () => { this.db = r.result; ok(); };
      r.onerror = () => bad(r.error);
    });
  },
  _tx(store, mode, fn) {
    return new Promise((ok, bad) => {
      const t = this.db.transaction(store, mode);
      let out;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => ok(out);
      t.onerror = () => bad(t.error);
      t.onabort = () => bad(t.error);
    });
  },
  put(store, value, key) { return this._tx(store, "readwrite", (s) => s.put(value, key)); },
  get(store, key) { return this._tx(store, "readonly", (s) => s.get(key)); },
  del(store, key) { return this._tx(store, "readwrite", (s) => s.delete(key)); },
  all(store) { return this._tx(store, "readonly", (s) => s.getAll()); },
  chunks(id) {
    return this._tx("chunks", "readonly", (s) => s.getAll(IDBKeyRange.bound(id + "/", id + "/￿")));
  },
  delChunks(id) {
    return this._tx("chunks", "readwrite", (s) => s.delete(IDBKeyRange.bound(id + "/", id + "/￿")));
  },
};
const KV = {
  get(k) { return DB.get("kv", k); },
  set(k, v) { return DB.put("kv", v, k); },
};

// ---------------------------------------------------------------- the session recorder
// Records [type u8][t f64][len u32][payload], t in seconds from the session start, exactly as
// SessionWriter. Every record also goes to the worker, in the same order: a button's event is
// written before the next notification, so the worker (and a PC replay) acts on it there.
class Recorder {
  constructor({ id, cal, note, persist, versions }) {
    this.id = id;
    this.persist = persist;
    this.t0 = performance.now();
    this.started = timeOf(new Date());
    this.note = note || "";
    this.calStart = cal ? JSON.parse(cal) : null;
    this.calEnd = null;
    this.counts = { motion: 0, text: 0, events: 0 };
    this.bytes = 0;
    this.lastT = 0;
    this.idx = 0;
    this.versions = versions || null;
    this.status = null;
    this.ended = null;
    this.parts = [new Uint8Array([...MAGIC, SESSION_FORMAT & 0xff, SESSION_FORMAT >> 8])];
    this.feed = [];
    this.flushing = false;
  }
  clock() { return (performance.now() - this.t0) / 1000; }
  record(kind, payload, t) {
    if (this.ended) return;
    t = t === undefined ? this.clock() : t;
    const rec = new Uint8Array(13 + payload.length);
    const v = new DataView(rec.buffer);
    v.setUint8(0, kind);
    v.setFloat64(1, t, true);
    v.setUint32(9, payload.length, true);
    rec.set(payload, 13);
    this.parts.push(rec);
    this.feed.push(rec);
    this.counts[kind === T_MOTION ? "motion" : kind === T_TEXT ? "text" : "events"] += 1;
    this.bytes += payload.length;
    this.lastT = t;
  }
  event(name) { this.record(T_EVENT, enc.encode(name)); }
  takeFeed() {
    if (!this.feed.length) return null;
    const out = concat(this.feed);
    this.feed = [];
    return out;
  }
  meta() {
    return {
      id: this.id, started: this.started, ended: this.ended, duration_s: Math.round(this.lastT * 1000) / 1000,
      counts: this.counts, payload_bytes: this.bytes, note: this.note, calibration_start: this.calStart,
      calibration_end: this.calEnd, status: this.status, versions: this.versions,
      link: { dropped: decoder.dropped, imu_gaps: decoder.gaps, short_notifications: decoder.short },
      uploaded: null, chunks: this.idx,
    };
  }
  async flush() {
    if (!this.persist || this.flushing) return;
    this.flushing = true;
    try {
      if (this.parts.length) {
        const chunk = concat(this.parts);
        this.parts = [];
        const idx = this.idx++;
        await DB.put("chunks", chunk.buffer, `${this.id}/${pad(idx, 6)}`);
      }
      const prev = await DB.get("sessions", this.id);
      const m = this.meta();
      if (prev && prev.uploaded) m.uploaded = prev.uploaded;
      if (prev && prev.name) m.name = prev.name;
      await DB.put("sessions", m);
    } catch (err) {
      log("[store] could not save: " + err);
      toast("Could not save the session to this device: " + err);
    } finally {
      this.flushing = false;
    }
  }
  async end() {
    if (this.ended) return;
    this.ended = timeOf(new Date());
    while (this.flushing) await new Promise((r) => setTimeout(r, 20));
    await this.flush();
  }
}

// The sidecar the PC reads (session.read_sidecar), as SessionWriter writes it, plus where it came from.
function sidecarOf(m) {
  return {
    session_format: SESSION_FORMAT, wire_format: WIRE_FORMAT,
    receiver_version: (m.versions && m.versions.receiver) || null,
    started: m.started, ended: m.ended, duration_s: m.duration_s,
    records: { motion: m.counts.motion, text: m.counts.text, events: m.counts.events },
    payload_bytes: m.payload_bytes, note: m.note || "",
    calibration_start: m.calibration_start, calibration_end: m.calibration_end, status: m.status,
    source: "tablet",
    web: { page: APP_VERSION, versions: m.versions, link: m.link, user_agent: navigator.userAgent,
      interrupted: !m.ended },
  };
}

async function sessionBytes(id) {
  const chunks = await DB.chunks(id);
  return concat(chunks.map((c) => new Uint8Array(c)));
}

// ---------------------------------------------------------------- decoding for the display
// A light copy of wire.FrameDecoder: only what the screen shows and the link health. The
// processing decodes the same bytes again in Python.
class JsDecoder {
  constructor() { this.reset(); }
  reset() {
    this.buf = new Uint8Array(0);
    this.lastSeq = {};
    this.dropped = 0;
    this.gaps = 0;
    this.short = 0;
    this.frames = 0;
    this.counts = { 1: 0, 2: 0, 4: 0, 8: 0 };
    this.rates = { 1: 0, 2: 0, 4: 0, 8: 0 };
    this.tStats = performance.now();
    this.batt = null;
    this.fsr = null;
    this.gyro = [];                 // [ms, |gyro| dps]
    this.lastImuUs = null;
  }
  feed(u8) {
    if (u8.length === 20) this.short += 1;       // a 23 B MTU cuts a 244 B notification to 20
    const b = new Uint8Array(this.buf.length + u8.length);
    b.set(this.buf);
    b.set(u8, this.buf.length);
    let off = 0;
    while (b.length - off >= 9) {
      const count = b[off + 5], flags = b[off + 8];
      const stride = SAMPLE[flags];
      if (!stride || !count) { off += 1; continue; }
      const n = 9 + count * stride;
      if (b.length - off < n) break;
      this.parse(new DataView(b.buffer, off, n), count, flags);
      off += n;
    }
    this.buf = b.slice(off);
  }
  parse(v, count, flags) {
    this.frames += 1;
    const base = v.getUint32(0, true), seq = v.getUint8(4);
    const prev = this.lastSeq[flags];
    if (prev !== undefined) {
      const gap = (seq - prev + 256) % 256;
      if (gap > 1) this.dropped += gap - 1;
    }
    this.lastSeq[flags] = seq;
    const size = SAMPLE[flags];
    for (let k = 0, o = 9; k < count; k++, o += size) {
      const dt = v.getUint16(o, true);
      if (flags === 1) {
        const us = (base + dt) >>> 0;
        if (this.lastImuUs !== null) {
          const d = (us - this.lastImuUs) >>> 0;
          if (d > 50000 && d < 0x80000000) this.gaps += 1;
        }
        this.lastImuUs = us;
        if (k === count - 1) {
          const gx = v.getInt16(o + 8, true), gy = v.getInt16(o + 10, true), gz = v.getInt16(o + 12, true);
          this.gyro.push([performance.now(), 0.035 * Math.hypot(gx, gy, gz)]);
        }
      } else if (flags === 4) {
        this.fsr = [v.getUint16(o + 2, true), v.getUint16(o + 4, true)];
      } else if (flags === 8) {
        this.batt = { pct: v.getUint8(o + 2), mv: v.getUint16(o + 3, true), src: v.getUint8(o + 5) };
      }
    }
    this.counts[flags] += count;
    const cut = performance.now() - 5000;
    while (this.gyro.length && this.gyro[0][0] < cut) this.gyro.shift();
  }
  tick() {
    const now = performance.now(), el = (now - this.tStats) / 1000;
    if (el < 1) return;
    for (const f in this.rates) { this.rates[f] = this.counts[f] / el; this.counts[f] = 0; }
    this.tStats = now;
  }
}
const decoder = new JsDecoder();

// ---------------------------------------------------------------- the processing worker
const py = {
  worker: null, ready: false, versions: null, fatal: null, started: false,
  fedUpto: 0, busy: false, statePending: false, state: null, pendingOpen: new Map(), nextId: 1, lastMs: 0,
};

function startWorker() {
  py.worker = new Worker("worker.js");
  py.worker.onmessage = (e) => onWorker(e.data);
  py.worker.onerror = (e) => { py.fatal = String(e.message || e); showPy(); };
  py.worker.postMessage({ type: "init" });
}

function onWorker(m) {
  if (m.type === "progress") { $("py").textContent = "Python: " + m.text; log("[python] " + m.text); }
  else if (m.type === "ready") {
    py.ready = true;
    py.versions = m.versions;
    log(`[python] ready: receiver ${m.versions.receiver}, Python ${m.versions.python}, numpy ${m.versions.numpy}`);
    showVersions();
    if (rec && !rec.versions) rec.versions = m.versions;
    if (rec && !py.started) startLive();
    showPy();
  } else if (m.type === "fatal") {
    py.fatal = m.text;
    log("[python] could not start: " + m.text);
    showPy();
  } else if (m.type === "fed") {
    py.busy = false;
    py.fedUpto = m.upto;
    py.lastMs = m.ms;
  } else if (m.type === "state") {
    py.statePending = false;
    py.state = JSON.parse(m.json);
    for (const line of py.state.log || []) log(line);
    showState();
  } else if (m.type === "result") {
    const w = JSON.parse(m.json);
    addWalk(w, rec ? (rec.persist ? "live" : "demo") : "live", rec ? rec.id : "");
    toast(`G run done: ${w.steps.length} step${w.steps.length === 1 ? "" : "s"}`);
  } else if (m.type === "cal") {
    if (rec && rec.persist) {
      saveCal(m.text, "calibrated on this device " + timeOf(new Date()));
      rec.calEnd = JSON.parse(m.text);
      log("[cal] the calibration changed and was kept on this device");
    }
  } else if (m.type === "status" || m.type === "opened" || m.type === "records" || m.type === "error") {
    const p = py.pendingOpen.get(m.id);
    if (m.type === "error") {
      log("[python] " + m.text);
      if (p) { py.pendingOpen.delete(m.id); p.bad(new Error(m.text)); }
      else { py.busy = false; py.statePending = false; }
      return;
    }
    if (p) { py.pendingOpen.delete(m.id); p.ok(m); }
  }
}

function askWorker(msg, transfer) {
  return new Promise((ok, bad) => {
    const id = py.nextId++;
    py.pendingOpen.set(id, { ok, bad });
    py.worker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
}

function startLive() {
  if (!py.ready || !rec) return;
  py.started = true;
  py.fedUpto = 0;
  py.state = null;
  // the step count reaches the processing only through the "steps=N" event written before each
  // G, so the live result and a PC replay of the session cannot differ
  py.worker.postMessage({ type: "start", cal: rec.calStart ? JSON.stringify(rec.calStart) : "" });
}

function pump() {
  if (!rec || !py.ready || !py.started || py.busy) return;
  const buf = rec.takeFeed();
  if (!buf) return;
  py.busy = true;
  py.worker.postMessage({ type: "feed", buf: buf.buffer, upto: rec.lastT }, [buf.buffer]);
}

function showPy() {
  const el = $("py");
  if (py.fatal) { el.className = "chip bad"; el.textContent = "Python failed: recording still works"; $("st-py").textContent = py.fatal; return; }
  if (!py.ready) { el.className = "chip"; return; }
  if (!rec) { el.className = "chip ok"; el.textContent = "Python ready"; $("st-py").textContent = "ready"; return; }
  const behind = rec.lastT - py.fedUpto;
  if (behind > 1.5) { el.className = "chip warn"; el.textContent = `Python ${behind.toFixed(1)} s behind`; }
  else { el.className = "chip ok"; el.textContent = "Python live"; }
  $("st-py").textContent = `${behind > 0 ? behind.toFixed(1) : "0.0"} s behind, last batch ${py.lastMs.toFixed(0)} ms`;
}

// ---------------------------------------------------------------- Bluetooth
const link = { device: null, server: null, rx: null, state: "off", wantConnected: false, demo: null };
let rec = null;
let stepsN = 3;

async function connect() {
  if (!navigator.bluetooth) {
    toast("This browser has no Web Bluetooth: use Chrome on Android, Windows or macOS.", 6000);
    return;
  }
  if (link.demo) stopDemo();
  try {
    link.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "MFC" }, { services: [UUID.nus] }],
      optionalServices: [UUID.nus, UUID.motionSvc],
    });
  } catch (err) {
    if (err.name !== "NotFoundError") toast("Bluetooth: " + err.message);
    return;
  }
  link.device.addEventListener("gattserverdisconnected", onDisconnected);
  link.wantConnected = true;
  await openLink();
}

async function openLink() {
  setLink("connecting");
  try {
    link.server = await link.device.gatt.connect();
    const nus = await link.server.getPrimaryService(UUID.nus);
    const tx = await nus.getCharacteristic(UUID.tx);
    link.rx = await nus.getCharacteristic(UUID.rx);
    const ms = await link.server.getPrimaryService(UUID.motionSvc);
    const motion = await ms.getCharacteristic(UUID.motion);
    if (!rec) await newSession();
    tx.oncharacteristicvaluechanged = (e) => onText(new Uint8Array(e.target.value.buffer.slice(0)));
    motion.oncharacteristicvaluechanged = (e) => onMotion(new Uint8Array(e.target.value.buffer.slice(0)));
    await tx.startNotifications();
    await motion.startNotifications();
    await send("HELLO tablet");     // the stomp calibration's event lines come to this role
    setLink("connected");
    log(`[ble] connected to ${link.device.name}`);
    keepAwake();
  } catch (err) {
    log("[ble] connect failed: " + err);
    setLink("failed");
    if (link.wantConnected) setTimeout(() => { if (link.wantConnected && link.state !== "connected") openLink(); }, 2000);
  }
}

function onDisconnected() {
  log("[ble] link lost");
  setLink("reconnecting");
  if (link.wantConnected) setTimeout(() => { if (link.wantConnected) openLink(); }, 500);
  else setLink("off");
}

async function disconnect() {
  link.wantConnected = false;
  try { if (link.device && link.device.gatt.connected) link.device.gatt.disconnect(); } catch (_) { /* gone */ }
  setLink("off");
}

async function send(line) {
  if (!link.rx) return;
  const data = enc.encode(line + "\n");
  try {
    if (link.rx.writeValueWithResponse) await link.rx.writeValueWithResponse(data);
    else await link.rx.writeValue(data);
    log("> " + line);
  } catch (err) {
    log("[ble] could not send " + line + ": " + err);
  }
}

function onMotion(u8) {
  if (!rec) return;
  decoder.feed(u8);
  rec.record(T_MOTION, u8);
}

let textLine = "";
function onText(u8) {
  if (!rec) return;
  rec.record(T_TEXT, u8);
  textLine += dec.decode(u8);
  let i;
  while ((i = textLine.indexOf("\n")) >= 0) {
    const line = textLine.slice(0, i).trim();
    textLine = textLine.slice(i + 1);
    if (line) onLine(line);
  }
}

function onLine(line) {
  if (line.startsWith("EVT:batt")) return;
  log("< " + line);
  if (line.startsWith("EVT:sync")) {
    const p = line.split(" ");
    if (p[1] === "stomp") toast(`Stomp ${p[2]} seen`, 1500);
    else if (p[1] === "done") { syncRunning = false; toast(`Sync done: latency ${(Number(p[2]) / 1000).toFixed(1)} ms from ${p[3]} stomps. It applies from the next connection.`, 8000); }
    else if (p[1] === "fail") { syncRunning = false; toast("Sync failed: " + p.slice(2).join(" "), 6000); }
    else if (p[1] === "skip") toast("Stomp skipped: " + p.slice(2).join(" "), 2500);
    showButtons();
  } else if (line.startsWith("ERR:")) {
    toast("Tracker: " + line.slice(4), 5000);
  } else if (line.startsWith("INFO:")) {
    toast(line, 9000);
  }
}

function setLink(state) {
  link.state = state;
  const el = $("link");
  el.textContent = state === "connected" ? (link.device ? link.device.name : "connected") : state;
  el.className = "chip " + (state === "connected" ? "ok" : state === "off" ? "" : state === "failed" ? "bad" : "warn");
  $("connect").textContent = state === "off" || state === "failed" ? "Connect" : "Disconnect";
  showButtons();
}

let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (_) { /* not allowed now: tried again when the page is visible */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (link.state === "connected" || link.demo)) keepAwake();
  if (document.visibilityState === "hidden" && rec) rec.flush();
});
window.addEventListener("pagehide", () => { if (rec) rec.flush(); });

// ---------------------------------------------------------------- sessions
async function newSession({ persist = true, cal = null, note = null, idHint = null } = {}) {
  let id = idHint || stampOf(new Date());
  if (persist) {
    let n = 1;
    const base = id;
    while (await DB.get("sessions", id)) { n += 1; id = `${base}_${n}`; }
  }
  rec = new Recorder({ id, cal: cal !== null ? cal : await currentCal(), note: note !== null ? note : $("note").value,
    persist, versions: py.versions });
  decoder.reset();
  py.started = false;
  if (py.ready) startLive();
  if (persist) { await rec.flush(); log(`[session] recording ${id}`); }
  showButtons();
}

async function endSession() {
  if (!rec) return;
  const r = rec;
  if (py.ready && py.started) {
    try { r.status = JSON.parse((await askWorker({ type: "status" })).json); } catch (_) { /* keep null */ }
  }
  if (r.persist) {
    r.calEnd = r.calEnd || JSON.parse((await currentCal()) || "null");
    await r.end();
    log(`[session] ${r.id} saved: ${r.counts.motion} notifications, ${mmss(r.lastT)}`);
    toast(`Session ${r.id} saved`);
  }
  rec = null;
  py.started = false;
  showButtons();
  renderSessions();
}

async function renderSessions() {
  const list = (await DB.all("sessions")).sort((a, b) => (a.id < b.id ? 1 : -1));
  const box = $("sessions");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<p class="muted">No sessions yet.</p>'; return; }
  for (const m of list) {
    const live = rec && rec.id === m.id && rec.persist;
    const div = document.createElement("div");
    div.className = "sess";
    const kb = Math.round(m.payload_bytes / 1024);
    div.innerHTML = `<div class="name"></div><div class="meta"></div><div class="btns"></div>`;
    div.querySelector(".name").textContent = (m.name ? m.name + "  " : "") + m.id + (live ? "  (recording)" : !m.ended ? "  (interrupted)" : "");
    div.querySelector(".meta").textContent = `${mmss(m.duration_s)}, ${kb} KB, ${m.counts.events} events, dropped ${m.link ? m.link.dropped : "-"}` +
      (m.note ? `, ${m.note}` : "") + (m.uploaded ? `, uploaded ${m.uploaded}` : "");
    const btns = div.querySelector(".btns");
    const add = (label, fn, cls = "") => {
      const b = document.createElement("button");
      b.className = "btn small " + cls;
      b.textContent = label;
      b.onclick = fn;
      b.disabled = live;
      btns.appendChild(b);
    };
    add("Open", () => openStored(m.id, false));
    add("Open, every step", () => openStored(m.id, true));
    add("Play", () => playStored(m.id));
    add("Rename", () => renameSession(m.id));
    add("Download", () => downloadSession(m.id));
    add("Upload", () => uploadSession(m.id));
    add("Delete", () => deleteSession(m.id), "danger");
    box.appendChild(div);
  }
}

async function storedFiles(id) {
  const m = await DB.get("sessions", id);
  const data = await sessionBytes(id);
  return { m, data, sidecar: JSON.stringify(sidecarOf(m), null, 1) };
}

async function openStored(id, armAll) {
  const { data, sidecar } = await storedFiles(id);
  await openBytes(id, data, sidecar, armAll);
}

async function openBytes(label, data, sidecar, armAll) {
  if (!py.ready) { toast("Python is not ready yet"); return; }
  toast(`Replaying ${label}...`, 20000);
  try {
    const buf = data.slice().buffer;
    const r = await askWorker({ type: "open", data: buf, sidecar, armAll }, [buf]);
    const o = JSON.parse(r.json);
    for (const line of o.log) log(line);
    if (!o.walks.length) { toast(`${label}: no G run in it` + (armAll ? "" : " (try Open, every step)"), 6000); return; }
    for (const w of o.walks) addWalk(w, armAll ? "replay, every step" : "replay", label);
    toast(`${label}: ${o.walks.length} run${o.walks.length === 1 ? "" : "s"}`);
    showTab("results");
  } catch (err) {
    toast("Could not replay: " + err.message, 8000);
  }
}

async function renameSession(id) {
  const m = await DB.get("sessions", id);
  const name = prompt("Name (kept in the note; the file keeps its time stamp)", m.name || "");
  if (name === null) return;
  m.name = name.trim();
  if (m.name && !(m.note || "").includes(m.name)) m.note = m.note ? `${m.name}: ${m.note}` : m.name;
  await DB.put("sessions", m);
  renderSessions();
}

function saveBlob(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function downloadSession(id) {
  const { data, sidecar } = await storedFiles(id);
  saveBlob(id + ".mfcraw", new Blob([data], { type: "application/octet-stream" }));
  setTimeout(() => saveBlob(id + ".mfcraw.json", new Blob([sidecar], { type: "application/json" })), 600);
}

async function deleteSession(id) {
  if (!confirm(`Delete ${id} from this device? This cannot be undone.`)) return;
  await DB.delChunks(id);
  await DB.del("sessions", id);
  renderSessions();
}

// GitHub: the Contents API commits the session file and its sidecar into the repository.
function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function gh(path, opts = {}) {
  const c = await KV.get("github") || {};
  if (!c.repo || !c.token) throw new Error("set the repository and token in Settings first");
  const r = await fetch(`https://api.github.com/repos/${c.repo}/${path}`, Object.assign({
    headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github+json" },
  }, opts));
  return { r, c };
}
async function ghPut(file, u8, message) {
  const c = await KV.get("github") || {};
  const branch = c.branch || "main";
  const path = `${(c.dir || "sessions").replace(/^\/+|\/+$/g, "")}/${file}`;
  let sha;
  const head = await gh(`contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${branch}`);
  if (head.r.ok) sha = (await head.r.json()).sha;
  const body = { message, content: b64(u8), branch };
  if (sha) body.sha = sha;
  const put = await gh(`contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  });
  if (!put.r.ok) throw new Error(`${put.r.status} ${(await put.r.json().catch(() => ({}))).message || ""}`);
}
async function uploadSession(id) {
  try {
    const { m, data, sidecar } = await storedFiles(id);
    toast(`Uploading ${id}...`, 30000);
    await ghPut(id + ".mfcraw", data, `tablet session ${id}${m.note ? ": " + m.note : ""}`);
    await ghPut(id + ".mfcraw.json", enc.encode(sidecar), `tablet session ${id} (sidecar)`);
    m.uploaded = timeOf(new Date());
    await DB.put("sessions", m);
    toast(`${id} uploaded. On the PC: git pull, then python tools/import_tablet.py`, 7000);
    renderSessions();
  } catch (err) {
    toast("Upload failed: " + err.message, 8000);
  }
}

// ---------------------------------------------------------------- demo playback
// A saved session fed through the live path at its own pace, for trying the page without the
// tracker. Nothing is saved, and the device's calibration is left alone.
async function playStored(id) {
  const { m, data } = await storedFiles(id);
  await playBytes(id, data, m.calibration_start);
}

async function playBytes(label, data, calStart) {
  if (!py.ready) { toast("Python is not ready yet"); return; }
  if (link.state === "connected") { toast("Disconnect from the tracker first"); return; }
  if (rec && rec.persist) await endSession();
  const buf = data.slice().buffer;
  const r = await askWorker({ type: "records", data: buf }, [buf]);
  const s = new Uint8Array(r.buf), v = new DataView(r.buf);
  const recs = [];
  for (let o = 0; o + 13 <= s.length;) {
    const kind = v.getUint8(o), t = v.getFloat64(o + 1, true), n = v.getUint32(o + 9, true);
    recs.push([kind, t, s.subarray(o + 13, o + 13 + n)]);
    o += 13 + n;
  }
  await newSession({ persist: false, cal: calStart ? JSON.stringify(calStart) : "", note: "demo", idHint: "demo " + label });
  const speed = Number(new URLSearchParams(location.search).get("speed") || 1);
  const t0 = performance.now();
  let k = 0;
  link.demo = { label, total: recs.length ? recs[recs.length - 1][1] : 0 };
  setLink("demo: " + label);
  keepAwake();
  link.demo.timer = setInterval(() => {
    const now = (performance.now() - t0) / 1000 * speed;
    while (k < recs.length && recs[k][1] <= now) {
      const [kind, t, p] = recs[k++];
      if (kind === T_MOTION) decoder.feed(p);
      rec.record(kind, p, t);
      if (kind === T_TEXT) { const line = dec.decode(p).trim(); if (line && !line.startsWith("EVT:batt")) log("< " + line); }
      if (kind === T_EVENT) log("[demo] event " + dec.decode(p));
    }
    if (k >= recs.length) {
      clearInterval(link.demo.timer);
      log(`[demo] ${label} finished`);
      const wait = setInterval(() => {
        if (!rec || py.fedUpto >= rec.lastT || py.fatal) { clearInterval(wait); stopDemo(); }
      }, 200);
    }
  }, 50);
  showTab("live");
}

function stopDemo() {
  if (!link.demo) return;
  clearInterval(link.demo.timer);
  link.demo = null;
  rec = null;
  py.started = false;
  setLink("off");
}

// ---------------------------------------------------------------- calibration
let bundledCal = "";
async function currentCal() {
  const c = await KV.get("cal");
  return c ? c.text : bundledCal;
}
async function saveCal(text, source) {
  await KV.set("cal", { text, source });
  showCal();
}
async function showCal() {
  const c = await KV.get("cal");
  $("cal-src").textContent = c ? c.source : (bundledCal ? "bundled with the page (the PC's)" : "none: run C, U, T and I");
}

// ---------------------------------------------------------------- results
const walks = [];
function addWalk(w, how, session) {
  walks.push({ w, how, session, at: new Date() });
  const sel = $("walk-pick");
  const o = document.createElement("option");
  o.value = String(walks.length - 1);
  o.textContent = `${session}  ${how}  run ${w.id}: ${w.steps.length} steps`;
  sel.appendChild(o);
  sel.value = o.value;
  showWalk(walks.length - 1);
}

function showWalk(i) {
  const item = walks[i];
  if (!item) return;
  const w = item.w;
  const lengths = w.steps.map((s) => s.stride_m).filter((x) => x !== null);
  $("walk-info").textContent = `${w.steps.length} steps, method ${w.method}` +
    (lengths.length ? `, mean length ${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(2)} m` : "");
  const head = "<tr><th>step</th><th>length m</th><th>MFC mm</th><th>toe max mm</th><th>foot max mm</th><th>swing s</th><th>turn deg</th><th class='l'>lands</th><th class='l'>flags</th></tr>";
  const rows = w.steps.map((s, k) => `<tr><td>${k + 1}</td><td>${fmt(s.stride_m, 2)}</td><td>${fmt(s.mfc_m * 1000)}</td>` +
    `<td>${fmt(s.peak_toe_m * 1000)}</td><td>${fmt(s.foot_max_mm)}</td><td>${fmt(s.swing_s, 2)}</td>` +
    `<td>${s.turn_deg === null ? "-" : (s.turn_deg > 0 ? "+" : "") + fmt(s.turn_deg)}</td><td class="l">${s.lands || "-"}</td>` +
    `<td class="l" title="${(s.flags || []).join("; ").replace(/"/g, "&quot;")}">${(s.short_flags || []).join(", ") || "-"}</td></tr>`);
  $("step-table").innerHTML = head + rows.join("");
  $("summary").textContent = w.readout.summary.slice(1).join("\n");       // [0] is the title the card has
  $("timeline").textContent = w.readout.timeline.slice(1).join("\n");
  drawTop(w);
  drawHeight(w);
}

function canvasCtx(c) {
  // null while the canvas is not on screen (a hidden tab): drawn again when it is shown
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight || Number(c.getAttribute("height"));
  if (!(w > 20 && h > 20)) return null;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function drawTop(walk) {
  const cv = canvasCtx($("top"));
  if (!cv) return;
  const { g, w, h } = cv;
  const ch = walk.chain, pts = ch.heel.concat(ch.toe);
  if (!pts.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const m = 28, span = Math.max(x1 - x0, y1 - y0, 0.3);
  const s = Math.min((w - 2 * m) / Math.max(x1 - x0, 0.3), (h - 2 * m) / Math.max(y1 - y0, 0.3));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const X = (x) => w / 2 + (x - cx) * s, Y = (y) => h / 2 - (y - cy) * s;
  // a 0.5 m grid
  g.strokeStyle = css("--line"); g.lineWidth = 1; g.fillStyle = css("--muted"); g.font = "11px system-ui";
  const step = span > 6 ? 1 : 0.5;
  for (let gx = Math.ceil((cx - w / 2 / s) / step) * step, k = 0; X(gx) < w && k < 200; gx += step, k++) {
    g.beginPath(); g.moveTo(X(gx), 0); g.lineTo(X(gx), h); g.stroke();
  }
  for (let gy = Math.ceil((cy - h / 2 / s) / step) * step, k = 0; Y(gy) > 0 && k < 200; gy += step, k++) {
    g.beginPath(); g.moveTo(0, Y(gy)); g.lineTo(w, Y(gy)); g.stroke();
  }
  g.fillText(`grid ${step} m`, 6, h - 6);
  const trail = (arr, color) => {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    arr.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))));
    g.stroke();
  };
  trail(ch.heel, css("--heel"));
  trail(ch.toe, css("--toe"));
  g.fillStyle = css("--ink");
  (ch.mfc_pts || []).forEach((p, k) => {
    g.beginPath(); g.arc(X(p[0]), Y(p[1]), 4, 0, 2 * Math.PI); g.fill();
    g.fillText(String(k + 1), X(p[0]) + 6, Y(p[1]) - 6);
  });
  g.fillStyle = css("--ok");
  const a = ch.heel[0];
  g.beginPath(); g.arc(X(a[0]), Y(a[1]), 5, 0, 2 * Math.PI); g.fill();
  g.fillText("start", X(a[0]) + 7, Y(a[1]) + 14);
}

function drawHeight(walk) {
  const cv = canvasCtx($("height"));
  if (!cv) return;
  const { g, w, h } = cv;
  const ch = walk.chain, t = ch.t;
  if (!t.length) return;
  const m = { l: 40, r: 10, t: 10, b: 24 };
  let z1 = 0.05;
  for (const p of ch.heel.concat(ch.toe)) z1 = Math.max(z1, p[2]);
  const t0 = t[0], t1 = t[t.length - 1];
  const X = (x) => m.l + (x - t0) / Math.max(t1 - t0, 1e-6) * (w - m.l - m.r);
  const Y = (z) => h - m.b - (z / (z1 * 1.08)) * (h - m.t - m.b);
  g.strokeStyle = css("--line"); g.fillStyle = css("--muted"); g.font = "11px system-ui"; g.lineWidth = 1;
  const zStep = z1 > 0.3 ? 0.1 : 0.05;
  for (let z = 0, k = 0; z <= z1 * 1.08 && k < 100; z += zStep, k++) {
    g.beginPath(); g.moveTo(m.l, Y(z)); g.lineTo(w - m.r, Y(z)); g.stroke();
    g.fillText(String(Math.round(z * 1000)), 4, Y(z) + 4);
  }
  const tStep = Math.max(1, Math.ceil((t1 - t0) / 20));
  for (let s = Math.ceil(t0); s <= t1; s += tStep) g.fillText(String(Math.round(s - t0)), X(s) - 3, h - 6);
  const line = (arr, color) => {
    g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
    arr.forEach((p, i) => (i ? g.lineTo(X(t[i]), Y(p[2])) : g.moveTo(X(t[i]), Y(p[2]))));
    g.stroke();
  };
  line(ch.heel, css("--heel"));
  line(ch.toe, css("--toe"));
  // MFC: the lowest toe point of each swing, at the time of the toe sample nearest the MFC point
  g.fillStyle = css("--ink");
  (ch.mfc_pts || []).forEach((p) => {
    let best = 0, d = Infinity;
    for (let i = 0; i < ch.toe.length; i++) {
      const q = ch.toe[i], e = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      if (e < d) { d = e; best = i; }
    }
    g.beginPath(); g.arc(X(t[best]), Y(p[2]), 4, 0, 2 * Math.PI); g.fill();
    g.fillText(`${Math.round(p[2] * 1000)}`, X(t[best]) + 6, Y(p[2]) - 6);
  });
}

// ---------------------------------------------------------------- the live view
function showState() {
  const s = py.state;
  if (!s) return;
  $("stance").textContent = s.fsr_cal_ok ? (s.stance || "-") : "no FSR levels";
  if (s.fsr_on) {
    for (const [k, i] of [["toe", 0], ["heel", 1]]) {
      const on = s.fsr_on[i], el = $("on-" + k);
      if (on !== null && on !== undefined) { el.style.display = "block"; el.style.left = `${Math.min(100, on / 65535 * 100)}%`; }
    }
  }
  $("att").textContent = s.attitude ? `${fmt(s.attitude.roll, 1)} / ${fmt(s.attitude.pitch, 1)} deg` : "-";
  $("step-status").textContent = s.step ? `${s.step.state}: ${s.step.done} of ${s.step.target} steps` : "-";
  const st = s.status || {};
  $("st-ring").textContent = st.ring || "no report yet";
  $("st-sync").textContent = st.sync_us === null || st.sync_us === undefined ? "not calibrated" :
    `${(st.sync_us / 1000).toFixed(1)} ms (${st.sync_n} stomps, sd ${(st.sync_sd_us / 1000).toFixed(1)} ms)`;
  $("st-filt").textContent = st.filters ? `accel ${st.filters.accel}, gyro ${st.filters.gyro}, mag ${st.filters.mag} Hz` : "-";
  $("st-fifo").textContent = st.fifo ? `ovr ${st.fifo.ovr}, drop ${st.fifo.drop}` : "-";
  if (s.error) { $("st-py").textContent = "error: " + s.error; $("st-py").classList.add("bad-text"); }
  showG(s);
  showPrompt();
}

// The G button says what a tap will do: three taps in a row once armed, cancelled and armed again
// (session 2026-10-15_144751).
function showG(s) {
  const st = s && s.step ? s.step : null;
  let label = "G  Record steps", sub = "foot flat first; tap again to stop early";
  if (st && st.pending) { label = "G  Waits for R"; sub = "arms by itself when R has finished"; }
  else if (st && st.state === "armed") { label = `G  Armed: ${st.target} steps`; sub = "walk now; tap to cancel"; }
  else if (st && st.state === "recording") { label = `G  Step ${st.done + 1} of ${st.target}`; sub = "tap to stop early and keep the steps done"; }
  const b = $("act-g");
  b.querySelector("b").textContent = label;
  b.querySelector("span").textContent = sub;
}

function showPrompt() {
  const main = $("prompt"), sub = $("prompt-sub");
  const set = (a, b = "") => { main.firstChild.nodeValue = a; sub.textContent = b; };
  if (link.demo) { const s = py.state; set(`Demo: ${link.demo.label}`, s ? stateLine(s) : "starting"); return; }
  if (link.state !== "connected") {
    set(link.state === "off" ? "Tap Connect and choose MFC-Tracker" : `Bluetooth: ${link.state}`,
      rec ? "The session keeps recording when the link comes back." : "Chrome asks for the tracker the first time.");
    return;
  }
  const s = py.state;
  if (py.fatal) { set("Recording (no processing)", "Python failed to load: the session is still saved for the PC."); return; }
  if (!s) { set("Recording", py.ready ? "starting the processing" : "loading Python, the processing catches up when it is ready"); return; }
  set(stateLine(s), extraLine(s));
}

function stateLine(s) {
  if (s.state === "poses" && s.poses) return `C: pose ${s.poses.n} of ${s.poses.target}`;
  if (s.state === "footcal" && s.footcal) return `I: step ${s.footcal.step} of ${s.footcal.of}`;
  if (s.fsr_calibrating) return "U: keep the foot lifted";
  if (s.state === "cal1" || s.state === "cal2") return "R: " + s.msg;
  if (s.state !== "run") return s.msg;
  if (s.step && s.step.state !== "idle") return `G: ${s.step.done} of ${s.step.target} steps`;
  if (!s.fsr_cal_ok) return "Ready: press U to set the FSR levels";
  return "Ready: press G and walk";
}
function extraLine(s) {
  if (s.state === "poses" && s.poses) return s.poses.msg;
  if (s.state === "footcal" && s.footcal) return s.footcal.msg;
  if (s.fsr_calibrating) return s.fsr_cal_msg;
  if (s.state === "cal1" || s.state === "cal2") return "Foot flat on the floor and still: R needs 2 s without movement and starts again if the foot moves.";
  if (s.state !== "run") return "";
  if (s.step && s.step.state !== "idle") return s.step.msg;
  return s.step ? s.step.msg : "";
}

function drawGyro() {
  const cv = canvasCtx($("gyro"));
  if (!cv) return;
  const { g, w, h } = cv;
  const pts = decoder.gyro, now = performance.now();
  let top = 50;
  for (const p of pts) top = Math.max(top, p[1]);
  g.strokeStyle = css("--line"); g.lineWidth = 1; g.fillStyle = css("--muted"); g.font = "11px system-ui";
  g.beginPath(); g.moveTo(0, h - 1); g.lineTo(w, h - 1); g.stroke();
  g.fillText(`${Math.round(top)}`, 4, 12);
  g.strokeStyle = css("--accent"); g.lineWidth = 2; g.beginPath();
  pts.forEach((p, i) => {
    const x = w - (now - p[0]) / 5000 * w, y = h - 2 - p[1] / top * (h - 16);
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  });
  g.stroke();
}

function showLive() {
  decoder.tick();
  const r = decoder.rates;
  $("r-imu").textContent = fmt(r[1]);
  $("r-mag").textContent = fmt(r[2]);
  $("r-fsr").textContent = fmt(r[4]);
  $("drops").textContent = decoder.dropped;
  $("drops-wrap").classList.toggle("bad-text", decoder.dropped > 0);
  $("gaps").textContent = decoder.gaps;
  $("gaps-wrap").classList.toggle("bad-text", decoder.gaps > 0);
  if (decoder.short > 5 && !showLive.warned) {
    showLive.warned = true;
    toast("Notifications arrive cut to 20 bytes: the Bluetooth packet size is too small for the tracker's frames.", 10000);
  }
  $("batt").textContent = decoder.batt ? `${decoder.batt.pct}%` : "-";
  $("timer").textContent = rec ? mmss(rec.lastT) : "-";
  if (decoder.fsr) {
    for (const [k, i] of [["toe", 0], ["heel", 1]]) {
      $("fsr-" + k).style.width = `${Math.min(100, decoder.fsr[i] / 65535 * 100)}%`;
      $("v-" + k).textContent = decoder.fsr[i];
    }
  }
  drawGyro();
  showPy();
  showPrompt();
}

let syncRunning = false;
function showButtons() {
  const on = link.state === "connected" && !!rec;
  for (const id of ["act-g", "act-r", "act-u", "act-t", "act-i", "act-c", "act-mark", "act-sync", "info"]) $(id).disabled = !on;
  $("end-session").disabled = !rec || !!link.demo;
  $("act-sync").querySelector("b").textContent = syncRunning ? "Stop sync" : "Stomp sync";
}

// ---------------------------------------------------------------- controls
function press(ev) {
  if (!rec || link.state !== "connected") return;
  if (ev === "step") rec.event("steps=" + stepsN);      // the PC replay takes the count from here
  rec.event(ev);
  log(`[key] ${ev}`);
}

let currentTab = "live";
function showTab(name) {
  currentTab = name;
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const s of document.querySelectorAll("main section")) s.classList.toggle("on", s.id === "tab-" + name);
  if (name === "log") $("log").textContent = logLines.join("\n");
  if (name === "sessions") renderSessions();
  if (name === "results" && walks.length) showWalk(Number($("walk-pick").value));
}

function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("theme", t); } catch (_) { /* private mode */ }
  if (walks.length) showWalk(Number($("walk-pick").value));
}

function showVersions() {
  $("v-page").textContent = APP_VERSION;
  const box = $("versions");
  for (const el of box.querySelectorAll(".pv")) el.remove();
  if (!py.versions) return;
  for (const [k, v] of Object.entries(py.versions)) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.className = dd.className = "pv";
    dt.textContent = k; dd.textContent = v;
    box.appendChild(dt); box.appendChild(dd);
  }
}

async function sample() {
  try {
    const list = await (await fetch("samples/index.json")).json();
    const f = list[0];
    const data = new Uint8Array(await (await fetch("samples/" + f.file)).arrayBuffer());
    const sidecar = await (await fetch("samples/" + f.file + ".json")).text();
    return { label: "sample " + f.file, data, sidecar };
  } catch (err) {
    toast("No sample with this page: " + err.message);
    return null;
  }
}

async function openFiles(files) {
  const byName = {};
  for (const f of files) byName[f.name] = f;
  const main = Object.values(byName).find((f) => /\.mfcr(ec|aw)$/.test(f.name));
  if (!main) { toast("Choose a .mfcrec or .mfcraw file and its .json"); return; }
  const side = byName[main.name + ".json"];
  if (!side) { toast(`Choose ${main.name}.json together with it`); return; }
  const data = new Uint8Array(await main.arrayBuffer());
  const sidecar = await side.text();
  const choice = confirm(`${main.name}: OK replays it to the results, Cancel plays it through the live view.`);
  if (choice) await openBytes(main.name, data, sidecar, false);
  else await playBytes(main.name, data, JSON.parse(sidecar).calibration_start);
}

async function init() {
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) { /* none */ }
  $("v-page").textContent = APP_VERSION;
  await DB.open();
  try { bundledCal = await (await fetch("default_cal.json", { cache: "no-cache" })).text(); JSON.parse(bundledCal); }
  catch (_) { bundledCal = ""; }
  showCal();
  const n = await KV.get("steps");
  if (n) stepsN = n;
  $("steps-n").textContent = stepsN;
  const c = await KV.get("github") || {};
  $("gh-repo").value = c.repo || "";
  $("gh-branch").value = c.branch || "";
  $("gh-dir").value = c.dir || "";
  $("gh-token").value = c.token || "";
  $("note").value = (await KV.get("note")) || "";

  $("connect").onclick = () => {
    if (link.demo) { stopDemo(); return; }
    return link.state === "off" || link.state === "failed" ? connect() : disconnect();
  };
  for (const b of document.querySelectorAll("[data-ev]")) b.onclick = () => press(b.dataset.ev);
  $("act-mark").onclick = () => { if (rec) { rec.event("mark"); toast("Marked at " + mmss(rec.lastT)); } };
  $("act-sync").onclick = async () => {
    if (syncRunning) { await send("SYNC STOP"); syncRunning = false; }
    else { await send("SYNC START"); syncRunning = true; toast("Stomp hard 5 to 10 times, about 1 s apart, with the foot otherwise still", 7000); }
    showButtons();
  };
  $("info").onclick = () => send("INFO");
  $("end-session").onclick = async () => {
    if (!confirm("End this session? Disconnects from the tracker; a new session starts on the next Connect.")) return;
    await disconnect();
    await endSession();
  };
  $("steps-minus").onclick = () => setSteps(stepsN - 1);
  $("steps-plus").onclick = () => setSteps(stepsN + 1);
  for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => showTab(b.dataset.tab);
  $("walk-pick").onchange = (e) => showWalk(Number(e.target.value));
  $("open-file").onchange = (e) => { openFiles([...e.target.files]); e.target.value = ""; };
  $("sample-play").onclick = async () => { const x = await sample(); if (x) playBytes(x.label, x.data, JSON.parse(x.sidecar).calibration_start); };
  $("sample-open").onclick = async () => { const x = await sample(); if (x) openBytes(x.label, x.data, x.sidecar, false); };
  $("cal-export").onclick = async () => {
    const text = await currentCal();
    if (!text) { toast("No calibration yet"); return; }
    saveBlob("accel_drift_variables.json", new Blob([text], { type: "application/json" }));
  };
  $("cal-import").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const text = await f.text();
    try { JSON.parse(text); } catch (_) { toast("That is not a calibration file"); return; }
    await saveCal(text, `loaded from ${f.name} ${timeOf(new Date())}`);
    toast("Calibration loaded; it applies from the next session");
  };
  $("cal-reset").onclick = async () => {
    if (!confirm("Forget the calibrations done on this device and use the one bundled with the page?")) return;
    await DB.del("kv", "cal");
    showCal();
  };
  $("gh-save").onclick = async () => {
    await KV.set("github", { repo: $("gh-repo").value.trim(), branch: $("gh-branch").value.trim(),
      dir: $("gh-dir").value.trim(), token: $("gh-token").value.trim() });
    toast("Saved on this device");
  };
  $("gh-test").onclick = async () => {
    try {
      const { r } = await gh("");
      const j = await r.json();
      toast(r.ok ? `OK: ${j.full_name} (${j.private ? "private" : "public"}), push ${j.permissions && j.permissions.push ? "allowed" : "NOT allowed"}` : `${r.status} ${j.message}`, 7000);
    } catch (err) { toast(err.message); }
  };
  $("note").onchange = () => KV.set("note", $("note").value);
  for (const b of document.querySelectorAll("[data-theme-set]")) b.onclick = () => setTheme(b.dataset.themeSet);
  $("log-clear").onclick = () => { logLines.length = 0; $("log").textContent = ""; };
  window.addEventListener("resize", () => { if (currentTab === "results" && walks.length) showWalk(Number($("walk-pick").value)); });

  setLink("off");
  showButtons();
  startWorker();
  setInterval(pump, FEED_MS);
  setInterval(() => { if (rec) rec.flush(); }, FLUSH_MS);
  setInterval(showLive, 250);
  setInterval(() => {
    if (py.ready && py.started && !py.statePending) { py.statePending = true; py.worker.postMessage({ type: "state" }); }
  }, 300);
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    $("v-offline").textContent = "storing (about 13 MB, once)";
    navigator.serviceWorker.register("sw.js").catch((err) => { log("[offline] no service worker: " + err); $("v-offline").textContent = "not available"; });
    navigator.serviceWorker.ready.then(() => { $("v-offline").textContent = "ready: works with no signal"; log("[offline] ready: the page works with no signal"); });
  }
  const unfinished = (await DB.all("sessions")).filter((m) => !m.ended);
  if (unfinished.length) log(`[session] ${unfinished.length} session(s) were interrupted (page closed mid-recording); they are kept under Sessions`);
  window.mfc = { py, link, decoder, walks, get rec() { return rec; }, playBytes, openBytes, DB };   // for tests
}

function setSteps(n) {
  stepsN = Math.max(1, Math.min(20, n));
  $("steps-n").textContent = stepsN;
  KV.set("steps", stepsN);
}

init();
