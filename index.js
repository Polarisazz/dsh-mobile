/**
 * @local/dsh-lan-sync v2.0 —— 远程加载器
 * 只装一次：启动时从电脑端 8790 拉取真正的同步脚本(plugin-code.js)并执行。
 * 以后改电脑上的 plugin-code.js，重启 App 即生效，无需再卸载重装插件。
 * 手机默认：peer=http://192.168.31.88:8790, token=mykey123。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readTrim = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };

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

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const log = (m) => { try { console.log("dsh-lan-sync: " + m); } catch {} };
  let dispose = () => {};
  (async () => {
    if (!cfg.enabled) return;
    try {
      const url = cfg.peer.replace(/\/$/, "") + "/plugin-code.js";
      const r = await fetch(url, { headers: { "x-sync-token": cfg.token } });
      if (!r.ok) throw new Error("load code " + r.status);
      const code = await r.text();
      const dataUrl = "data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64");
      const mod = await import(/* @vite-ignore */ dataUrl);
      if (typeof mod.start !== "function") throw new Error("plugin-code has no start()");
      dispose = mod.start(cfg, log) || (() => {});
      log("远程同步代码已加载");
    } catch (e) {
      log("远程代码加载失败(电脑没开或不可达): " + e.message);
    }
  })();
  return () => { try { dispose(); } catch {} };
}
