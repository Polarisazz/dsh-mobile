#!/usr/bin/env node
/**
 * dsh-sync —— 局域网「会话/任务」双向同步引擎（零依赖，Node >= 22）
 *
 * 设计：以 DSH 的会话日志文件为同步单元
 *   <DSH_HOME>/sessions/<workspaceKey>/session-<id>/session.v*.jsonl.zstd
 * 每个文件按内容 sha256 做冲突检测，按 mtime 做「较新者胜」，
 * 落败的一方保留为 _sync_conflicts/ 下的副本，永不丢数据。
 *
 * 用法：
 *   服务端（桌面或任一端）：
 *     node sync.mjs serve --root "%USERPROFILE%\.dsh" --port 8790 --token <口令>
 *   同步端（手机端，双向）：
 *     node sync.mjs sync --root "<本机DSH_HOME>" --peer http://<对端IP>:8790 --token <口令>
 *
 * 仅同步 sessions/ 下的会话日志，不碰 credentials / profiles / 缓存。
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SESSION_RE = /^sessions\/(.+)\/(session-[^/]+)\/(session\.v\d+\.jsonl\.zstd)$/;

function dshHomeFrom(root) {
  // accept either DSH_HOME or DSH_HOME/.dsh
  const a = path.join(root, "sessions");
  if (fs.existsSync(a)) return root;
  const b = path.join(root, ".dsh", "sessions");
  if (fs.existsSync(b)) return path.join(root, ".dsh");
  return root;
}

async function walkSessions(home) {
  const base = path.join(home, "sessions");
  const out = [];
  async function walk(dir, depth) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) await walk(p, depth + 1); }
      else if (e.isFile() && /^session\.v\d+\.jsonl\.zstd$/.test(e.name)) {
        const rel = path.relative(home, p).split(path.sep).join("/");
        if (SESSION_RE.test(rel)) {
          const st = await fsp.stat(p);
          out.push({ rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        }
      }
    }
  }
  await walk(base, 0);
  return out;
}

async function sha256File(p) {
  const buf = await fsp.readFile(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function manifest(home) {
  const items = await walkSessions(home);
  const res = [];
  for (const it of items) {
    const p = path.join(home, it.rel);
    try { it.sha = await sha256File(p); res.push(it); } catch { /* skip unreadable */ }
  }
  return res;
}

function atomicWrite(p, buf, mtimeMs) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, buf);
  if (mtimeMs) { try { const d = new Date(mtimeMs); fs.utimesSync(tmp, d, d); } catch {} }
  fs.renameSync(tmp, p);
}

