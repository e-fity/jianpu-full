
/** Render one frame of the *current* code at an absolute time, at export size. */
import { chromium } from "playwright-core";

function parseArgs(argv) {
  const out = { sets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--set") out.sets.push(argv[++i]);
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const url = (args.url || "http://127.0.0.1:8011").replace(/\/$/, "");
const base = args.base || "10";
const time = Number(args.time || 40);
const width = Number(args.width || 720);
const height = Number(args.height || 1280);
const name = args.name || "frame_check";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.goto(url + "/editor?base=" + base, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction("window.__editor && window.__editor.state.scene && window.__editor.state.solve.state === 'ok'", null, { timeout: 180000 });
const info = await page.evaluate(`(async () => {
  document.getElementById("reset").click();
  await new Promise((r) => setTimeout(r, 1500));
  const setPanel = async (selector, value, numeric) => {
    const input = document.querySelector('#panel input[data-key="' + selector + '"]');
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 320));
  };
  for (const item of ${JSON.stringify(args.sets)}) {
    const eq = item.indexOf("=");
    await setPanel(item.slice(0, eq).split(".").slice(1).join("."), item.slice(eq + 1), true);
  }
  await new Promise((r) => setTimeout(r, 600));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
  const state = window.__editor.state;
  const result = await window.__editor.snapshot(${time}, ${JSON.stringify(name)},
    { width: ${width}, height: ${height} });
  return { settings: state.solved, boards: state.layout.boards.length,
           audit: state.solve.info, result: result,
           visuals: state.scene.visuals };
})()`);
console.log(JSON.stringify({ info: info, page: info.result, errs: errs }, null, 1));
await browser.close();
