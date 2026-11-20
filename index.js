/**
 * @local/dsh-lan-sync —— 局域网「会话/任务」双向同步（DSH Host 插件）
 *
 * 两个 DSH（桌面端 + 手机端）各装一次本插件，互相填对方地址+口令，
 * 就会在后台定期把 sessions/<workspace>/session-<id>/session.v*.jsonl.zstd 双向补齐。
 * 冲突按 mtime 较新者胜，落败版本存到 <DSH_HOME>/_sync_conflicts/ 不丢数据。
 *
 * 配置（插件 config，或环境变量）：
 *   peer            对端地址，如 http://192.168.31.88:8790
 *   token           共享口令（两端一致）
 *   servePort       本机监听端口（默认 8790；0=不监听，只做客户端）
 *   serveHost       监听地址（默认 0.0.0.0）
 *   intervalMinutes 定时间隔（默认 15 分钟；0=只在启动时同步一次）
 *   home            DSH_HOME（默认取环境变量或 ~/.dsh）
 *   enabled         总开关（默认 true）
 * 环境变量：DSH_SYNC_PEER / DSH_SYNC_TOKEN / DSH_SYNC_PORT / DSH_SYNC_INTERVAL
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const SESSION_RE = /^sessions\/[^/]+\/session-[^/]+\/session\.v\d+\.jsonl\.zstd$/;

function resolveConfig(config = {}) {
  const e = process.env;
  return {
    peer: String(config.peer || e.DSH_SYNC_PEER || "").trim(),
    token: String(config.token || e.DSH_SYNC_TOKEN || "").trim(),
    servePort: config.servePort != null ? Number(config.servePort) : Number(e.DSH_SYNC_PORT ?? 8790),
    serveHost: String(config.serveHost || "0.0.0.0"),
    intervalMinutes: config.intervalMinutes != null ? Number(config.intervalMinutes) : Number(e.DSH_SYNC_INTERVAL ?? 15),
    home: config.home || e.DSH_HOME || path.join(os.homedir(), ".dsh"),
    enabled: config.enabled !== false,
  };
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

const sha256File = async (p) =>
  crypto.createHash("sha256").update(await fsp.readFile(p)).digest("hex");

async function manifest(home) {
  const res = [];
  for (const it of await walkSessions(home)) {
    try { it.sha = await sha256File(path.join(home, it.rel)); res.push(it); } catch { /* skip */ }
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

