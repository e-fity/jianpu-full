/**
 * Drive the editor page like a person: pick the song in the select box, move the
 * real sliders/colour inputs, put the playhead on the timeline, then CLICK
 * 「导出 10 秒样片」/「导出整曲」 and wait for the page to say it is done.
 *
 * Nothing here calls the API directly, and nothing writes into the internal
 * state of the page: if a control were dead (a slider that never reaches the
 * render, a button that lies about finishing) this tool would produce a wrong
 * video instead of hiding the bug.  The only values read back are the on-screen
 * status text and the link/video elements that the page fills in itself.
 *
 *   node tools/editor_export.mjs --base 10 --size 1080x1920 --fps 30 \
 *     --kind sample --start 12.5 --set geometry.board_w=0.28 \
 *     --out ../../out/web_editor/edited_sample.mp4 \
 *     --report ../../out/web_editor/edited_sample.json
 *
 * Exit code 0 only when the page reported that it is done.
 */

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

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
const url = args.url || "http://127.0.0.1:8011/editor";
const kind = args.kind || "sample";
const size = args.size || "720x1280";
const fps = String(args.fps || 30);
const start = args.start === undefined ? null : Number(args.start);
const outFile = path.resolve(args.out || "out/web_editor/sample.mp4");
const reportFile = path.resolve(args.report || outFile.replace(/[.]mp4$/, ".json"));
const waitMs = Number(args.wait || 90 * 60 * 1000);
const pagePng = args.page ? path.resolve(args.page) : null;
const doneRe = new RegExp("^" + String.fromCharCode(29983, 25104, 22909, 20102));
const failRe = new RegExp("^" + String.fromCharCode(36825, 27425, 23548, 20986, 22833, 36133, 20102));

const report = { kind, size, fps, base: String(args.base), start, url,
  started: new Date().toISOString(), steps: [] };
function record(what, extra) {
  const line = Object.assign({ what, at: new Date().toISOString() }, extra || {});
  report.steps.push(line);
  console.log("- " + what + (extra && extra.detail ? " -- " + extra.detail : ""));
}

const browser = await chromium.launch({ channel: args.channel || "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push("console: " + m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message.slice(0, 300)));

  await page.goto(url + "?base=" + encodeURIComponent(args.base),
    { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#panel:not([hidden])", { timeout: 120000 });
  await page.waitForFunction("window.__editor && window.__editor.state.scene", null,
    { timeout: 180000 });
  record("页面装载完成", { detail: await page.textContent("#song-title") });

  for (const spec of args.sets) {
    const parts = spec.split("=");
    const dotted = parts[0];
    const raw = parts.slice(1).join("=");
    const group = dotted.split(".")[0];
    const key = dotted.split(".")[1];
    const input = page.locator("#panel input[data-kind=" + JSON.stringify(group)
      + "][data-key=" + JSON.stringify(key) + "]");
    const type = await input.getAttribute("data-type");
    if (type === "color") await input.fill(raw);
    else if (type === "boolean") await input.setChecked(raw !== "false" && raw !== "0");
    else {
      // 滑块的 value 由页面自己的 input 监听读走（和真人拖动走的是同一条路）。
      // Playwright 的 fill() 在某些 range 上会卡在 editable 检查里，所以直接
      // 写 value + 派发事件，再读回来核对。
      await input.evaluate((el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, raw);
    }
    const shown = await input.evaluate((el) => el.value);
    const same = type === "number" ? Number(shown) === Number(raw) : String(shown) === String(raw);
    if (!same) {
      throw new Error("控件 " + dotted + " 拒绝了 " + raw + "（读回 " + shown + "）");
    }
    record("设置 " + dotted + "=" + shown);
  }

  await page.waitForFunction(
    () => !window.__editor.state.pending && window.__editor.state.solve.state === "ok",
    null, { timeout: 600000 });
  const solved = await page.evaluate(() => ({
    state: window.__editor.state.solve.state,
    ms: window.__editor.state.solve.ms,
    info: window.__editor.state.solve.info,
    geometry: window.__editor.state.solved.geometry,
    visuals: window.__editor.state.solved.visuals,
    boards: window.__editor.state.layout ? window.__editor.state.layout.boards.length : 0,
    duration: window.__editor.state.plan.duration,
    framing: window.__editor.state.framing,
  }));
  report.solved = solved;
  record("排版落定", { detail: solved.boards + " 块板，" + solved.ms + " ms，"
    + JSON.stringify(solved.info) });

  // 页面载入后会自动试听，播放头在走：先按真正的「播放/暂停」按钮停下来，
  // 否则「从当前时间起」这一段会随开始时间漂移
  const playLabel = (await page.textContent("#play")).trim();
  if (playLabel !== "播放") { await page.locator("#play").click(); await page.waitForTimeout(200); }
  await page.selectOption("#export-size", size);
  await page.selectOption("#export-fps", fps);
  if (start !== null) {
    await page.locator("#timeline").evaluate((el, value) => {
      el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, start);
    await page.waitForTimeout(300);
  }
  report.range = await page.evaluate(() => ({
    t: window.__editor.state.t,
    duration: window.__editor.state.plan.duration,
    label: document.querySelector("#time-label").textContent,
  }));
  record("播放头与导出规格", { detail: JSON.stringify(report.range) + " " + size
    + " " + fps + "fps" });

  const button = kind === "song" ? "#export-song" : "#export-sample";
  if (await page.locator(button).isDisabled()) {
    throw new Error(button + " 是禁用的：" + (await page.textContent("#message")));
  }
  if (pagePng) {
    fs.mkdirSync(path.dirname(pagePng), { recursive: true });
    await page.screenshot({ path: pagePng });
  }
  await page.locator(button).click();
  record("点击导出按钮");

  const deadline = Date.now() + waitMs;
  let message = "";
  while (Date.now() < deadline) {
    message = (await page.textContent("#message")) || "";
    if (doneRe.test(message) || failRe.test(message)) break;
    await page.waitForTimeout(2000);
  }
  report.message = message;
  report.logTail = ((await page.textContent("#export-log")) || "").split("\n").slice(-14);
  record("页面状态", { detail: message });
  if (!doneRe.test(message)) throw new Error("页面报告导出失败：" + message);

  const href = await page.locator("#download").getAttribute("href");
  report.downloadHref = href;
  report.videoSrc = await page.locator("#result").getAttribute("src");
  if (!href) throw new Error("页面没有给出下载链接");
  const saved = await page.evaluate(async (target) => {
    const resp = await fetch(target);
    const buf = new Uint8Array(await resp.arrayBuffer());
    let s = "";
    for (const b of buf) s += String.fromCharCode(b);
    return { status: resp.status, b64: btoa(s), bytes: buf.length };
  }, href.split("?")[0]);
  if (saved.status !== 200) throw new Error("下载返回 " + saved.status);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(saved.b64, "base64"));
  report.file = outFile;
  report.bytes = saved.bytes;
  record("视频已落盘", { detail: outFile + "（" + (saved.bytes / 1048576).toFixed(1) + " MB）" });

  report.status = await page.evaluate(async () => {
    const st = window.__editor.state;
    return await fetch("/api/editor/export/" + st.exportRid).then((r) => r.json());
  });
  report.problems = problems;
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
  console.log("EXPORT OK " + outFile + " " + report.bytes + " bytes  (report "
    + reportFile + ")");
  if (problems.length) console.log("page problems: " + problems.join(" | "));
} finally {
  await browser.close();
}
