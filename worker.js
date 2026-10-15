// The processing worker: Pyodide running receiver/mfc (bundled as py/mfc.zip by
// tools/build_web.py) through web/py/mfc_web.py. The page records the session; it sends the
// same record bytes here, so the results are those of a PC replay of that session.
//
// Messages in:  {type:"init"} | {type:"start", cal} | {type:"feed", buf, upto} | {type:"state"}
//               {type:"status", id} | {type:"open", id, data, sidecar, armAll} | {type:"records", id, data}
// Messages out: {type:"ready", versions} | {type:"progress", text} | {type:"fatal", text}
//               {type:"fed", upto, walks, ms} | {type:"state", json} | {type:"result", json}
//               {type:"cal", text} | {type:"status", id, json} | {type:"opened", id, json}
//               {type:"records", id, buf}
//               {type:"error", id, text}

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
let py = null, web = null, live = null;

function post(m, transfer) { self.postMessage(m, transfer || []); }

async function init() {
  post({ type: "progress", text: "loading Python (first time: about 15 MB)" });
  importScripts(PYODIDE + "pyodide.js");
  py = await loadPyodide({ indexURL: PYODIDE });
  post({ type: "progress", text: "loading numpy" });
  await py.loadPackage(["numpy", "lzma"]);
  post({ type: "progress", text: "loading the receiver" });
  const zip = await (await fetch("py/mfc.zip", { cache: "no-cache" })).arrayBuffer();
  py.unpackArchive(zip, "zip", { extractDir: "/home/pyodide/app" });
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide/app')");
  web = py.pyimport("mfc_web");
  const versions = JSON.parse(py.runPython(
    "import json, sys, numpy, mfc, mfc_web; json.dumps({'receiver': mfc.__version__, " +
    "'web': mfc_web.WEB_VERSION, 'python': sys.version.split()[0], 'numpy': numpy.__version__, " +
    "'session_format': mfc_web.sess.SESSION_FORMAT_VERSION, 'wire_format': mfc_web.sess.WIRE_FORMAT_VERSION})"));
  post({ type: "ready", versions });
}

function pyBytes(u8) {
  // a JS Uint8Array as a Python bytes object (a PyProxy: destroy it after use)
  return web.as_bytes(u8);
}

function jsBytes(proxy) {
  // a Python bytes PyProxy as a fresh ArrayBuffer (and the proxy destroyed)
  const pb = proxy.getBuffer("u8");
  const u8 = pb.data.slice();
  pb.release();
  proxy.destroy();
  return u8.buffer;
}

function sendState() {
  if (live) post({ type: "state", json: live.state() });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await init();
    } else if (m.type === "start") {
      if (live) { live.destroy(); live = null; }
      live = web.Live(m.cal || "");
      sendState();
    } else if (m.type === "feed") {
      if (!live) return;
      const t0 = performance.now();
      const b = pyBytes(new Uint8Array(m.buf));
      const walks = live.feed(b);
      b.destroy();
      const ms = performance.now() - t0;
      post({ type: "fed", upto: m.upto, walks, ms });
      if (walks > 0) {
        const r = live.result(-1);
        if (r) post({ type: "result", json: r });
      }
      const cal = live.calibration();
      if (cal) post({ type: "cal", text: cal });
    } else if (m.type === "state") {
      sendState();
    } else if (m.type === "status") {
      post({ type: "status", id: m.id, json: live ? live.status_block() : "null" });
    } else if (m.type === "open") {
      const b = pyBytes(new Uint8Array(m.data));
      const json = web.open_session(b, m.sidecar, !!m.armAll);
      b.destroy();
      post({ type: "opened", id: m.id, json });
    } else if (m.type === "records") {
      // a session file (packed .mfcrec or .mfcraw) as the bare record stream, for demo playback
      const b = pyBytes(new Uint8Array(m.data));
      const buf = jsBytes(web.record_stream(b));
      b.destroy();
      post({ type: "records", id: m.id, buf }, [buf]);
    }
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    if (m.type === "init") post({ type: "fatal", text });
    else post({ type: "error", id: m.id, text: m.type + ": " + text });
  }
};
