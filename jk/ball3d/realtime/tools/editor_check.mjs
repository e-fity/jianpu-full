#!/usr/bin/env node
/**
 * Drive the **real** editor page in the installed Edge and check that the
 * controls do something, not just that the labels render.
 *
 * It is the browser half of the editor regression: the API tests can prove the
 * server validates a payload, but only a real page can prove that dragging the
 * plank-width slider re-solves the layout, that a look change re-renders the
 * same layout, that seeking lands on a deterministic frame, that reset/save/load
 * move the panel, and that no console error was printed on the way.
 *
 * Usage:
 *   node realtime/tools/editor_check.mjs --url http://127.0.0.1:8011 \
 *     --base 1 --out out/web_editor/preview_editor.png --json report.json \
 *     [--headful] [--timeout 120000]
 *
 * Exit code is 0 only when every check passed and no page error was collected.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) { values[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { values[name] = next; i += 1; }
    else flags.add(name);
  }
  return { values, flags };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * FNV-1a over a 64x64 readback of the preview canvas, plus honest brightness
 * statistics: the channel means (0..255 each) and how many distinct values the
 * picture uses.  A blank canvas is one flat colour; a rendered scene is not.
 */
const PIXEL_SIGNATURE = `(() => {
  const view = document.getElementById("view");
  const scratch = document.createElement("canvas");
  scratch.width = 64; scratch.height = 64;
  const ctx = scratch.getContext("2d");
  ctx.drawImage(view, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  let hash = 0x811c9dc5;
  const sum = [0, 0, 0];
  const levels = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
    levels.add(Math.round(lum / 4));
    hash ^= Math.round(lum);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const n = data.length / 4;
  return { hash: hash.toString(16), mean: [sum[0], sum[1], sum[2]].map((v) => Math.round(v / n)),
           levels: levels.size };
})()`;

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const base = values.base || "10";
  const url = (values.url || "http://127.0.0.1:8011").replace(/\/$/, "");
  const out = values.out ? path.resolve(values.out) : null;
  const jsonPath = values.json ? path.resolve(values.json) : null;
  const timeout = Number(values.timeout || 180000);
  const checks = [];
  const consoleErrors = [];
  const started = Date.now();

  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
    return ok;
  };
  const require = (name, ok, detail) => {
    if (!check(name, ok, detail)) throw new Error(`check failed: ${name} (${detail || ""})`);
  };

  const browser = await chromium.launch({
    channel: "msedge", headless: !flags.has("headful"),
    args: flags.has("no-sandbox") ? ["--no-sandbox"] : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, acceptDownloads: true,
  });
  const page = await context.newPage();
  // Count every write to media currentTime: writing it per animation frame
  // restarts the decoder position 60 times a second and makes playback stutter.
  await context.addInitScript(() => {
    window.__ctWrites = 0;
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "currentTime");
    Object.defineProperty(proto, "currentTime", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(value) { window.__ctWrites += 1; return desc.set.call(this, value); },
    });
  });
  const failedResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && !/favicon/i.test(response.url())) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // "Failed to load resource" carries no URL; the response listener above
    // records the real ones, so this bare line is noise, not a finding.
    if (/Failed to load resource/.test(text)) return;
    consoleErrors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const report = { url, base, checks, consoleErrors, timings: {} };
  try {
    // ── 0. the served bundle is the current source, not a stale build ─────
    const bundle = await page.request.get(`${url}/editor/bundle.js`);
    const bundleText = await bundle.text();
    const bundleFeatures = {
      panel_unhide: /panel"\)\.hidden\s*=\s*!1|panel"\)\.hidden\s*=\s*false/.test(bundleText),
      base_preselect: bundleText.includes("URLSearchParams"),
      song_race_token: bundleText.includes("songToken"),
      commit_on_valid: bundleText.includes("visuals: structuredClone(state.settings.visuals)"),
      audio_clock: bundleText.includes("readyState >= 2"),
      export_capped: bundleText.includes("capped"),
    };
    report.bundle = { bytes: bundleText.length, features: bundleFeatures };
    require("页面拿到的是当前源码编出来的包（不是旧的构建）",
      bundle.ok() && Object.values(bundleFeatures).every(Boolean),
      `${bundleText.length} 字节 ${JSON.stringify(bundleFeatures)}`);

    const t0 = Date.now();
    await page.goto(`${url}/editor?base=${encodeURIComponent(base)}`,
      { waitUntil: "domcontentloaded", timeout });
    await page.waitForFunction("window.__editor && document.getElementById('panel') && !document.getElementById('panel').hidden",
      null, { timeout });
    report.timings.boot_ms = Date.now() - t0;

    // ── 1. the page really solved the song it was asked for ────────────────
    // (and the scene that draws it is up: building it awaits the GLB)
    await page.waitForFunction(
      "window.__editor.state.solve.state === 'ok' && window.__editor.state.scene",
      null, { timeout });
    const boot = await page.evaluate(`(() => {
      const s = window.__editor.state;
      return {
        song: s.song, songLabel: s.songLabel, duration: s.plan.duration,
        sounding: s.plan.counts.sounding, boards: s.layout.boards.length,
        kit: { w: s.kit.BOARD_W, h: s.kit.BOARD_H, d: s.kit.BOARD_D, r: s.kit.BALL_R,
               dx: s.kit.DX_MIN, contact: s.kit.CONTACT_OFF },
        solve: s.solve, framing: s.framing, constants: s.scene.stats().constants,
        geometry: s.scene.stats().geometry, camera: s.scene.stats().camera,
      };
    })()`);
    report.boot = boot;
    require("载入曲库歌曲并求解", boot.song && boot.song.base === base, `base=${base} 板 ${boot.boards} 块`);
    require("求解审计通过（forced/clearance/重叠全为 0）",
      boot.solve.state === "ok",
      `forced ${(boot.solve.info||{}).forced}，clearance ${(boot.solve.info||{}).clearance_fails}，重叠 ${(boot.solve.info||{}).plank_overlaps}`);
    require("绘制尺寸与 layout 常量一致（真实模型，不是只改碰撞盒）",
      boot.geometry.ok
      && Math.abs(boot.geometry.board_size[0] - boot.kit.w) < 1e-6
      && Math.abs(boot.geometry.board_size[1] - boot.kit.h) < 1e-6
      && Math.abs(boot.geometry.board_size[2] - boot.kit.d) < 1e-6
      && Math.abs(boot.geometry.drawn_ball_r - boot.kit.r) < 1e-6,
      `drawn ${JSON.stringify(boot.geometry.board_size)} ball ${boot.geometry.drawn_ball_r} ` +
      `vs layout ${boot.kit.w}x${boot.kit.h}x${boot.kit.d} r${boot.kit.r}`);

    // ── 2. the preview is a real render, the panel is fully on screen ──────
    const pixels0 = await page.evaluate(PIXEL_SIGNATURE);
    report.pixels = { boot: pixels0 };
    require("预览画布是真实渲染（不是空白，也不是一片糊）",
      pixels0.mean.every((v) => v > 8 && v < 247) && pixels0.levels > 12,
      `RGB 均值 ${pixels0.mean.join("/")}，灰阶档数 ${pixels0.levels}`);
    const visible = await page.evaluate(`(() => {
      const ids = ["view", "play", "timeline", "geometry-rows", "visual-rows",
                   "export-sample", "export-song"];
      const out = {};
      for (const id of ids) {
        const node = document.getElementById(id);
        const rect = node.getBoundingClientRect();
        out[id] = { w: Math.round(rect.width), h: Math.round(rect.height),
                    top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      }
      out.window = { w: window.innerWidth, h: window.innerHeight };
      out.rows = { geometry: document.querySelectorAll("#geometry-rows .row").length,
                   visuals: document.querySelectorAll("#visual-rows .row").length };
      return out;
    })()`);
    report.layout = visible;
    require("桌面上控制面板完整可见（不叠在一起）",
      visible.view.w > 200 && visible.view.h <= visible.window.h * 0.66
      && visible.rows.geometry === 5 && visible.rows.visuals === 12
      && visible.timeline.top < visible.window.h
      && visible["export-sample"].bottom <= visible.window.h,
      `预览 ${visible.view.w}x${visible.view.h}px，尺寸 ${visible.rows.geometry} 行，`
      + `外观 ${visible.rows.visuals} 行，导出按钮底 ${visible["export-sample"].bottom}`
      + `/${visible.window.h}`);

    // ── 3. geometry really changes the solved layout ───────────────────────
    const reshape = async (key, value) => page.evaluate(`(() => {
      const input = document.querySelector('#panel input[data-key="${key}"]');
      input.value = "${value}";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const waitSolve = async (ms) => {
      const key = await page.evaluate("window.__editor.state.solvedKey");
      await page.waitForFunction(`window.__editor.state.solve.state === 'ok'
        && window.__editor.state.solvedKey !== ${JSON.stringify(key)}`, null,
      { timeout: ms || timeout });
      return page.evaluate("window.__editor.state.solvedKey");
    };

    const snap = () => page.evaluate(`(() => {
      const s = window.__editor.state;
      return {
        key: s.solvedKey,
        boards: s.layout.boards.length,
        onsets: s.layout.boards.map((b) => b.t),
        apexes: s.layout.boards.map((b) => (b.collision ? b.collision.apex : 0)),
        durations: s.layout.boards.map((b) => (b.collision ? b.collision.drop : 0)),
        constants: s.layout.constants,
        solve_ms: s.solve.ms,
        audit: s.solve.info,
      };
    })()`);

    const before = await snap();
    const t1 = Date.now();
    await reshape("board_w", 0.36);
    const keyWidth = await waitSolve();
    const afterWidth = await snap();
    report.timings.resolve_ms = Date.now() - t1;
    let differing = 0;
    for (let i = 0; i < Math.min(before.boards, afterWidth.boards); i += 1) {
      if (Math.abs(before.apexes[i] - afterWidth.apexes[i]) > 1e-6
        || Math.abs(before.durations[i] - afterWidth.durations[i]) > 1e-6) differing += 1;
    }
    report.geometry = { before, after: afterWidth, boards_changed: differing };
    require("改板宽真的重新求解并换了一套布局",
      keyWidth !== before.key && afterWidth.constants.board_w === 0.36
      && afterWidth.constants.board_h === 0.072
      && afterWidth.constants.contact_off === 0.18
      && afterWidth.boards > 0,
      `contact_off ${afterWidth.constants.contact_off}，${differing}/${afterWidth.boards} 块弹道变了，` +
      `${report.timings.resolve_ms} ms`);

    // ── 4. the long-note bounce knob: same onsets, different apex ─────────
    const bounceBefore = await snap();
    await reshape("bounce", 1.6);
    await waitSolve();
    const bounceAfter = await snap();
    let apexChanged = 0;
    for (let i = 0; i < bounceBefore.apexes.length; i += 1) {
      if (Math.abs(bounceBefore.apexes[i] - bounceAfter.apexes[i]) > 1e-6) apexChanged += 1;
    }
    const onsetsEqual = JSON.stringify(bounceBefore.onsets) === JSON.stringify(bounceAfter.onsets);
    report.bounce = { apex_changed: apexChanged, onsets_equal: onsetsEqual,
                      apex_before_max: Math.max(...bounceBefore.apexes),
                      apex_after_max: Math.max(...bounceAfter.apexes) };
    require("长音弹跳偏好改了 apex，onset/音高全不动",
      onsetsEqual && apexChanged > 0,
      `${apexChanged} 块 apex 变了（最大 ${report.bounce.apex_before_max} → ${report.bounce.apex_after_max}），` +
      "onset 数组完全一致");
    await reshape("bounce", 1);
    await waitSolve();

    // ── 5. a look change rebuilds the scene but never re-solves ───────────
    const beforeLook = await snap();
    const t2 = Date.now();
    await reshape("exposure", 1.5);
    await page.waitForFunction("window.__editor.state.scene && window.__editor.state.scene.visuals.exposure === 1.5",
      null, { timeout });
    await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))");
    const afterLook = await snap();
    const pixels1 = await page.evaluate(PIXEL_SIGNATURE);
    report.look = { solve_ms_before: beforeLook.solve_ms, solve_ms_after: afterLook.solve_ms,
                    pixels_before: pixels0.hash, pixels_after: pixels1.hash };
    report.pixels.exposure = pixels1;
    require("改曝光只重建场景、不重跑物理",
      afterLook.key === beforeLook.key && afterLook.solve_ms === beforeLook.solve_ms,
      `solvedKey 未变（${beforeLook.solve_ms} ms 那次求解被复用），用时 ${Date.now() - t2} ms`);
    require("改曝光真的改了导出用的画面", pixels1.hash !== pixels0.hash,
      `${pixels0.hash} → ${pixels1.hash}`);

    const pixels2 = await page.evaluate(`(async () => {
      const input = document.querySelector('#panel input[data-key="wall_color"]');
      input.value = "#8a4a2a";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
      return ${PIXEL_SIGNATURE};
    })()`);
    report.pixels.wall = pixels2;
    require("改墙色真的改了画面", pixels2.hash !== pixels1.hash, `${pixels1.hash} → ${pixels2.hash}`);

    // 板色乘上「彩色强度」才画得出来：强度是 0 时动板色必须自己把强度抬起来，
    // 不能是个看起来坏掉的控件
    const tint = await page.evaluate(`(async () => {
      const set = (key, value) => {
        const input = document.querySelector('#panel input[data-key="' + key + '"]');
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input;
      };
      set("board_tint", 0);
      await new Promise(r => setTimeout(r, 400));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
      const flat = ${PIXEL_SIGNATURE};
      set("board_color", "#2f7d5a");                 // 动板色
      await new Promise(r => setTimeout(r, 500));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
      const shifted = ${PIXEL_SIGNATURE};
      return { flat, shifted, tint: window.__editor.state.solved.visuals.board_tint,
               message: document.getElementById("message").textContent };
    })()`);
    report.pixels.tint = { hash: tint.shifted.hash, tint_after: tint.tint };
    require("强度为 0 时动板色会把强度抬起来（不是死控件）",
      tint.tint > 0 && tint.shifted.hash !== tint.flat.hash,
      `强度 0 → ${tint.tint}，画面 ${tint.flat.hash} → ${tint.shifted.hash}：「${tint.message.slice(0, 40)}…」`);

    // 板色必须同时管住「发光」：以前发光读的是调色板，所以刷成棕/青的板
    // 还是发原来的黄/粉光。这里在同一帧把光晕关掉再相减，量出真正的发光颜色。
    const glowCheck = await page.evaluate(`(async () => {
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
      // 找一刻「只有一块板在发光」的时间：关掉光晕再相减，差出来的就是它的光
      const boards = state.layout.boards;
      let pick = { t: 0, slot: -1, strength: 0, index: -1, lit: 0 };
      for (let i = 0; i < boards.length; i += 3) {
        const t = boards[i].t + 0.02;
        state.scene.update(t);
        const st = boardsMesh().geometry.getAttribute("aGlow");
        let best = 0, slot = -1, lit = 0;
        for (let k = 0; k < st.count; k += 1) {
          if (st.array[k] > 0.01) lit += 1;
          if (st.array[k] > best) { best = st.array[k]; slot = k; }
        }
        if (best > pick.strength) pick = { t: t, slot: slot, strength: best, index: i, lit: lit };
        if (best > 0.5 && lit === 1) break;
      }
      const hue = (c) => {
        const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        if (!(d > 0)) return null;
        let h = max === r ? (((g - b) / d) % 6) : (max === g ? (b - r) / d + 2 : (r - g) / d + 4);
        return Math.round(((h * 60) + 360) % 360 * 10) / 10;
      };
      const emission = (a, b) => {
        let n = 0, sum = [0, 0, 0], box = null;
        for (let i = 0; i < a.data.length; i += 4) {
          const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
            + Math.abs(a.data[i + 2] - b.data[i + 2]);
          if (d <= 24) continue;
          n += 1;
          sum[0] += b.data[i]; sum[1] += b.data[i + 1]; sum[2] += b.data[i + 2];
          const px = (i / 4) % a.w, py = Math.floor((i / 4) / a.w);
          box = box ? [Math.min(box[0], px), Math.min(box[1], py),
            Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py];
        }
        const mean = n ? sum.map((v) => Math.round(v / n)) : [0, 0, 0];
        return { pixels: n, mean: mean, box: box, hue: n ? hue(mean) : null };
      };
      const read = async (tint) => {
        await setPanel("board_tint", tint);
        await setPanel("board_color", "#2f7d5a");
        await setPanel("board_tint", tint);
        await setPanel("glow", 1);
        const lit = shot(pick.t);
        const mesh = boardsMesh();
        const st = mesh.geometry.getAttribute("aGlow");
        const gc = mesh.geometry.getAttribute("aGlowColor");
        const ic = mesh.instanceColor;
        const slot = pick.slot;
        const e = mesh.instanceMatrix.array;
        const at = mesh.position.clone().set(e[slot * 16 + 12], e[slot * 16 + 13],
          e[slot * 16 + 14]);
        at.project(state.scene.camera);
        await setPanel("glow", 0);
        const off = shot(pick.t);
        await setPanel("glow", 1);
        return {
          tint: state.scene.visuals.board_tint,
          diffuse: [ic.array[slot * 3], ic.array[slot * 3 + 1], ic.array[slot * 3 + 2]],
          glow: [gc.array[slot * 3], gc.array[slot * 3 + 1], gc.array[slot * 3 + 2]],
          strength: st.array[slot],
          lit_slots: Array.from(st.array).filter((x) => x > 0.01).length,
          gain: state.kit.BOARD_GLOW_GAIN,
          at: [Math.round((at.x * 0.5 + 0.5) * lit.w), Math.round((1 - (at.y * 0.5 + 0.5)) * lit.h)],
          frame: [lit.w, lit.h],
          emission: emission(lit, off),
        };
      };
      const flat = await read(0);
      const tinted = await read(1);
      return { t: pick.t, board: pick.index, flat: flat, tinted: tinted };
    })()`);
    report.pixels.glow = glowCheck;
    const hueOf = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const h = max === r ? (((g - b) / d) % 6)
        : (max === g ? (b - r) / d + 2 : (r - g) / d + 4);
      return ((h * 60) + 360) % 360;
    };
    const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
    const wantHue = hueOf("#2f7d5a");
    const linToHex = (v) => {
      const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
    };
    const tintedHex = "#" + glowCheck.tinted.diffuse.map(linToHex).join("");
    // 1) 真正的渲染：把光晕关掉再相减，命中的那块板发出来的光就是这个色相
    require("板色也管发光：强度 1 时，命中的板发出的光就是选的那个颜色的色相",
      glowCheck.tinted.emission.pixels > 50
      && glowCheck.tinted.emission.hue !== null
      && hueGap(glowCheck.tinted.emission.hue, wantHue) < 25,
      `发光色相 ${glowCheck.tinted.emission.hue}（要的是 #2f7d5a 的 ${wantHue.toFixed(1)}），`
      + `关光晕相减得到 ${glowCheck.tinted.emission.pixels} 个像素，均值 `
      + `rgb(${glowCheck.tinted.emission.mean.join(",")})`);
    require("原来的黄/粉光真的被换掉了（不是只在旁边加了一层）",
      glowCheck.flat.emission.hue !== null
      && hueGap(glowCheck.flat.emission.hue, wantHue) > 20,
      `强度 0 时发光色相 ${glowCheck.flat.emission.hue}，换了颜色以后 `
      + `${glowCheck.tinted.emission.hue}`);
    // 2) 发光是局部的：只有命中的那块板亮，差出来的像素也只围着它
    const box = glowCheck.tinted.emission.box || [0, 0, 0, 0];
    require("发光只落在命中的那块板上",
      glowCheck.tinted.lit_slots === 1 && glowCheck.tinted.strength > 0.5
      && (box[2] - box[0]) < glowCheck.tinted.frame[0] * 0.25
      && (box[3] - box[1]) < glowCheck.tinted.frame[1] * 0.25,
      `亮的板 ${glowCheck.tinted.lit_slots} 块，强度 `
      + `${glowCheck.tinted.strength.toFixed(2)}，变化区域 `
      + `${box[2] - box[0]}x${box[3] - box[1]} 像素（画布 `
      + `${glowCheck.tinted.frame.join("x")}）`);
    // 3) 两个通道用的是同一个最终颜色：发光 = 漫反射 x BOARD_GLOW_GAIN
    const gainOk = [0, 1, 2].every((i) => Math.abs(glowCheck.tinted.glow[i]
      - glowCheck.tinted.diffuse[i] * glowCheck.tinted.gain) < 1e-5);
    require("发光和漫反射共用同一个最终颜色（发光 = 板色 x 1.6）",
      gainOk && Math.abs(glowCheck.tinted.gain - 1.6) < 1e-9,
      `glow ${glowCheck.tinted.glow.map((v) => v.toFixed(4)).join(",")} vs `
      + `diffuse x ${glowCheck.tinted.gain}`);
    require("强度 1 时板子画出来的就是选的那个颜色",
      tintedHex === "#2f7d5a", `${tintedHex}`);
    // 出厂设置（强度 0）必须和加这个功能之前一模一样：发光就是调色板色 x 1.6
    require("强度 0（出厂）时发光还是调色板色 x 1.6，一个数都不差",
      [0, 1, 2].every((i) => Math.abs(glowCheck.flat.glow[i]
        - glowCheck.flat.diffuse[i] * glowCheck.flat.gain) < 1e-5)
      && glowCheck.flat.tint === 0,
      `glow ${glowCheck.flat.glow.map((v) => v.toFixed(4)).join(",")} = 调色板 `
      + `${glowCheck.flat.diffuse.map((v) => v.toFixed(4)).join(",")} x 1.6`);

    // ── 6. transport: play, pause, seek, audio stays in step ──────────────
    // The page starts playing as soon as the song is solved; start from a known
    // paused state so the click below really means "play".
    await page.evaluate("window.__editor.pause()");
    await page.evaluate("window.__ctWrites = 0");
    const playStart = await page.evaluate("({ wall: performance.now(), t: window.__editor.state.t })");
    await page.click("#play");
    await sleep(2000);
    const playing = await page.evaluate(`(() => {
      const s = window.__editor.state;
      const audio = document.getElementById("audio");
      return { t: s.t, playing: s.playing, label: document.getElementById("time-label").textContent,
               audioSrc: Boolean(audio.src), audioTime: audio.currentTime,
               audioPaused: audio.paused, audioReady: audio.readyState,
               writes: window.__ctWrites, wall: performance.now() };
    })()`);
    const wallAdvance = (playing.wall - playStart.wall) / 1000;
    const tAdvance = playing.t - playStart.t;
    const sounded = !playing.audioPaused && playing.audioReady >= 2
      && playing.audioTime > playStart.t + 1.0;
    report.audioClock = { writes: playing.writes, wall_advance: wallAdvance,
      t_advance: tAdvance, drift: tAdvance - wallAdvance, audioTime: playing.audioTime,
      sounded, audioPaused: playing.audioPaused, audioReady: playing.audioReady };
    require("播放时几乎不写 audio.currentTime（不是每帧都在 seek）",
      playing.writes <= 3, `2 秒里写了 ${playing.writes} 次`);
    require("播放时画面按真实时间走（不管声音开不开）",
      tAdvance > 1.5 && Math.abs(tAdvance - wallAdvance) < 0.35,
      `2 秒里推进 ${tAdvance.toFixed(2)}s（墙钟 ${wallAdvance.toFixed(2)}s）`);
    require("有声音时，声音和画面是同一个时钟（没有各跑各的）",
      sounded ? Math.abs(playing.audioTime - playing.t) < 0.25 : playing.audioPaused,
      sounded
        ? `画面 t=${playing.t.toFixed(2)}s，音频 ${playing.audioTime.toFixed(2)}s`
        : `这台机器这次没有出声（paused=${playing.audioPaused} ready=${playing.audioReady}），`
          + `画面仍按真实时间走，也没有每帧去 seek`);
    await page.click("#play");
    await sleep(400);
    const paused = await page.evaluate("({ t: window.__editor.state.t, playing: window.__editor.state.playing })");
    await sleep(400);
    const stillPaused = await page.evaluate("({ t: window.__editor.state.t, playing: window.__editor.state.playing })");
    report.transport = { playing, paused, stillPaused };
    require("播放会推进时间且音频同播", playing.playing && playing.t > 0.3 && playing.audioSrc,
      `t=${playing.t.toFixed(2)}s，${playing.label}`);
    require("暂停后时间与音频都停住",
      !stillPaused.playing && Math.abs(stillPaused.t - paused.t) < 1e-6,
      `t=${stillPaused.t.toFixed(2)}s`);

    const seek = await page.evaluate(`(async () => {
      const slider = document.getElementById("timeline");
      slider.value = "20";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
      const s = window.__editor.state;
      const audio = document.getElementById("audio");
      return { t: s.t, audioTime: audio.currentTime, audioPaused: audio.paused,
               label: document.getElementById("time-label").textContent,
               pixel: ${PIXEL_SIGNATURE} };
    })()`);
    await sleep(300);
    const seekHeld = await page.evaluate("window.__editor.state.t");
    report.seek = { seek, held: seekHeld };
    require("拖时间轴落到确定状态（画面、音频、时间三者对齐且不自己跑）",
      Math.abs(seek.t - 20) < 0.01 && Math.abs(seek.audioTime - 20) < 0.3
      && seek.audioPaused && Math.abs(seekHeld - 20) < 1e-6,
      `t=${seek.t.toFixed(2)}s，音频 ${seek.audioTime.toFixed(2)}s，暂停中`);
    require("拖到别的时间，画面真的换了（不是停在原处）",
      seek.pixel.hash !== pixels2.hash,
      `seek 后 ${seek.pixel.hash}，之前 ${pixels2.hash}`);

    await page.click("#restart");
    await sleep(600);
    await page.click("#play");            // stop the restart's playback again
    await sleep(200);

    // ── 7. save / load / reset, with a Chinese name ───────────────────────
    const saved = await page.evaluate(`(async () => {
      const set = (key, value) => {
        const input = document.querySelector('#panel input[data-key="' + key + '"]');
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set("exposure", 1.35);
      document.getElementById("settings-name").value = "暖色傍晚";
      document.getElementById("save").click();
      await new Promise(r => setTimeout(r, 800));
      set("exposure", 0.55);
      await new Promise(r => setTimeout(r, 300));
      const changed = window.__editor.state.settings.visuals.exposure;
      const names = [...document.getElementById("saved").options].map((o) => o.value);
      document.getElementById("saved").value = "暖色傍晚";
      document.getElementById("load").click();
      await new Promise(r => setTimeout(r, 1200));
      return { changed, loaded: window.__editor.state.settings.visuals.exposure,
               names, message: document.getElementById("message").textContent,
               download: document.getElementById("download-settings").href,
               hidden: document.getElementById("download-settings").hidden };
    })()`);
    report.settings = { saved };
    require("保存/载入设置能把参数搬回去",
      Math.abs(saved.changed - 0.55) < 1e-9 && Math.abs(saved.loaded - 1.35) < 1e-9,
      `0.55 → 载入 ${saved.loaded}（${saved.message}）`);
    require("设置名能写中文，还能整份下载带走",
      saved.names.includes("暖色傍晚") && !saved.hidden
      && String(saved.download).includes("settings"),
      `列表里有「${saved.names.join("、")}」，下载链接 ${saved.download}`);

    const imported = await page.evaluate(`(async () => {
      const file = new File([JSON.stringify({ geometry: { board_w: 0.3, board_d: 0.4,
        ball_r: 0.1, spacing: 0.34, bounce: 1 }, visuals: { exposure: 1.1 } })],
        "导入的外观看.json", { type: "application/json" });
      const input = document.getElementById("import-settings");
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 1800));
      return { exposure: window.__editor.state.settings.visuals.exposure,
               message: document.getElementById("message").textContent };
    })()`);
    report.import = imported;
    require("导入一份设置 JSON 也能用",
      Math.abs(imported.exposure - 1.1) < 1e-9, `exposure=${imported.exposure}（${imported.message}）`);

    const reset = await page.evaluate(`(async () => {
      document.getElementById("reset").click();
      await new Promise(r => setTimeout(r, 1500));
      const s = window.__editor.state;
      const panel = window.__editor.readPanel();
      return { settings: s.settings, panel, solve: s.solve.state,
               key: s.solvedKey, message: document.getElementById("message").textContent };
    })()`);
    const defaults = await page.evaluate("fetch('/api/editor/schema').then(r => r.json()).then(d => d.defaults)");
    report.reset = { settings: reset.settings, defaults, panel: reset.panel };
    // key order is not part of the contract: compare canonically
    const canon = (value) => JSON.stringify(value, (key, v) => (
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
        : v));
    const wantSettings = canon({ ...defaults, schema: reset.settings.schema });
    const wantPanel = canon({ ...defaults, schema: reset.panel.schema });
    require("恢复默认把面板与几何都带回出厂值",
      canon(reset.settings) === wantSettings && canon(reset.panel) === wantPanel
      && reset.solve === "ok",
      `settings=${canon(reset.settings) === wantSettings} `
      + `panel=${canon(reset.panel) === wantPanel} solve=${reset.solve}`);

    // ── 8. a geometry that does not solve: no fake success, no lost preview ─
    const broken = await page.evaluate(`(async () => {
      const set = (key, value) => {
        const input = document.querySelector('#panel input[data-key="' + key + '"]');
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const before = { key: window.__editor.state.solvedKey,
                       used: window.__editor.state.scene.layout.constants.board_w,
                       samples: window.__editor.state.layout.boards.length,
                       pixel: ${PIXEL_SIGNATURE},
                       sampleDisabled: document.getElementById("export-sample").disabled,
                       songDisabled: document.getElementById("export-song").disabled };
      set("board_w", 0.4); set("spacing", 0.5);
      set("board_d", 0.28); set("ball_r", 0.07); set("bounce", 1.0);
      await new Promise(r => setTimeout(r, 120));
      const pending = { disabled: document.getElementById("export-sample").disabled,
                        note: !document.getElementById("pending-note").hidden,
                        solved: window.__editor.state.solvedKey };
      await new Promise(r => setTimeout(r, 3000));
      const after = { state: window.__editor.state.solve.state,
                      key: window.__editor.state.solvedKey,
                      used: window.__editor.state.scene.layout.constants.board_w,
                      ready: window.__editor.state.solve.state === "ok",
                      samples: window.__editor.state.layout.boards.length,
                      pixel: ${PIXEL_SIGNATURE},
                      sampleDisabled: document.getElementById("export-sample").disabled,
                      songDisabled: document.getElementById("export-song").disabled,
                      message: document.getElementById("message").textContent,
                      status: document.getElementById("solve-status").textContent };
      return { before, pending, after };
    })()`);
    report.broken = broken;
    require("一改尺寸就先把导出停掉（不能拿旧结果当成功）",
      broken.pending.disabled && broken.pending.note,
      `停用=${broken.pending.disabled}，提示=${broken.pending.note}`);
    require("排不开时：导出停用、画面与排版留在上一次能用的版本、并说明原因",
      broken.after.state === "failed" && broken.after.sampleDisabled
      && broken.after.songDisabled
      && broken.after.used === broken.before.used
      && broken.after.key === broken.before.key
      && broken.after.samples === broken.before.samples
      && broken.after.pixel.hash === broken.before.pixel.hash
      && broken.after.message.length > 0,
      `状态=${broken.after.state}，用的还是板宽 ${broken.after.used}（请求的是 0.4），`
      + `画面 ${broken.before.pixel.hash}==${broken.after.pixel.hash}：`
      + `"${broken.after.message}"`);

    const recovered = await page.evaluate(`(async () => {
      document.getElementById("reset").click();
      await new Promise(r => setTimeout(r, 3500));
      const s = window.__editor.state;
      return { state: s.solve.state, key: s.solvedKey,
               disabled: document.getElementById("export-song").disabled,
               boards: s.layout.boards.length };
    })()`);
    report.recovered = recovered;
    require("恢复默认后又能排版、导出重新可用",
      recovered.state === "ok" && !recovered.disabled,
      `${recovered.boards} 块板，导出可用=${!recovered.disabled}`);

    // ── 9. a still frame the export can be compared against ───────────────
    const still = await page.evaluate(`(async () => {
      await window.__editor.snapshot(5, "preview_frame", { width: 720, height: 1280 });
      const view = document.getElementById("view");
      return { w: view.width, h: view.height };
    })()`);
    report.still = still;
    require("拍了一张与导出同设置/同绝对时间/同分辨率的对比图",
      still.w === 432 && still.h === 768, `预览尺寸恢复为 ${still.w}x${still.h}`);

    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out, fullPage: true });
      report.screenshot = out;
      check("整页截图已保存", fs.existsSync(out), out);
    }
  } catch (error) {
    checks.push({ name: "run", ok: false, detail: String(error.message || error) });
    report.error = String(error.message || error);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  report.consoleErrors = consoleErrors;
  report.failedResponses = failedResponses;
  checks.push({ name: "浏览器控制台没有报错、也没有请求失败",
    ok: consoleErrors.length === 0 && failedResponses.length === 0,
    detail: [...consoleErrors, ...failedResponses].slice(0, 4).join(" | ") || null });
  report.ok = checks.every((c) => c.ok);
  report.ms = Date.now() - started;
  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1), "utf8");
  }
  console.log(`\n${report.ok ? "EDITOR OK" : "EDITOR FAILED"} in ${(report.ms / 1000).toFixed(1)}s ` +
    `(${checks.filter((c) => c.ok).length}/${checks.length} checks)`);
  if (!report.ok) {
    for (const c of checks.filter((x) => !x.ok)) console.log(`  FAILED: ${c.name} -- ${c.detail}`);
    process.exitCode = 1;
  }
  return report;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export { main, ROOT };

