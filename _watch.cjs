// Watch the latest workflow run until it completes. Token from env TOK.
const https = require("https");
const T = process.env.TOK;
const OWNER = "Polarisazz", REPO = "dsh-mobile";
function req(path, tries = 0) {
  return new Promise((r) => {
    const q = https.get("https://api.github.com" + path, { headers: { "User-Agent": "dsh", Authorization: "Bearer " + T, Accept: "application/vnd.github+json" }, timeout: 30000 }, (x) => {
      let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => r({ s: x.statusCode, d }));
    });
    q.on("error", () => { if (tries < 4) setTimeout(() => req(path, tries + 1).then(r), 2000); else r({ s: 0, d: "ERR" }); });
    q.on("timeout", () => { q.destroy(); if (tries < 4) setTimeout(() => req(path, tries + 1).then(r), 2000); else r({ s: 0, d: "TO" }); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 120; i++) {
    const runs = await req(`/repos/${OWNER}/${REPO}/actions/runs?per_page=1`);
    if (runs.s !== 200) { console.log("poll err", runs.s); await sleep(45000); continue; }
    const run = JSON.parse(runs.d).workflow_runs[0];
    if (!run) { await sleep(20000); continue; }
    if (run.status === "completed") {
      console.log(`\n=== RUN #${run.run_number} COMPLETED: ${run.conclusion} ===`);
      console.log(run.html_url);
      const jobs = await req(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs`);
      if (jobs.s === 200) for (const job of JSON.parse(jobs.d).jobs) {
        console.log(`job ${job.name}: ${job.status}/${job.conclusion} (id ${job.id})`);
        for (const st of job.steps || []) console.log(`   ${st.number}. [${st.status}/${st.conclusion || "-"}] ${st.name}`);
      }
      const art = await req(`/repos/${OWNER}/${REPO}/actions/artifacts`);
      if (art.s === 200) { const a = JSON.parse(art.d); console.log("ARTIFACTS:", a.total_count); for (const x of a.artifacts || []) console.log("  -", x.name, (x.size_in_bytes / 1048576).toFixed(1) + "MB", "id=" + x.id); }
      process.exit(0);
    }
    // progress: current step
    let cur = "";
    const jobs = await req(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs`);
    if (jobs.s === 200) { const jb = JSON.parse(jobs.d).jobs[0]; if (jb) { const st = (jb.steps || []).find((s) => s.status === "in_progress") || (jb.steps || []).filter((s) => s.conclusion === "success").pop(); cur = st ? st.name : ""; } }
    console.log(`[${new Date().toISOString()}] #${run.run_number} ${run.status} @ ${cur}`);
    await sleep(45000);
  }
  console.log("watch timeout");
})();
