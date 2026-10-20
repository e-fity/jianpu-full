/** Browser acceptance of real worker progress and a two-second frame export. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const out = path.resolve("ball3d/out/web_editor/progress_check");
const report = { checks: [], errors: [], statuses: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail ?? "")}`);
  assert.ok(ok, name);
};
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", e => report.errors.push(e.message));
page.on("response", async r => {
  if (/\/api\/editor\/export\/[a-f0-9]{12}$/.test(r.url()) && r.ok()) {
    const data = await r.json();
    report.statuses.push({ state: data.state, progress: data.progress, frames: data.frames });
  }
});
await page.addInitScript(() => {
  window.progressUpdates = { layout: [], export: [] };
  window.addEventListener("DOMContentLoaded", () => {
    for (const kind of ["layout", "export"]) {
      const box = document.getElementById(`${kind}-progress-box`);
      new MutationObserver(() => {
        window.progressUpdates[kind].push({ percent: document.getElementById(`${kind}-progress`).value,
          text: document.getElementById(`${kind}-progress-label`).textContent, state: box.dataset.state });
      }).observe(box, { childList: true, subtree: true, characterData: true, attributes: true });
    }
  });
});
try {
  await page.goto("http://127.0.0.1:8011/editor", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__editor);
  await page.locator("#audio-toggle").uncheck();
  await page.locator("#import-file").setInputFiles(path.join(out, "fragment_notes.json"));
  await page.waitForFunction(() => {
    const s = window.__editor.state;
    return !s.pending && s.solve.state === "ok" && s.scene;
  }, null, { timeout: 45000 });
  await page.locator("#play").click();
  report.layout = await page.evaluate(() => window.progressUpdates.layout);
  check("worker updates the layout percentage before completion", report.layout.some(p => p.percent > 0 && p.percent < 100), report.layout);
  check("layout reaches 100 only on success", report.layout.at(-1).percent === 100 && report.layout.at(-1).state === "done"
    && report.layout.filter(p => p.state !== "done").every(p => p.percent < 100));
  const seconds = await page.evaluate(() => window.__editor.state.plan.duration);
  await page.locator("#timeline").evaluate((input, start) => {
    input.value = start;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, Math.max(0, seconds - 2));
  await page.locator("#export-sample").click();
  await page.waitForFunction(() => !window.__editor.state.exporting, null, { timeout: 180000 });
  const success = await page.evaluate(() => ({ percent: document.getElementById("export-progress").value,
    state: document.getElementById("export-progress-box").dataset.state,
    text: document.getElementById("export-progress-label").textContent,
    message: document.getElementById("message").textContent, rid: window.__editor.state.exportRid }));
  check("actual export completes at 100 percent", success.percent === 100 && success.state === "done", success);
  check("API percentages follow rendered frames", report.statuses.some(s => s.progress.completed > 0 && s.state === "running")
    && report.statuses.filter(s => s.state === "running").every(s => s.progress.percent < 100), report.statuses);
  report.export = await page.evaluate(() => window.progressUpdates.export);
  check("render progress is visible with frame counts", report.export.some(p => p.percent > 0 && p.percent < 100 && p.text.includes("帧")));
  await page.locator("#export-progress-box").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, "completed.png") });
  // A separate failed job must reset the bar and never reuse the previous 100%.
  await page.route("**/api/editor/export", route => route.fulfill({ json: { ok: true, rid: "ffffffffffff" } }));
  await page.route("**/api/editor/export/ffffffffffff", route => route.fulfill({ json: {
    ok: true, state: "failed", error: "验收用失败", progress: { percent: 25, stage: "渲染失败", completed: 15, total: 60 },
  } }));
  await page.locator("#export-sample").click();
  await page.waitForFunction(() => document.getElementById("export-progress-box").dataset.state === "failed");
  const failed = await page.evaluate(() => ({ percent: document.getElementById("export-progress").value,
    text: document.getElementById("export-progress-label").textContent, downloadHidden: document.getElementById("download").hidden,
    updates: window.progressUpdates.export.slice(-3) }));
  check("a failed new job resets and displays its own progress", failed.percent === 25 && failed.downloadHidden
    && failed.updates.some(p => p.percent === 0), failed);
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
