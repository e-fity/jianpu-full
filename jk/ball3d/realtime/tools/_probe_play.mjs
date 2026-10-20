import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text()); });
await page.goto("http://127.0.0.1:8011/editor?base=10", { waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__editor && window.__editor.state.scene", null, { timeout: 60000 });
await page.evaluate(`(() => { const a = document.getElementById("audio");
  window.__ev = []; ["waiting","playing","stalled","error","suspend","pause","loadeddata"]
    .forEach((n) => a.addEventListener(n, () => window.__ev.push(n + "@" + a.currentTime.toFixed(2)))); })()`);
const samples = [];
await page.click("#play");
for (let i = 0; i < 10; i += 1) {
  await new Promise((r) => setTimeout(r, 300));
  samples.push(await page.evaluate(`(() => { const a = document.getElementById("audio");
    return { t: +window.__editor.state.t.toFixed(2), ct: +a.currentTime.toFixed(2),
             paused: a.paused, ready: a.readyState, net: a.networkState,
             playing: window.__editor.state.playing, ev: window.__ev.slice(-4) }; })()`));
}
console.log(JSON.stringify(samples, null, 1));
await browser.close();
