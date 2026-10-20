/**
 * Unit tests for the editor's own layer: settings/video validation, the
 * per-configuration layout instances, and the solve tool the page and the API
 * both call.
 *
 * The physics itself is tested in ``layout.test.mjs``; what matters here is that
 * an editor geometry really reaches the solver, that two configurations cannot
 * bleed into each other, and that the page's gate (``forced``/``clearance``/
 * ``overlap``) is the same one the CLI and the API use.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSettings, normalizeVideo, geometryDefaults, visualDefaults,
  matchedBitrate, SCHEMA_VERSION, VIDEO_SIZES, BITRATE_REF, expectedFrames,
} from "../src/settings.mjs";
import {
  loadKit, layoutFor, geometryKey, geometryOverrides, applyGeometry,
  cacheSizes, clearLayoutCache, clearKitCache, BOARD_H_RATIO,
} from "../src/layout_kit.mjs";
import { solvePlan } from "../tools/solve_layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT_SOURCE = fs.readFileSync(
  path.join(HERE, "..", "src", "layout.mjs"), "utf8");
const PLAN = JSON.parse(fs.readFileSync(
  path.join(HERE, "fixtures", "dense_window.json"), "utf8"));
// 真实整曲的头部（前 70 个落点，335 音的歌）：24 点扫描就是在这条轨迹上
// 漏掉了 56 号板的 1.6 mm 嵌入，见 tools/codex_motion_audit.mjs 的复现说明。
const SONG_HEAD = JSON.parse(fs.readFileSync(
  path.join(HERE, "fixtures", "song_head.json"), "utf8"));

const geometry = (over = {}) => ({ ...geometryDefaults(), ...over });

test("设置：结构不对就拒绝，缺的键用默认值", () => {
  for (const bad of [[], "hello", 3, true]) {
    const out = normalizeSettings(bad);
    assert.equal(out.ok, false, `${JSON.stringify(bad)} 应当被拒绝`);
  }
  for (const bad of [
    { geometry: { ball_w: 0.3 } },
    { unknown_segment: 1 },
    { schema: "web-editor-99" },
    { visuals: { exposure: "亮" } },
    { visuals: { shadows: "yes" } },
    { visuals: { wall_color: "blue" } },
    { geometry: { board_w: 0.9 } },
    { geometry: { board_w: NaN } },
  ]) {
    const out = normalizeSettings(bad);
    assert.equal(out.ok, false, `${JSON.stringify(bad)} 应当被拒绝`);
    assert.ok(out.errors.length > 0);
  }
  // null / 缺省 = 用默认值（文档里写的就是这条，Python 那边一致）
  const modeless = normalizeSettings({ geometry: { board_w: null } });
  assert.equal(modeless.ok, true);
  assert.equal(modeless.value.geometry.board_w, geometryDefaults().board_w);
  assert.deepEqual(modeless.value.geometry, geometryDefaults());
  assert.deepEqual(modeless.value.visuals, visualDefaults());
  assert.equal(modeless.value.schema, SCHEMA_VERSION);
  // 交叉检查（小球 <= 0.6 x 板宽）在当前范围内够不着，但规则本身要在：
  // 把板宽压到下限、小球放到上限，仍是允许的
  const tight = normalizeSettings({ geometry: { board_w: 0.24, ball_r: 0.14 } });
  assert.equal(tight.ok, true);
  assert.equal(tight.value.geometry.ball_r, 0.14);
  // 返回的是新对象：调用方之后改自己的数据，不影响已发出的任务
  const source = { geometry: { board_w: 0.36 }, visuals: { exposure: 1.2 } };
  const checked = normalizeSettings(source);
  source.geometry.board_w = 0.24;
  source.visuals.exposure = 0.4;
  assert.equal(checked.value.geometry.board_w, 0.36);
  assert.equal(checked.value.visuals.exposure, 1.2);
});

test("视频参数：原型链上的名字不算尺寸，类型不对就拒绝", () => {
  const ok = normalizeVideo({ size: "1080x1920", fps: 30, seconds: 10 });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.value.width, ok.value.height], [1080, 1920]);
  assert.equal(ok.value.bitrate, matchedBitrate(1080, 1920, 30));
  assert.equal(ok.value.bitrate_mode, "matched");

  for (const size of ["__proto__", "constructor", "toString", "720x1281", ""]) {
    const out = normalizeVideo({ size });
    assert.equal(out.ok, false, `${size} 不该被当成尺寸`);
    assert.match(out.errors.join(" "), /size/);
  }
  assert.equal(normalizeVideo("720x1280").ok, false);
  assert.equal(normalizeVideo([720, 1280]).ok, false);
  assert.equal(normalizeVideo({ fps: 25 }).ok, false);
  assert.equal(normalizeVideo({ seconds: 0.1 }).ok, false);
  assert.equal(normalizeVideo({ bitrate: 1 }).ok, false);
  const custom = normalizeVideo({ bitrate: 12000000 });
  assert.equal(custom.value.bitrate, 12000000);
  assert.equal(custom.value.bitrate_mode, "custom");
  assert.equal(normalizeVideo({}).value.bitrate, BITRATE_REF);
  assert.deepEqual(Object.keys(VIDEO_SIZES), ["720x1280", "1080x1920"]);
});

test("帧数用编码器那把尺子：小数秒向上取整，二进制近似整数不多要一帧", () => {
  // 175.8384615 秒 @30 = 5275.1538... -> 5276（round 会给 5275，编码器写了 5276 就炸）
  assert.equal(normalizeVideo({ seconds: 175.8384615, fps: 30 }).value.frames, 5276);
  assert.equal(normalizeVideo({ seconds: 0.501, fps: 30 }).value.frames, 16);
  assert.equal(normalizeVideo({ seconds: 10, fps: 30 }).value.frames, 300);
  assert.equal(normalizeVideo({ seconds: 10, fps: 60 }).value.frames, 600);
  // 0.1 * 3 == 0.30000000000000004：这是「刚好整数」，不是「多一点点」
  assert.equal(expectedFrames(0.1 * 3, 30), 9);
  assert.equal(expectedFrames(175.8385276, 30), 5276);
  assert.equal(expectedFrames(175.8385276, 30),
    normalizeVideo({ seconds: 175.8385276, fps: 30 }).value.frames);
});

test("几何常量是联动的：板高、接触点、间距都跟着板宽走", () => {
  const o = geometryOverrides(geometry({ board_w: 0.36, board_d: 0.5,
    ball_r: 0.12, spacing: 0.42 }));
  assert.equal(o.BOARD_W, 0.36);
  assert.equal(o.BOARD_H, Math.round(0.36 * BOARD_H_RATIO * 1e6) / 1e6);
  assert.equal(o.CONTACT_OFF, 0.18);
  assert.equal(o.BOARD_D, 0.5);
  assert.equal(o.BALL_R, 0.12);
  assert.equal(o.DX_MIN, 0.42);
  // 改写后的源码真的带着这些常量
  const text = applyGeometry(LAYOUT_SOURCE, geometry({ board_w: 0.36 }));
  assert.match(text, /^export const BOARD_W = 0\.36;/m);
  assert.match(text, /^export const CONTACT_OFF = 0\.18;/m);
  // 找不到常量 = 报错，不是悄悄不动
  assert.throws(() => applyGeometry("export const NOTHING = 1;", geometry()),
    /layout source has no constant/);
});

test("两个配置各拿一份 layout 模块，参数不会串", async () => {
  clearKitCache();
  clearLayoutCache();
  const wide = await loadKit(LAYOUT_SOURCE, geometry({ board_w: 0.40, spacing: 0.44 }));
  const narrow = await loadKit(LAYOUT_SOURCE, geometry({ board_w: 0.24, spacing: 0.30 }));
  assert.equal(wide.BOARD_W, 0.40);
  assert.equal(narrow.BOARD_W, 0.24);
  // 再拿一次是同一个实例（缓存），但几何仍然互不影响
  const again = await loadKit(LAYOUT_SOURCE, geometry({ board_w: 0.40, spacing: 0.44 }));
  assert.equal(again, wide);
  assert.equal(wide.CONTACT_OFF, 0.20);
  assert.equal(narrow.CONTACT_OFF, 0.12);
  assert.equal(wide.DX_MIN, 0.44);
  assert.equal(narrow.DX_MIN, 0.30);
  assert.notEqual(geometryKey(geometry({ board_w: 0.40, spacing: 0.44 })),
    geometryKey(geometry({ board_w: 0.24, spacing: 0.30 })));

  const a = await layoutFor({ source: LAYOUT_SOURCE, geometry: geometry({ board_w: 0.40, spacing: 0.44 }), plan: PLAN });
  const b = await layoutFor({ source: LAYOUT_SOURCE, geometry: geometry({ board_w: 0.24, spacing: 0.30 }), plan: PLAN });
  assert.notEqual(a.key, b.key);
  assert.equal(a.layout.constants.board_w, 0.40);
  assert.equal(b.layout.constants.board_w, 0.24);
  // 同一首歌 + 同一几何：视觉改动复用同一份解，不会重跑物理
  const a2 = await layoutFor({ source: LAYOUT_SOURCE, geometry: geometry({ board_w: 0.40, spacing: 0.44 }), plan: PLAN });
  assert.equal(a2, a);
  assert.deepEqual(cacheSizes(), { kits: 2, layouts: 2 });
});

test("模块缓存有上限，不会随拖滑块无限涨", async () => {
  clearKitCache();
  clearLayoutCache();
  for (let i = 0; i < 12; i += 1) {
    const w = 0.24 + i * 0.01;
    await loadKit(LAYOUT_SOURCE, geometry({ board_w: w, ball_r: 0.10 }));
  }
  assert.ok(cacheSizes().kits <= 8, `kits=${cacheSizes().kits}`);
  clearKitCache();
  assert.equal(cacheSizes().kits, 0);
});

test("长音滑道尺寸改变，onset/音高/时长一模一样", async () => {
  clearLayoutCache();
  const flat = await layoutFor({ source: LAYOUT_SOURCE,
    geometry: geometry({ bounce: 1.0 }), plan: PLAN });
  const high = await layoutFor({ source: LAYOUT_SOURCE,
    geometry: geometry({ bounce: 1.6 }), plan: PLAN });
  const onsets = (l) => l.layout.boards.map((b) => b.t);
  assert.deepEqual(onsets(high), onsets(flat));
  assert.deepEqual(high.layout.boards.map((b) => b.midi),
    flat.layout.boards.map((b) => b.midi));
  assert.equal(high.layout.duration, flat.layout.duration);
  const sizes = (l) => l.layout.channels.map((c) => c.profile_scale);
  assert.ok(sizes(flat).length > 0, "fixture must include long notes");
  assert.notDeepEqual(sizes(high), sizes(flat));
  assert.equal(flat.layout.audit.forced, 0);
  assert.equal(high.layout.audit.forced, 0);
  assert.equal(high.layout.audit.clearance_fails, 0);
  assert.equal(high.layout.audit.plank_overlaps, 0);
});

test("整曲路径扫描检查新滑道，并拒绝穿过轨迹的木板", async () => {
  clearKitCache();
  const edited = geometry({ board_w: 0.28, board_d: 0.48, ball_r: 0.10,
    spacing: 0.34, bounce: 1.2 });
  const kit = await loadKit(LAYOUT_SOURCE, edited);
  const layout = kit.buildLayout(SONG_HEAD);
  assert.equal(layout.audit.clearance_fails, 0);
  assert.equal(layout.audit.forced, 0);
  assert.equal(layout.audit.plank_overlaps, 0);
  const ride = layout.channels[0];
  assert.ok(ride, "fixture must include a slide");
  const obstacle = { index: 9999, pos: kit.transitionPoint(ride, .5), tilt: 0 };
  const audit = kit.wholePathAudit(layout.segments, [layout.pad, ...layout.boards, obstacle]);
  assert.ok(audit.fails.some(f => f.i === 9999 && f.kind === "ride"));
  assert.ok(audit.min_distance < 0.01);
  assert.ok(kit.FINE_SAMPLES >= 128);
  assert.ok(kit.PATH_SAMPLES >= 128);
});

test("加严扫描没有动默认几何的解（整曲样片依然是同一份轨迹）", async () => {
  clearKitCache();
  clearLayoutCache();
  const coarse = LAYOUT_SOURCE.replace(/export const FINE_SAMPLES = \d+;/,
    "export const FINE_SAMPLES = 24;");
  const poses = (l) => JSON.stringify(l.boards.map((b) => [b.t, b.midi, b.tilt,
    b.top_y, b.pos, b.collision ? b.collision.apex : null]));
  const a = await loadKit(coarse, geometry());
  const b = await loadKit(LAYOUT_SOURCE, geometry());
  assert.equal(poses(a.buildLayout(SONG_HEAD)), poses(b.buildLayout(SONG_HEAD)));
  // 弹跳类几何也一样：默认/dense/tail 的解不因扫描变密而改变
  const c = await loadKit(coarse, geometry({ bounce: 1.3 }));
  const d = await loadKit(LAYOUT_SOURCE, geometry({ bounce: 1.3 }));
  assert.equal(poses(c.buildLayout(SONG_HEAD)), poses(d.buildLayout(SONG_HEAD)));
  assert.equal(d.buildLayout(SONG_HEAD).audit.clearance_fails, 0);
  // 新加严的那套数字在默认几何上也要过关
  const da = d.buildLayout(SONG_HEAD).audit;
  assert.ok(da.path_travel_clearance >= 0.1, String(da.path_travel_clearance));
});

test("发光和漫反射共用同一个最终颜色（同一个色相，tint=0 时和以前一模一样）", async () => {
  // 以前发光读的是调色板（kit.boardGlowColor(board.palette)），漫反射读的是
  // 「板色 x 强度」，于是刷成棕/青的板还在发原来的黄/粉光。现在两边都用同一个
  // 最终颜色：发光 = 最终颜色 x BOARD_GLOW_GAIN，tint=0 时最终颜色就是调色板色，
  // 所以老样子一根头发都不差。
  clearKitCache();
  clearLayoutCache();
  const kit = await loadKit(LAYOUT_SOURCE, geometry());
  assert.equal(kit.BOARD_GLOW_GAIN, 1.6);
  const palette = kit.BOARD_PALETTE[1].rgb;
  const glow = kit.boardGlowColor(palette);
  assert.deepEqual(glow, [palette[0] * 1.6, palette[1] * 1.6, palette[2] * 1.6]);
  // 不传 out 就新建一个（调用方自己存），传了 out 就写进那个数组，免得每帧分配
  assert.deepEqual(kit.boardGlowColor(palette), glow);
  assert.notEqual(kit.boardGlowColor(palette), glow);
  const out = [0, 0, 0];
  assert.equal(kit.boardGlowColor(palette, out), out);
  assert.deepEqual(out, glow);
  // 色相是乘一个正数，所以不变；调色板换一块，发光也跟着换
  const other = kit.boardGlowColor(kit.BOARD_PALETTE[0].rgb);
  assert.ok(other.some((v, i) => Math.abs(v - glow[i]) > 1e-6));
  assert.deepEqual(kit.boardGlowColor([0.028426039963960648, 0.20507873594760895,
    0.10224173218011856]).map((v) => Math.round(v * 1e4) / 1e4),
    [0.0455, 0.3281, 0.1636], "编辑页选 #2f7d5a、强度 1 时那块板发出的光");
});

test("求解工具：默认几何过关，坏几何给出审计数字并退出非零", async () => {
  const good = await solvePlan({ plan: PLAN, settings: normalizeSettings({}).value });
  assert.equal(good.ok, true, JSON.stringify(good.audit));
  assert.equal(good.audit.forced, 0);
  assert.equal(good.audit.clearance_fails, 0);
  assert.equal(good.audit.plank_overlaps, 0);
  assert.equal(good.counts.boards, good.layout.boards.length);
  assert.ok(good.onsets.length > 0);

  const bad = await solvePlan({
    plan: PLAN,
    settings: normalizeSettings({ geometry: { board_w: 0.40, board_d: 0.28,
      ball_r: 0.07, spacing: 0.50, bounce: 1.0 } }).value,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.audit.forced + bad.audit.clearance_fails
    + bad.audit.plank_overlaps > 0, JSON.stringify(bad.audit));
  // 审计数字就是页面用来禁用导出的那几个
  assert.equal(typeof bad.audit.min_clearance, "number");
  assert.deepEqual(bad.onsets.length, good.onsets.length);
});

test("换几何真的换了布局，同几何的解被复用", async () => {
  clearLayoutCache();
  const one = await layoutFor({ source: LAYOUT_SOURCE,
    geometry: geometry({ board_w: 0.30 }), plan: PLAN });
  const two = await layoutFor({ source: LAYOUT_SOURCE,
    geometry: geometry({ board_w: 0.36 }), plan: PLAN });
  assert.equal(one.layout.constants.contact_off, 0.15);
  assert.equal(two.layout.constants.contact_off, 0.18);
  // 板宽变了，木板本身的姿态/高度就真的变了（不是只改了个显示比例）
  const shape = (l) => l.layout.boards.map((b) => [b.tilt, b.top_y,
    b.collision ? b.collision.apex : 0, b.pos[2]]);
  const a = shape(one);
  const b = shape(two);
  let changed = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i].some((v, k) => Math.abs(v - b[i][k]) > 1e-9)) changed += 1;
  }
  assert.ok(changed > 0, "板宽变化必须真的改变木板姿态/小球弹道");
  // 而 onset（每个音的时刻）与音高一个都不许动
  assert.deepEqual(one.layout.boards.map((x) => x.t), two.layout.boards.map((x) => x.t));
  assert.deepEqual(one.layout.boards.map((x) => x.midi), two.layout.boards.map((x) => x.midi));
});


