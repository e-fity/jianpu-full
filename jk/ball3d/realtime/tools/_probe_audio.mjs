import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8011/library", { waitUntil: "domcontentloaded" });
const info = await page.evaluate(async () => {
  const a = document.createElement("audio");
  a.src = "/api/editor/audio?base=10";
  a.preload = "auto";
  document.body.append(a);
  const out = { events: [] };
  a.addEventListener("error", () => out.events.push("error " + (a.error && a.error.code)));
  a.addEventListener("stalled", () => out.events.push("stalled"));
  a.addEventListener("waiting", () => out.events.push("waiting"));
  a.addEventListener("playing", () => out.events.push("playing"));
  try { await a.play(); out.events.push("play() ok"); }
  catch (e) { out.events.push("play() rejected: " + e.name); }
  await new Promise((r) => setTimeout(r, 2000));
  out.currentTime = a.currentTime;
  out.paused = a.paused;
  out.readyState = a.readyState;
  out.duration = a.duration;
  out.volume = a.volume;
  return out;
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
