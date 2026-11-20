/**
 * @local/dsh-lan-sync v2 —— 局域网会话/任务同步（按会话ID，归并到本地工作区）
 * 手机端默认：peer=http://192.168.31.88:8790, token=mykey123, 只做客户端(servePort=0)
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readTrim = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
const SESS_FILE = /^session\.v\d+\.jsonl\.zstd$/;

function resolveConfig(config = {}) {
  const e = process.env;
  return {
    peer: String(config.peer || e.DSH_SYNC_PEER || readTrim(path.join(HERE, "peer.txt")) || "http://192.168.31.88:8790").trim(),
    token: String(config.token || e.DSH_SYNC_TOKEN || readTrim(path.join(HERE, "token.txt")) || "mykey123").trim(),
    servePort: config.servePort != null ? Number(config.servePort) : Number(e.DSH_SYNC_PORT ?? 0),
    serveHost: String(config.serveHost || "0.0.0.0"),
    intervalMinutes: config.intervalMinutes != null ? Number(config.intervalMinutes) : Number(e.DSH_SYNC_INTERVAL ?? 15),
    home: config.home || e.DSH_HOME || path.join(os.homedir(), ".dsh"),
    enabled: config.enabled !== false,
  };
}

async function listSessions(home) {
  const base = path.join(home, "sessions"); const out = [];
  let wsDirs; try { wsDirs = await fsp.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    let sids; try { sids = await fsp.readdir(path.join(base, ws.name), { withFileTypes: true }); } catch { continue; }
    for (const sid of sids) {
      if (!sid.isDirectory() || !/^session-/.test(sid.name)) continue;
      const dir = path.join(base, ws.name, sid.name);
      let files; try { files = (await fsp.readdir(dir)).filter((f) => SESS_FILE.test(f)); } catch { continue; }
      for (const f of files) {
        const p = path.join(dir, f);
        try { const st = await fsp.stat(p); const sha = crypto.createHash("sha256").update(await fsp.readFile(p)).digest("hex"); out.push({ ws: ws.name, sid: sid.name, file: f, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha, abs: p }); } catch {}
      }
    }
  }
  return out;
}
function pickLocalWs(sessions) {
  const c = new Map(); for (const s of sessions) c.set(s.ws, (c.get(s.ws) || 0) + 1);
  let best = null, n = -1; for (const [w, k] of c) if (k > n) { n = k; best = w; } return best;
}
const sessPath = (home, ws, sid, file) => path.join(home, "sessions", ws, sid, file);
function atomicWrite(p, buf, mtimeMs) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, buf);
  if (mtimeMs) { try { const d = new Date(mtimeMs); fs.utimesSync(tmp, d, d); } catch {} }
  fs.renameSync(tmp, p);
}
async function manifest(home) {
  const all = await listSessions(home);
  return { host: home, localWs: pickLocalWs(all), sessions: all.map((s) => ({ sid: s.sid, file: s.file, size: s.size, mtimeMs: s.mtimeMs, sha: s.sha })) };
}
async function doSync(cfg, log = () => {}) {
  const home = cfg.home; const peer = cfg.peer.replace(/\/$/, ""); if (!peer) return { skipped: "no-peer" };
  const localAll = await listSessions(home);
  const localWs = pickLocalWs(localAll) || "default";
  const r = await fetch(peer + "/manifest", { headers: { "x-sync-token": cfg.token } });
  if (!r.ok) throw new Error("manifest " + r.status);
  const remote = await r.json();
  const L = new Map(); for (const s of localAll) L.set(s.sid, s);
  const R = new Map(); for (const s of (remote.sessions || [])) R.set(s.sid, s);
  const st = { pushed: 0, pulled: 0, skipped: 0, conflicts: 0, localWs };
  for (const sid of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(sid), rr = R.get(sid);
    const put = async (s) => fetch(`${peer}/file?sid=${encodeURIComponent(sid)}&file=${encodeURIComponent(s.file)}&mtime=${s.mtimeMs}`, { method: "PUT", headers: { "x-sync-token": cfg.token }, body: await fsp.readFile(s.abs) });
    const get = async (s) => Buffer.from(await (await fetch(`${peer}/file?sid=${encodeURIComponent(sid)}&file=${encodeURIComponent(s.file)}`, { headers: { "x-sync-token": cfg.token } })).arrayBuffer());
    if (l && !rr) { await put(l); st.pushed++; continue; }
    if (!l && rr) { atomicWrite(sessPath(home, localWs, sid, rr.file), await get(rr), rr.mtimeMs); st.pulled++; continue; }
    if (l.sha === rr.sha) { st.skipped++; continue; }
    st.conflicts++;
    const cp = path.join(home, "_sync_conflicts", `${sid}.local-${Date.now()}`); fs.mkdirSync(path.dirname(cp), { recursive: true }); fs.copyFileSync(l.abs, cp);
    if (l.mtimeMs >= rr.mtimeMs) { await put(l); st.pushed++; } else { atomicWrite(sessPath(home, localWs, sid, rr.file), await get(rr), rr.mtimeMs); st.pulled++; }
  }
  log("done " + JSON.stringify(st)); return st;
}
function startServer(cfg, log) {
  const home = cfg.home;
  const auth = (req) => { const t = req.headers["x-sync-token"] || new URL(req.url, "http://x").searchParams.get("token"); return cfg.token && t === cfg.token; };
  const srv = http.createServer(async (req, res) => {
    try {
      if (!auth(req)) { res.writeHead(401); return res.end("unauthorized"); }
      const u = new URL(req.url, "http://x");
      const localWsNow = async () => pickLocalWs(await listSessions(home)) || "default";
      if (req.method === "GET" && u.pathname === "/manifest") { const m = await manifest(home); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(m)); }
      if (req.method === "GET" && u.pathname === "/file") {
        const sid = u.searchParams.get("sid"), file = u.searchParams.get("file") || "session.v4.jsonl.zstd", ws = u.searchParams.get("ws");
        const wsUse = ws && !/[\\/]/.test(ws) ? ws : await localWsNow();
        const p = sessPath(home, wsUse, sid, file);
        if (!sid || !SESS_FILE.test(file) || !fs.existsSync(p)) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "content-type": "application/octet-stream" }); return fs.createReadStream(p).pipe(res);
      }
      if (req.method === "PUT" && u.pathname === "/file") {
        const sid = u.searchParams.get("sid"), file = u.searchParams.get("file") || "session.v4.jsonl.zstd", mtime = Number(u.searchParams.get("mtime") || 0);
        if (!sid || !SESS_FILE.test(file)) { res.writeHead(400); return res.end("bad"); }
        const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 64 * 1024 * 1024) { res.writeHead(413); return res.end("big"); } chunks.push(c); }
        atomicWrite(sessPath(home, await localWsNow(), sid, file), Buffer.concat(chunks), mtime); res.writeHead(200); return res.end("ok");
      }
      if ((req.method === "POST" || req.method === "GET") && u.pathname === "/sync-now") { const s = await doSync(cfg, log); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(s)); }
      res.writeHead(404); res.end("not found");
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  srv.on("error", (e) => log("server error " + e.message));
  srv.listen(cfg.servePort, cfg.serveHost, () => log(`listening ${cfg.serveHost}:${cfg.servePort}`));
  return srv;
}
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const log = (m) => { try { console.log("dsh-lan-sync: " + m); } catch {} };
  if (!cfg.enabled) return () => {};
  const disposers = [];
  if (cfg.servePort > 0 && cfg.token) { try { const s = startServer(cfg, log); disposers.push(() => { try { s.close(); } catch {} }); } catch (e) { log("server start failed " + e.message); } }
  const run = () => doSync(cfg, log).catch((e) => log("sync failed " + e.message));
  if (cfg.peer) { setTimeout(run, 3000); if (cfg.intervalMinutes > 0) { const t = setInterval(run, cfg.intervalMinutes * 60000); disposers.push(() => clearInterval(t)); } }
  log(`home=${cfg.home} peer=${cfg.peer} port=${cfg.servePort}`);
  return () => { for (const d of disposers) { try { d(); } catch {} } };
}