async function fetchJson(url, token) {
  const r = await fetch(url, { headers: { "x-sync-token": token } });
  if (!r.ok) throw new Error("manifest " + r.status);
  return r.json();
}
async function fetchBuf(url, token) {
  const r = await fetch(url, { headers: { "x-sync-token": token } });
  if (!r.ok) throw new Error("download " + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function putBuf(url, token, buf) {
  const r = await fetch(url, { method: "PUT", headers: { "x-sync-token": token }, body: buf });
  if (!r.ok) throw new Error("upload " + r.status);
}

async function doSync(cfg, log = () => {}) {
  const home = cfg.home;
  const peer = cfg.peer.replace(/\/$/, "");
  if (!peer) return { skipped: "no-peer" };
  const localM = await manifest(home);
  const remote = await fetchJson(peer + "/manifest", cfg.token);
  const L = new Map(localM.map((x) => [x.rel, x]));
  const R = new Map((remote.sessions || []).map((x) => [x.rel, x]));
  const stats = { pushed: 0, pulled: 0, skipped: 0, conflicts: 0 };
  for (const rel of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(rel), r = R.get(rel);
    if (l && !r) {
      await putBuf(`${peer}/file?rel=${encodeURIComponent(rel)}&mtime=${l.mtimeMs}`, cfg.token, await fsp.readFile(path.join(home, rel)));
      stats.pushed++; continue;
    }
    if (!l && r) {
      atomicWrite(path.join(home, rel), await fetchBuf(`${peer}/file?rel=${encodeURIComponent(rel)}`, cfg.token), r.mtimeMs);
      stats.pulled++; continue;
    }
    if (l.sha === r.sha) { stats.skipped++; continue; }
    stats.conflicts++;
    const cp = path.join(home, "_sync_conflicts", rel.replace(/\//g, "__") + ".local-" + Date.now());
    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.copyFileSync(path.join(home, rel), cp);
    if (l.mtimeMs >= r.mtimeMs) {
      await putBuf(`${peer}/file?rel=${encodeURIComponent(rel)}&mtime=${l.mtimeMs}`, cfg.token, await fsp.readFile(path.join(home, rel)));
      stats.pushed++;
    } else {
      atomicWrite(path.join(home, rel), await fetchBuf(`${peer}/file?rel=${encodeURIComponent(rel)}`, cfg.token), r.mtimeMs);
      stats.pulled++;
    }
  }
  log("dsh-lan-sync: " + JSON.stringify(stats));
  return stats;
}

function startServer(cfg, log) {
  const home = cfg.home;
  const auth = (req) => {
    const t = req.headers["x-sync-token"] || new URL(req.url, "http://x").searchParams.get("token");
    return cfg.token && t === cfg.token;
  };
  const srv = http.createServer(async (req, res) => {
    try {
      if (!auth(req)) { res.writeHead(401); return res.end("unauthorized"); }
      const u = new URL(req.url, "http://x");
      if (req.method === "GET" && u.pathname === "/manifest") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ host: home, sessions: await manifest(home) }));
      }
      if (req.method === "GET" && u.pathname === "/file") {
        const rel = u.searchParams.get("rel");
        if (!rel || !SESSION_RE.test(rel)) { res.writeHead(400); return res.end("bad rel"); }
        const p = path.join(home, rel);
        if (!p.startsWith(path.join(home, "sessions")) || !fs.existsSync(p)) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return fs.createReadStream(p).pipe(res);
      }
      if (req.method === "PUT" && u.pathname === "/file") {
        const rel = u.searchParams.get("rel");
        const mtime = Number(u.searchParams.get("mtime") || 0);
        if (!rel || !SESSION_RE.test(rel)) { res.writeHead(400); return res.end("bad rel"); }
        const chunks = []; let total = 0;
        for await (const c of req) { total += c.length; if (total > 64 * 1024 * 1024) { res.writeHead(413); return res.end("big"); } chunks.push(c); }
        const p = path.join(home, rel);
        if (!p.startsWith(path.join(home, "sessions"))) { res.writeHead(400); return res.end("escape"); }
        atomicWrite(p, Buffer.concat(chunks), mtime);
        res.writeHead(200); return res.end("ok");
      }
      if (req.method === "POST" && u.pathname === "/sync-now") {
        const s = await doSync(cfg, log);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(s));
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  srv.on("error", (e) => log("dsh-lan-sync server error: " + e.message));
  srv.listen(cfg.servePort, cfg.serveHost, () => log(`dsh-lan-sync listening ${cfg.serveHost}:${cfg.servePort}`));
  return srv;
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const log = (m) => { try { console.log(m); } catch {} };
  if (!cfg.enabled) { log("dsh-lan-sync disabled"); return () => {}; }
  log(`dsh-lan-sync home=${cfg.home} peer=${cfg.peer || "(none)"} port=${cfg.servePort}`);

  const disposers = [];
  if (cfg.servePort > 0 && cfg.token) {
    try { const srv = startServer(cfg, log); disposers.push(() => { try { srv.close(); } catch {} }); }
    catch (e) { log("dsh-lan-sync server start failed: " + e.message); }
  } else if (cfg.servePort > 0) {
    log("dsh-lan-sync: no token set, server disabled");
  }

  const run = () => doSync(cfg, log).catch((e) => log("dsh-lan-sync sync failed: " + e.message));
  if (cfg.peer) {
    setTimeout(run, 3000);
    if (cfg.intervalMinutes > 0) {
      const t = setInterval(run, cfg.intervalMinutes * 60000);
      disposers.push(() => clearInterval(t));
    }
  }
  return () => { for (const d of disposers) { try { d(); } catch {} } };
}
