// CI helper for Polarisazz/dsh-mobile. Token from env TOK.
const https = require("https");
const T = process.env.TOK;
const OWNER = "Polarisazz", REPO = "dsh-mobile", WF = "build-apk.yml";

function req(method, path, body, tries = 0) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "User-Agent": "dsh", Authorization: "Bearer " + T, Accept: "application/vnd.github+json" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    const q = https.request("https://api.github.com" + path, { method, headers, timeout: 30000 }, (x) => {
      let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => resolve({ s: x.statusCode, d }));
    });
    q.on("error", (e) => { if (tries < 4) setTimeout(() => req(method, path, body, tries + 1).then(resolve), 1500); else resolve({ s: 0, d: "ERR " + e.message }); });
    q.on("timeout", () => { q.destroy(); if (tries < 4) setTimeout(() => req(method, path, body, tries + 1).then(resolve), 1500); else resolve({ s: 0, d: "TO" }); });
    if (data) q.write(data);
    q.end();
  });
}
function getText(url, tries = 0) {
  return new Promise((resolve) => {
    const h = { "User-Agent": "dsh", Accept: "*/*" };
    if (new URL(url).host === "api.github.com") h.Authorization = "Bearer " + T;
    const q = https.get(url, { headers: h, timeout: 60000 }, (x) => {
      if ([301, 302, 307, 308].includes(x.statusCode) && x.headers.location) { x.resume(); return resolve(getText(x.headers.location, tries + 1)); }
      let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => resolve({ s: x.statusCode, d }));
    });
    q.on("error", () => { if (tries < 4) setTimeout(() => getText(url, tries + 1).then(resolve), 1500); else resolve({ s: 0, d: "ERR" }); });
  });
}

async function dispatch() {
  const r = await req("POST", `/repos/${OWNER}/${REPO}/actions/workflows/${WF}/dispatches`, { ref: "main" });
  console.log("dispatch", r.s, r.s >= 200 && r.s < 300 ? "OK 已触发" : r.d.slice(0, 200));
}
async function status() {
  const runs = await req("GET", `/repos/${OWNER}/${REPO}/actions/runs?per_page=4`);
  if (runs.s !== 200) return console.log("runs err", runs.s, runs.d.slice(0, 160));
  const j = JSON.parse(runs.d);
  console.log("total runs:", j.total_count);
  for (const r of j.workflow_runs.slice(0, 3)) {
    console.log(`\n#${r.run_number} status=${r.status} conclusion=${r.conclusion} updated=${r.updated_at}`);
    console.log("  " + r.html_url);
    const jobs = await req("GET", `/repos/${OWNER}/${REPO}/actions/runs/${r.id}/jobs`);
    if (jobs.s === 200) for (const job of JSON.parse(jobs.d).jobs) {
      console.log(`  job ${job.name}: ${job.status}/${job.conclusion || "-"} (id ${job.id})`);
      for (const st of job.steps || []) console.log(`     ${st.number}. [${st.status}/${st.conclusion || "-"}] ${st.name}`);
    }
  }
  const art = await req("GET", `/repos/${OWNER}/${REPO}/actions/artifacts`);
  if (art.s === 200) { const a = JSON.parse(art.d); console.log("\nARTIFACTS:", a.total_count); for (const x of a.artifacts || []) console.log("  -", x.name, (x.size_in_bytes / 1048576).toFixed(1) + "MB", "expired=" + x.expired, "id=" + x.id); }
}
async function log(jobId) {
  const r = await getText(`https://api.github.com/repos/${OWNER}/${REPO}/actions/jobs/${jobId}/logs`);
  const lines = String(r.d).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) if (/error|Error|ERROR|FAIL|fail|not found|No such|Package|sdkmanager|Could not|Execution failed|> Task/.test(lines[i])) out.push("L" + i + ": " + lines[i].replace(/^.*?Z\s/, ""));
  console.log(out.slice(-80).join("\n"));
}
const cmd = process.argv[2];
(async () => {
  if (cmd === "dispatch") await dispatch();
  else if (cmd === "status") await status();
  else if (cmd === "log") await log(process.argv[3]);
  else console.log("usage: node _ci.mjs dispatch|status|log <jobId>");
})();
