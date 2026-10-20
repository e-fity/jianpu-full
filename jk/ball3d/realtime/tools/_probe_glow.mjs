
import { chromium } from "playwright-core";

const url = (process.argv[2] || "http://127.0.0.1:8011").replace(/\/$/, "");
const base = process.argv[3] || "10";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.goto(url + "/editor?base=" + base, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForFunction("window.__editor && window.__editor.state.scene", null, { timeout: 180000 });

const RUN = `(async () => {
  const state = window.__editor.state;
  window.__editor.pause();
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
  const setPanel = async (key, value) => {
    const input = document.querySelector('#panel input[data-key="' + key + '"]');
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 450));
    await raf2();
  };
  const boardsMesh = () => {
    let m = null;
    state.scene.scene.traverse((o) => {
      if (o.isInstancedMesh && o.geometry.getAttribute && o.geometry.getAttribute("aGlowColor")) m = o;
    });
    return m;
  };
  const shot = (t) => {
    state.scene.update(t);
    state.scene.render();
    const view = document.getElementById("view");
    const scratch = document.createElement("canvas");
    scratch.width = view.width; scratch.height = view.height;
    const ctx = scratch.getContext("2d");
    ctx.drawImage(view, 0, 0);
    return { data: ctx.getImageData(0, 0, view.width, view.height).data,
             w: view.width, h: view.height };
  };
  const stats = (a, b, at, size) => {
    let n = 0, sum = [0, 0, 0], box = null;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d <= 24) continue;
      n += 1;
      sum[0] += b.data[i]; sum[1] += b.data[i + 1]; sum[2] += b.data[i + 2];
      const p = (i / 4) % a.w, q = Math.floor((i / 4) / a.w);
      box = box ? [Math.min(box[0], p), Math.min(box[1], q), Math.max(box[2], p), Math.max(box[3], q)]
                : [p, q, p, q];
    }
    const mean = n ? sum.map((v) => Math.round(v / n)) : [0, 0, 0];
    return { pixels: n, mean: mean, box: box,
      green_index: Math.round((mean[1] - (mean[0] + mean[2]) / 2) * 100) / 100,
      warm_index: Math.round((mean[0] - mean[2]) * 100) / 100 };
  };
  // pick a time where exactly one board is glowing
  const boards = state.layout.boards;
  let pick = { t: 0, slot: -1, strength: 0, index: -1 };
  for (let i = 0; i < boards.length; i += 1) {
    const t = boards[i].t + 0.02;
    state.scene.update(t);
    const st = boardsMesh().geometry.getAttribute("aGlow");
    let best = 0, slot = -1, lit = 0;
    for (let k = 0; k < st.count; k += 1) {
      if (st.array[k] > 0.01) lit += 1;
      if (st.array[k] > best) { best = st.array[k]; slot = k; }
    }
    if (best > pick.strength && lit === 1) pick = { t: t, slot: slot, strength: best, index: i };
  }
  const t = pick.t;
  const read = async (tint, color) => {
    await setPanel("board_tint", tint);
    await setPanel("board_color", color);
    await setPanel("board_tint", tint);
    await setPanel("glow", 1);
    const lit = shot(t);
    const mesh = boardsMesh();
    const st = mesh.geometry.getAttribute("aGlow");
    const gc = mesh.geometry.getAttribute("aGlowColor");
    const ic = mesh.instanceColor;
    const slot = pick.slot;
    await setPanel("glow", 0);
    const off = shot(t);
    const e = mesh.instanceMatrix.array;
    const v = mesh.position.clone().set(e[slot * 16 + 12], e[slot * 16 + 13], e[slot * 16 + 14]);
    v.project(state.scene.camera);
    return {
      tint: state.scene.visuals.board_tint, color: state.scene.visuals.board_color,
      diff: [ic.array[slot * 3], ic.array[slot * 3 + 1], ic.array[slot * 3 + 2]],
      glow: [gc.array[slot * 3], gc.array[slot * 3 + 1], gc.array[slot * 3 + 2]],
      strength: st.array[slot],
      lit_slots: Array.from(st.array).filter((x) => x > 0.01).length,
      at: [Math.round((v.x * 0.5 + 0.5) * lit.w), Math.round((1 - (v.y * 0.5 + 0.5)) * lit.h)],
      emission: stats(lit, off, null, null),
    };
  };
  const flat = await read(0, "#2f7d5a");
  const tinted = await read(1, "#2f7d5a");
  return { pick: pick, t: t, flat: flat, tinted: tinted };
})()`;

console.log(JSON.stringify(await page.evaluate(RUN), null, 1));
console.log("errors", JSON.stringify(errs));
await browser.close();