// ------------------------------ server --------------------------------------
function serve({ root, port, token, host = "0.0.0.0" }) {
  const home = dshHomeFrom(root);
  console.log(`[dsh-sync] serve root=${home} port=${port}`);
  const auth = (req) => {
    const t = req.headers["x-sync-token"] || new URL(req.url, "http://x").searchParams.get("token");
    return t === token;
  };
  const srv = http.createServer(async (req, res) => {
    try {
      if (!auth(req)) { res.writeHead(401); return res.end("unauthorized"); }
      const u = new URL(req.url, "http://x");
      if (req.method === "GET" && u.pathname === "/manifest") {
        const m = await manifest(home);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ host: home, sessions: m }));
      }
      if (req.method === "GET" && u.pathname === "/file") {
        const rel = u.searchParams.get("rel");
        if (!rel || !SESSION_RE.test(rel)) { res.writeHead(400); return res.end("bad rel"); }
        const p = path.join(home, rel);
        if (!p.startsWith(path.join(home, "sessions"))) { res.writeHead(400); return res.end("escape"); }
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return fs.createReadStream(p).pipe(res);
      }
      if (req.method === "PUT" && u.pathname === "/file") {
        const rel = u.searchParams.get("rel");
        const mtime = Number(u.searchParams.get("mtime") || 0);
        if (!rel || !SESSION_RE.test(rel)) { res.writeHead(400); return res.end("bad rel"); }
        const chunks = [];
        let total = 0;
        for await (const c of req) { total += c.length; if (total > 64 * 1024 * 1024) { res.writeHead(413); return res.end("too big"); } chunks.push(c); }
        const p = path.join(home, rel);
        if (!p.startsWith(path.join(home, "sessions"))) { res.writeHead(400); return res.end("escape"); }
        atomicWrite(p, Buffer.concat(chunks), mtime);
        res.writeHead(200); return res.end("ok");
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  srv.listen(port, host, () => console.log(`[dsh-sync] listening ${host}:${port}`));
  return srv;
}

// ------------------------------ client --------------------------------------
async function fetchJson(url, token) {
  const r = await fetch(url, { headers: { "x-sync-token": token } });
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  return r.json();
}
async function fetchBuf(url, token) {
  const r = await fetch(url, { headers: { "x-sync-token": token } });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function putBuf(url, token, buf) {
  const r = await fetch(url, { method: "PUT", headers: { "x-sync-token": token }, body: buf });
  if (!r.ok) throw new Error(`upload ${r.status}`);
}

async function sync({ root, peer, token }) {
  const home = dshHomeFrom(root);
  console.log(`[dsh-sync] sync local=${home} <-> ${peer}`);
  const localM = await manifest(home);
  const remote = await fetchJson(peer.replace(/\/$/, "") + "/manifest", token);
  const remoteM = remote.sessions;
  const L = new Map(localM.map((x) => [x.rel, x]));
  const R = new Map(remoteM.map((x) => [x.rel, x]));
  const conflictsDir = path.join(home, "_sync_conflicts");
  const stats = { pushed: 0, pulled: 0, skipped: 0, conflicts: 0 };
  const all = new Set([...L.keys(), ...R.keys()]);

  for (const rel of all) {
    const l = L.get(rel), r = R.get(rel);
    if (l && !r) { // only local -> push
      const buf = await fsp.readFile(path.join(home, rel));
      await putBuf(`${peer.replace(/\/$/, "")}/file?rel=${encodeURIComponent(rel)}&mtime=${l.mtimeMs}`, token, buf);
      stats.pushed++; continue;
    }
    if (!l && r) { // only remote -> pull
      const buf = await fetchBuf(`${peer.replace(/\/$/, "")}/file?rel=${encodeURIComponent(rel)}`, token);
      atomicWrite(path.join(home, rel), buf, r.mtimeMs);
      stats.pulled++; continue;
    }
    // both
    if (l.sha === r.sha) { stats.skipped++; continue; }
    stats.conflicts++;
    // 保留本机旧版本到冲突区
    const safe = rel.replace(/\//g, "__");
    const cpath = path.join(conflictsDir, `${safe}.local-${Date.now()}`);
    fs.mkdirSync(conflictsDir, { recursive: true });
    fs.copyFileSync(path.join(home, rel), cpath);
    if (l.mtimeMs >= r.mtimeMs) { // local newer -> push over remote
      const buf = await fsp.readFile(path.join(home, rel));
      await putBuf(`${peer.replace(/\/$/, "")}/file?rel=${encodeURIComponent(rel)}&mtime=${l.mtimeMs}`, token, buf);
      stats.pushed++;
    } else { // remote newer -> pull over local
      const buf = await fetchBuf(`${peer.replace(/\/$/, "")}/file?rel=${encodeURIComponent(rel)}`, token);
      atomicWrite(path.join(home, rel), buf, r.mtimeMs);
      stats.pulled++;
    }
  }
  console.log("[dsh-sync] done", JSON.stringify(stats));
  return stats;
}

export { serve, sync, manifest, dshHomeFrom };

// ------------------------------- cli ----------------------------------------
import { fileURLToPath } from "node:url";
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = {};
  for (let i = 1; i < args.length; i++) { if (args[i].startsWith("--")) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true; opt[k] = v; } }

  if (cmd === "serve") serve({ root: opt.root || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dsh"), port: Number(opt.port || 8790), token: opt.token || "dsh-sync", host: opt.host || "0.0.0.0" });
  else if (cmd === "sync") sync({ root: opt.root || process.env.DSH_HOME, peer: opt.peer, token: opt.token || "dsh-sync" }).catch((e) => { console.error("sync failed:", e.message); process.exit(1); });
  else { console.log("usage: node sync.mjs serve|sync [--root ..] [--port ..] [--peer ..] [--token ..]"); }
}
