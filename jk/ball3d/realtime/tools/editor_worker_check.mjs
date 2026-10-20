/** Real browser regression: busy solver, decline/confirm switching, and cache reuse. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://127.0.0.1:8011";
const out = path.resolve("ball3d/out/web_editor/worker_check");
fs.mkdirSync(out, { recursive: true });
const report = { checks: [], errors: [], planRequests: [] };
const check = (name, value, detail) => {
  report.checks.push({ name, ok: Boolean(value), detail });
  console.log(`${value ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail ?? "")}`);
  assert.ok(value, name);
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", error => report.errors.push(error.message));
page.on("request", request => {
  if (request.url().includes("/api/editor/plan?")) report.planRequests.push(request.url());
});
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.__workerJobs = [];
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.record = { url: String(args[0]), messages: 0, stopped: false };
      window.__workerJobs.push(this.record);
      this.addEventListener("message", () => { this.record.messages++; });
    }
    postMessage(data, ...args) {
      this.record.notes = data.plan.landings.length;
      this.record.started = performance.now();
      return super.postMessage(data, ...args);
    }
    terminate() {
      if (!this.record.stopped) this.record.ended = performance.now();
      this.record.stopped = true;
      return super.terminate();
    }
  };
  window.__solverTicks = [];
  let previous = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (window.__workerJobs.some(job => job.started && !job.stopped)) {
      window.__solverTicks.push(now - previous);
    }
    previous = now;
  }, 50);
});
const ready = () => page.waitForFunction(() => {
  const s = window.__editor?.state;
  return s && !s.pending && s.solve.state === "ok" && s.scene;
}, null, { timeout: 240000 });
const activeJobs = () => page.evaluate(() => window.__workerJobs.filter(j => !j.stopped).length);
const summary = () => page.evaluate(() => {
  const s = window.__editor.state;
  return { song: s.song, notes: s.plan.counts.sounding, boards: s.layout.boards.length,
    solve: s.solve, scene: Boolean(s.scene), selected: document.getElementById("song").value };
});
try {
  const resource = await page.request.get(`${url}/editor/layout-worker.js`);
  check("worker module served locally", resource.ok() && (await resource.text()).includes("self.onmessage"), resource.status());
  await page.goto(`${url}/editor?base=52`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor && window.__workerJobs.some(j => j.notes === 223 && !j.stopped), null, { timeout: 20000 });
  const t0 = Date.now();
  await page.locator("#audio-toggle").uncheck();
  check("controls respond while the 223-note solver is running", Date.now() - t0 < 3000, Date.now() - t0);
  await page.selectOption("#song", "45");
  await page.locator("#song-switch-dialog").waitFor({ state: "visible" });
  check("switch question has the requested wording", (await page.textContent("#song-switch-question")) === "是否打断当前歌曲排版并切歌");
  await page.screenshot({ path: path.join(out, "switch_dialog.png") });
  const before = await page.evaluate(() => ({ seq: window.__editor.state.seq, token: window.__editor.state.songToken }));
  await page.locator('#song-switch-dialog button[value="no"]').click();
  const declined = await page.evaluate(() => ({ seq: window.__editor.state.seq, token: window.__editor.state.songToken,
    song: window.__editor.state.song.base, selected: document.getElementById("song").value,
    oldStopped: window.__workerJobs[0].stopped, message: document.getElementById("message").textContent }));
  check("No keeps the old task and restores the song picker", declined.song === "52" && declined.selected === "52"
    && !declined.oldStopped && declined.seq === before.seq && declined.token === before.token, declined);
  check("No does not request the new score", !report.planRequests.some(u => u.endsWith("base=45")));
  await ready();
  report.first = await summary();
  check("the declined old task completes normally", report.first.song.base === "52" && report.first.boards === 223, report.first);
  await page.evaluate(() => window.__editor.pause());
  await page.locator('#geometry-rows input[data-key="board_w"]').evaluate(input => {
    input.value = .32;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => window.__workerJobs.length === 2 && !window.__workerJobs[1].stopped);
  await page.selectOption("#song", "4");
  await page.locator("#song-switch-dialog").waitFor({ state: "visible" });
  await page.locator('#song-switch-dialog button[value="yes"]').click();
  await page.waitForFunction(() => window.__workerJobs.length === 3);
  const switched = await page.evaluate(() => ({ song: window.__editor.state.song.base,
    old: window.__workerJobs[1], current: window.__workerJobs[2] }));
  check("Yes terminates the old worker and starts the new song", switched.song === "4" && switched.old.stopped
    && switched.old.messages === 0 && switched.current.notes === 164, switched);
  check("one solver at a time", await activeJobs() === 1);
  await ready();
  report.second = await summary();
  check("the new song commits its own passing result", report.second.song.base === "4" && report.second.boards === 164
    && report.second.selected === "4", report.second);
  await page.evaluate(() => window.__editor.pause());
  const cache = await page.evaluate(async () => {
    const before = window.__workerJobs.length, start = performance.now();
    const result = await window.__editor.resolveLayout();
    return { ok: result, newWorkers: window.__workerJobs.length - before, ms: performance.now() - start };
  });
  check("completed configuration reuses its cached layout", cache.ok && cache.newWorkers === 0, cache);
  await ready();
  await page.evaluate(() => { window.__editor.pause(); window.__editor.setTime(20); });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, "new_song_preview.png") });
  report.workers = await page.evaluate(() => window.__workerJobs);
  const gaps = await page.evaluate(() => window.__solverTicks);
  gaps.sort((a,b) => a-b);
  report.responsiveness = { samples: gaps.length, p95_ms: gaps[Math.floor(gaps.length*.95)], max_ms: Math.max(0,...gaps) };
  check("main thread timers keep running during layout solving", gaps.length > 100 && report.responsiveness.max_ms < 3000, report.responsiveness);
  check("no stale result from the cancelled task", report.workers[1].messages === 0 && report.second.song.base === "4");
  check("no page errors", report.errors.length === 0, report.errors);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = String(error.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
  await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
} finally {
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
