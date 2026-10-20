/**
 * The browser side of the 3D editor page (``web/editor.html``).
 *
 * It builds the *same* scene the export page builds -- one three.js renderer,
 * the shared music-machine scene, the shared solver instantiated for the chosen
 * geometry -- so what the panel shows and what the exported MP4 contains are one
 * layout, one GLB, one camera, one absolute-time sampling.
 *
 * Rules that shaped the code:
 *  * physics is solved in a cancellable worker, never per frame or on the UI;
 *    geometry changes are debounced; look changes reuse the solved layout;
 *  * switching a busy song requires confirmation before terminating its worker;
 *    sequence numbers also prevent queued stale results from being committed;
 *  * a geometry that does not solve keeps the last valid preview, says so with
 *    the measured audit and disables export -- no fake success.
 */

import * as THREE from "three";

import { presentationGui } from "./presentation_gui.mjs";

import { buildMusicMachine } from "./music_machine.mjs";
import { LayoutWorkerClient } from "./layout_worker_client.mjs";
import { normalizeSettings, expectedFrames } from "./settings.mjs";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

async function api(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  if (!response.ok || !body || body.ok === false) {
    const message = (body && (body.error || (body.errors || []).join("；")))
      || `HTTP ${response.status}`;
    const err = new Error(message);
    err.body = body;
    throw err;
  }
  return body;
}

const state = {
  schema: null,
  song: null,               // {base} or {import}
  songLabel: "",
  plan: null,
  source: null,             // layout.mjs text
  kit: null,
  layout: null,
  solvedKey: "",
  settings: null,           // what the panel shows (may be a geometry that fails)
  solved: null,             // the settings of the last *valid* solve: what we draw and export
  scene: null,
  renderer: null,
  canvas: null,
  t: 0,
  playing: false,
  dirty: true,
  audioOn: true,
  seq: 0,                   // solve revision: a late answer never overwrites a newer one
  loadingSong: false,
  songToken: 0,             // which song is being loaded
  frameSeq: 0,              // scene rebuild revision
  preview: { width: 432, height: 768 },
  exportRid: null,
  exportTimer: null,
  framing: null,
  solve: { state: "idle", info: null, error: null, ms: 0 },
  pending: false,           // a solve is in flight: export stays off until it lands
  exporting: false,
  saved: [],
};

const layoutSolver = new LayoutWorkerClient("/editor/layout-worker.js");
window.addEventListener("pagehide", () => layoutSolver.cancel());

const raf = window.requestAnimationFrame;
const now = () => performance.now();

// ── status lines ──────────────────────────────────────────────────────────
function setSolveStatus(text, cls) {
  const node = $("solve-status");
  node.textContent = text;
  node.className = `status ${cls || ""}`;
}

function setMessage(text, cls) {
  const node = $("message");
  node.textContent = text || "";
  node.hidden = !text;
  node.className = `message ${cls || ""}`;
}

function setProgress(kind, { percent, stage, completed, total }, status = "running") {
  const value = Math.max(0, Math.min(100, percent));
  const box = $(`${kind}-progress-box`);
  box.hidden = false;
  box.dataset.state = status;
  $(`${kind}-progress`).value = value;
  const count = total > 0 ? `（${completed}/${total}${kind === "export" ? " 帧" : ""}）` : "";
  $(`${kind}-progress-label`).textContent = `${stage}${count} · ${value.toFixed(1)}%`;
}

// ── settings panel ────────────────────────────────────────────────────────
function buildPanel() {
  const { schema, defaults } = state.schema;
  const makeRow = (kind, key, spec, value) => {
    const row = el("div", "row");
    const label = el("label", null, spec.label);
    let input;
    if (spec.kind === "color") {
      input = el("input");
      input.type = "color";
    } else if (spec.kind === "boolean") {
      input = el("input");
      input.type = "checkbox";
    } else {
      input = el("input");
      input.type = "range";
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
    }
    input.dataset.kind = kind;
    input.dataset.key = key;
    input.dataset.type = spec.kind;
    input.value = value;
    if (spec.kind === "boolean") input.checked = Boolean(value);
    const out = el("output", "value");
    const show = () => {
      out.textContent = spec.kind === "boolean"
        ? (input.checked ? "开" : "关")
        : (spec.kind === "color" ? input.value
          : `${Number(input.value).toFixed(spec.step >= 0.01 ? 2 : 3)}${spec.unit || ""}`);
    };
    show();
    input.addEventListener("input", () => { show(); onPanelChange(kind, key); });
    row.append(label, input, out);
    return row;
  };
  const geometryBox = $("geometry-rows");
  const visualBox = $("visual-rows");
  geometryBox.textContent = "";
  visualBox.textContent = "";
  for (const [key, spec] of Object.entries(schema.geometry)) {
    geometryBox.append(makeRow("geometry", key, spec, defaults.geometry[key]));
  }
  for (const [key, spec] of Object.entries(schema.visuals)) {
    const row = makeRow("visuals", key, spec, defaults.visuals[key]);
    if (["zoom", "oblique"].includes(key)) row.style.display = "none";
    visualBox.append(row);
  }
}

function readPanel() {
  const out = { schema: state.schema.schema.version, geometry: {}, visuals: {} };
  for (const input of document.querySelectorAll("#panel input[data-key]")) {
    const kind = input.dataset.kind;
    const key = input.dataset.key;
    const type = input.dataset.type;
    out[kind][key] = type === "boolean" ? input.checked
      : (type === "color" ? input.value : Number(input.value));
  }
  return out;
}

function writePanel(settings) {
  for (const input of document.querySelectorAll("#panel input[data-key]")) {
    const value = settings[input.dataset.kind][input.dataset.key];
    if (input.dataset.type === "boolean") input.checked = Boolean(value);
    else input.value = value;
    const out = input.parentElement.querySelector("output");
    if (out) {
      out.textContent = input.dataset.type === "boolean"
        ? (input.checked ? "开" : "关")
        : (input.dataset.type === "color" ? input.value : String(value));
    }
  }
}

// ── solving / scene ───────────────────────────────────────────────────────
let geometryTimer = null;
let visualTimer = null;
/** 动了板色、但彩色强度还是 0 时自动抬到的档位（见 onPanelChange）。 */
const AUTO_TINT = 0.6;

function onPanelChange(kind, key = "") {
  state.lastVisualKey = key;
  const raw = readPanel();
  const checked = normalizeSettings(raw);
  if (!checked.ok) {
    setMessage(checked.errors.join("；"), "bad");
    return;
  }
  state.settings = checked.value;
  setMessage("");
  if (kind === "geometry") {
    // The export must be off from the moment the slider moves: the panel no
    // longer describes the picture on screen until the new size is solved.
    state.seq += 1;
    layoutSolver.cancel();
    state.pending = true;
    updateExportButtons();
    setSolveStatus("尺寸变了，正在重新排版…", "busy");
    setProgress("layout", { percent: 0, stage: "等待排版" });
    window.clearTimeout(geometryTimer);
    geometryTimer = window.setTimeout(() => { resolveLayout(); }, 250);
  } else {
    // A look change cannot fail, so it applies at once -- but it only ever
    // replaces the *look*: the geometry that is drawn and exported stays the
    // one that actually solved, never a slider value still being checked.
    if (state.solved) state.solved.visuals = checked.value.visuals;
    // 板色要乘上「彩色强度」才画得出来：强度是 0 的时候调板色屏幕上一点动静
    // 都没有 —— 那不是「设计如此」，是个看起来坏掉的控件。用户一动板色就把
    // 强度抬到能看见的档，并说明白。
    if (kind === "visuals" && state.lastVisualKey === "board_color"
        && checked.value.visuals.board_tint <= 0) {
      state.settings = normalizeSettings({
        geometry: checked.value.geometry,
        visuals: { ...checked.value.visuals, board_tint: AUTO_TINT },
      }).value;
      if (state.solved) state.solved.visuals = state.settings.visuals;
      writePanel(state.settings);
      setMessage(`板色要乘上「彩色强度」才上色，已经把强度从 0 抬到 `
        + `${AUTO_TINT}（不想要就自己调回 0）。`);
    }
    window.clearTimeout(visualTimer);
    visualTimer = window.setTimeout(() => { rebuildScene(); }, 120);
  }
}

/** Import the layout source as its own module; the blob URL is released at once. */
async function blobImport(text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function describeFailure(info) {
  const parts = [];
  if (info.forced) parts.push(`${info.forced} 处被迫改落点`);
  if (info.clearance_fails) parts.push(`${info.clearance_fails} 块板离小球太近`);
  if (info.plank_overlaps) parts.push(`${info.plank_overlaps} 处板子互相重叠`);
  return parts.join("、") || "排版失败";
}

/**
 * Solve the current geometry for the current song.
 *
 * Only a *passing* result is committed: a geometry that does not solve leaves
 * the last valid kit/layout/settings in place (so the preview keeps showing
 * something real and the export keeps using exactly that), reports why, and
 * disables the export buttons.
 */
async function resolveLayout() {
  if (!state.plan || !state.source || state.loadingSong) return false;
  const seq = ++state.seq;
  const songToken = state.songToken;
  state.pending = true;
  updateExportButtons();
  setSolveStatus("正在排版…", "busy");
  setProgress("layout", { percent: 0, stage: "准备排版" });
  const started = now();
  const settings = structuredClone(state.settings);
  let result = null;
  try {
    result = await layoutSolver.solve({
      source: state.source,
      geometry: settings.geometry,
      plan: state.plan,
      presentation: state.presentation,
    }, blobImport, (progress) => {
      if (seq === state.seq && songToken === state.songToken) setProgress("layout", progress);
    });
  } catch (error) {
    if (seq !== state.seq || songToken !== state.songToken) return false;
    state.pending = false;
    state.solve = { state: "failed", info: null,
      error: String(error.message || error), ms: Math.round(now() - started) };
    setSolveStatus("这套尺寸排不出来，导出已停用", "bad");
    setProgress("layout", { percent: $("layout-progress").value, stage: "排版失败" }, "failed");
    setMessage(`排不开：${state.solve.error}。画面还是上一次能用的设置。`, "bad");
    updateExportButtons();
    return false;
  }
  if (seq !== state.seq || songToken !== state.songToken) return false;  // a newer request owns the UI
  state.pending = false;
  const audit = result.layout.audit;
  const ok = audit.forced === 0 && audit.clearance_fails === 0
    && audit.plank_overlaps === 0 && (state.presentation.spatial?.enabled || (audit.tracks?.rest_overlaps ?? 0) === 0);
  const ms = Math.round(now() - started);
  if (!ok) {
    state.solve = {
      state: "failed", ms, error: "排版不通过",
      info: {
        forced: audit.forced,
        clearance_fails: audit.clearance_fails,
        plank_overlaps: audit.plank_overlaps,
      },
    };
    setSolveStatus("这套尺寸排不出来，导出已停用", "bad");
    setProgress("layout", { percent: $("layout-progress").value, stage: "排版失败" }, "failed");
    setMessage(`排不开（${describeFailure(state.solve.info)}）。`
      + "画面还是上一次能用的设置，把板宽/间距调回去就能导出。", "bad");
    updateExportButtons();
    return false;
  }
  state.kit = result.kit;
  state.layout = result.layout;
  state.solvedKey = result.key;
  state.solved = { ...settings, visuals: structuredClone(state.settings.visuals) };
  state.solve = {
    state: "ok", ms, error: null,
    info: {
      boards: result.layout.boards.length,
      chutes: audit.chutes,
      tracks: audit.tracks,
      min_clearance: audit.min_clearance,
      // all zero -- that is the gate above; kept so the report reads the same
      // whether the solve passed or failed
      forced: audit.forced,
      clearance_fails: audit.clearance_fails,
      plank_overlaps: audit.plank_overlaps,
    },
  };
  setProgress("layout", { percent: 100, stage: "排版完成" }, "done");
  setSolveStatus(`排版好了：${result.layout.boards.length} 块板，`
    + `用时 ${(ms / 1000).toFixed(1)} 秒`, "good");
  setMessage("");
  updateExportButtons();
  rebuildScene();
  return true;
}

function rebuildScene() {
  if (!state.plan || !state.kit || !state.layout || !state.solved) return null;
  const seq = ++state.frameSeq;
  const previous = state.scene;
  state.scene = null;
  if (previous) {
    try { previous.dispose(); } catch (error) { console.warn("dispose failed", error); }
  }
  const width = state.preview.width;
  const height = state.preview.height;
  state.canvas.width = width;
  state.canvas.height = height;
  state.renderer.setSize(width, height, false);
  // The look comes from the panel; the geometry comes from the solved settings,
  // so a slider that has not (yet) solved can never be drawn next to the old kit.
  return Promise.resolve(buildMusicMachine({
    renderer: state.renderer,
    plan: state.plan,
    kit: state.kit,
    layout: state.layout,          // cached: a look change never re-solves
    visuals: state.solved.visuals,
    width,
    height,
    bloom: true,
    glbUrl: "/editor/glb",
    presentation: state.presentation,
  })).then((built) => {
    if (seq !== state.frameSeq) { built.dispose(); return null; }
    built.update(state.t);
    built.render();
    state.scene = built;
    state.framing = built.framing;
    state.dirty = true;
    updateExportButtons();
    updateFramingNote();
    return built;
  }).catch((error) => {
    setMessage(`画面没搭起来：${error.message || error}`, "bad");
    updateExportButtons();
    return null;
  });
}

function updateFramingNote() {
  const note = $("framing-note");
  const info = state.framing;
  if (!info) { note.hidden = true; return; }
  note.hidden = false;
  if (info.mode === "perspective") {
    note.textContent = `向下俯拍 ${info.downwardTilt}°；球附近横向最多 ${info.max_boards_across} 个板宽；球径占画宽 ${(info.ball_width * 100).toFixed(1)}%。`;
    note.className = "note";
    return;
  }
  note.textContent = info.clamped
    ? `再拉近的话小球弹到最高、偏到最外时会出画，已经限制在 ${info.used_zoom.toFixed(2)} 倍`
      + `（你拉的是 ${info.requested_zoom.toFixed(2)} 倍）。`
    : `画面收得下整首曲子：小球最远离中线 ${info.max_abs_x.toFixed(2)} 米，`
      + `还能再拉近到 ${info.max_safe_zoom.toFixed(2)} 倍。`;
  note.className = `note ${info.clamped ? "warn" : ""}`;
}

// ── playback ──────────────────────────────────────────────────────────────
const audio = () => $("audio");

function duration() {
  return state.plan ? state.plan.duration : 0;
}

/**
 * Show a time.
 *
 * ``state.t`` is the one clock the scene samples.  While audio is on it is
 * *read from* the audio element (the element is the clock, so picture and sound
 * cannot drift); while audio is off the wall clock advances it.  Writing
 * ``currentTime`` every frame would restart the decode position 60 times a
 * second and stutter, so it only happens on an explicit seek.
 */
function setTime(t, { seekAudio = false, fromSlider = false } = {}) {
  const max = duration();
  state.t = Math.max(0, Math.min(max, t));
  state.dirty = true;
  if (!fromSlider) $("timeline").value = String(state.t);
  $("time-label").textContent = `${state.t.toFixed(2)} / ${max.toFixed(2)} s`;
  if (seekAudio && audio().src) audio().currentTime = state.t;
}

function play() {
  if (!state.plan) return;
  if (state.t >= duration() - 1e-3) setTime(0, { seekAudio: true });
  state.playing = true;
  $("play").textContent = "暂停";
  if (state.audioOn) {
    audio().currentTime = state.t;             // one explicit seek, then listen
    audio().play().catch((error) => console.warn("audio", error));
  }
}

function pause() {
  state.playing = false;
  $("play").textContent = "播放";
  audio().pause();
}

function restart() {
  pause();
  setTime(0, { seekAudio: true });
  state.dirty = true;
  play();
}

function loop(now_) {
  raf(loop);
  const dt = Math.min(0.1, (now_ - state.last) / 1000);
  state.last = now_;
  const scene = state.scene;
  if (!scene) return;
  if (state.playing) {
    const el = audio();
    if (state.audioOn && !el.paused && el.readyState >= 2) {
      state.t = Math.min(el.currentTime, duration());   // the element is the clock
    } else {
      state.t += dt;                                    // silent playback: wall clock
    }
    setTime(state.t);
    if (state.t >= duration() - 1e-3) {
      setTime(duration());
      pause();
    }
  }
  if (state.dirty || state.playing) {
    scene.update(state.t);
    scene.render();
    state.dirty = false;
  }
}

// ── songs ─────────────────────────────────────────────────────────────────
async function loadSongs() {
  const data = await api("/api/editor/songs");
  const select = $("song");
  select.textContent = "";
  const hint = el("option", null, "— 请选择曲库里的歌 —");
  hint.value = "";
  select.append(hint);
  for (const song of data.songs) {
    const option = el("option", null, song.notes
      ? `${song.title}（${song.notes} 音）` : song.title);
    option.value = song.base;
    option.dataset.title = song.title;
    select.append(option);
  }
  select.addEventListener("change", () => {
    if (select.value) loadSong({ base: select.value });
  });
}

async function confirmSongSwitch() {
  const dialog = $("song-switch-dialog");
  if (dialog.open) return false;
  dialog.returnValue = "no";
  const answer = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
  });
  dialog.showModal();
  return answer;
}

async function loadSong(target) {
  const switching = state.song && (target.base !== state.song.base || target.import !== state.song.import);
  if (switching && state.pending && !await confirmSongSwitch()) {
    $("song").value = state.song.base || "";
    setMessage("未切歌，继续当前歌曲排版。");
    return false;
  }
  window.clearTimeout(geometryTimer);
  window.clearTimeout(visualTimer);
  layoutSolver.cancel();
  // Two quick song clicks must not let the slower answer overwrite the newer one.
  const token = ++state.songToken;
  state.loadingSong = true;
  state.seq += 1;                       // any solve still in flight is now stale
  pause();
  state.pending = true;
  state.solve = { state: "idle", info: null, error: null, ms: 0 };
  updateExportButtons();
  setSolveStatus("正在读谱…", "busy");
  setProgress("layout", { percent: 0, stage: "读取曲谱" });
  setMessage("正在读谱…");
  const rest = Number(state.presentation?.spatial?.maxRestSeconds) || 0;
  const query = (target.base
    ? `base=${encodeURIComponent(target.base)}`
    : `import=${encodeURIComponent(target.import)}`) + `&max_rest=${encodeURIComponent(rest)}`;
  let data = null;
  try {
    data = await api(`/api/editor/plan?${query}`);
  } catch (error) {
    if (token !== state.songToken) return false;
    state.loadingSong = false;
    state.pending = false;
    updateExportButtons();
    setProgress("layout", { percent: 0, stage: "读谱失败" }, "failed");
    setMessage(`读谱失败：${error.message}`, "bad");
    return false;
  }
  if (token !== state.songToken) return false;
  state.loadingSong = false;
  state.song = target;
  $("song").value = target.base || "";
  state.plan = data.plan;
  state.songLabel = data.title;
  const unknowns = data.plan.events.filter(event => event.unknown === true).length;
  $("song-title").textContent = `${data.title} · ${data.plan.counts.sounding} 个音 · `
    + `全长 ${data.duration.toFixed(1)} 秒`
    + (unknowns ? ` · ${unknowns} 个未识别项已按原时长静音占位` : "");
  $("timeline").max = String(data.duration);
  setTime(0);
  const audioEl = audio();
  audioEl.src = `/api/editor/audio?${query}`;
  audioEl.pause();
  setMessage("");
  const ok = await resolveLayout();
  if (token !== state.songToken) return false;
  if (ok) play();
  return ok;
}

// ── export ────────────────────────────────────────────────────────────────
function updateExportButtons() {
  // Export needs: a song, a *passing* solve that matches the panel, no solve in
  // flight, and no other render running.
  const ready = Boolean(state.plan) && state.solve.state === "ok"
    && !state.pending && !state.exporting && Boolean(state.scene);
  $( "export-sample").disabled = !ready || remaining() < MIN_SECONDS;
  $("export-song").disabled = !ready;
  const note = $("pending-note");
  if (note) note.hidden = !state.pending;
}

/** Seconds of music left from the playhead (the sample may not run past the song). */
function remaining() {
  return Math.max(0, duration() - state.t);
}
const MIN_SECONDS = 0.5;                     // mirrors settings.mjs TIME_MIN_SECONDS

/**
 * What the two buttons will render, right now: the *whole* song from 0, or the
 * current time onward for at most 10 s -- capped at what is actually left, and
 * never silently moved backwards to fit (the button says which range it means).
 */
function exportVideo(kind) {
  const size = $("export-size").value;
  const fps = Number($("export-fps").value);
  const [width, height] = size.split("x").map(Number);
  const wanted = kind === "song" ? duration() : 10;
  const start = kind === "song" ? 0 : state.t;
  const seconds = kind === "song" ? duration() : Math.min(wanted, remaining());
  // the encoder's own contract (settings.mjs): a fractional second rounds up
  const frames = Math.max(1, expectedFrames(seconds, fps));
  const qaFrame = Math.min(frames - 1, Math.round(Math.min(5, seconds / 2) * fps));
  return { size, width, height, fps, start, seconds, frames, wanted, qaFrame,
    capped: seconds < wanted - 1e-9 };
}

function rangeText(video) {
  const from = video.start.toFixed(2);
  const to = (video.start + video.seconds).toFixed(2);
  return `${from}s → ${to}s（${video.seconds.toFixed(2)}s，` +
    `${video.width}x${video.height} ${video.fps}fps）`;
}

async function startExport(kind) {
  if (state.exporting) return;
  if (state.pending) {
    setMessage("还在排版，等它出来再导出。", "bad");
    return;
  }
  if (state.solve.state !== "ok" || !state.scene) {
    setMessage("现在这套设置排不出来，导出已停用。", "bad");
    return;
  }
  const video = exportVideo(kind);
  if (video.seconds < MIN_SECONDS) {
    setMessage(`这里往后只剩 ${remaining().toFixed(2)} 秒，没得导；把播放头往前拖一点。`, "bad");
    return;
  }
  pause();
  const body = {
    // the *solved* settings: the frozen snapshot that produced the picture on
    // screen, not a slider value that failed to solve
    settings: state.solved,
    presentation: structuredClone(state.presentation),
    video: {
      size: video.size, fps: video.fps, seconds: video.seconds, start: video.start,
    },
    label: kind === "song" ? "song" : "sample",
    qa_frames: [video.qaFrame],
  };
  if (state.song.base) body.base = state.song.base;
  else body.import = state.song.import;
  state.exporting = true;
  setProgress("export", { percent: 0, stage: "准备渲染" });
  updateExportButtons();
  setMessage(`已冻结这首歌和当前全部参数，后台渲染 ${rangeText(video)}…`
    + (video.capped ? "（曲子只剩这么多，按剩下的长度导）" : ""));
  $("export-log").textContent = "";
  $("result").hidden = true;
  $("download").hidden = true;
  try {
    const started = await api("/api/editor/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    state.exportRid = started.rid;
    state.exportRange = started;
    if (kind === "sample") {
      // the matching still: same solved settings, same absolute time (start +
      // qaFrame/fps), the export resolution -- the frame the reviewer compares
      await snapshot(video.start + video.qaFrame / video.fps, "preview_frame", video);
    }
    pollExport();
  } catch (error) {
    state.exporting = false;
    updateExportButtons();
    setProgress("export", { percent: 0, stage: "导出未开始" }, "failed");
    setMessage(`导出没能开始：${error.message}`, "bad");
  }
}

async function snapshot(absTime, name, video) {
  const scene = state.scene;
  if (!scene) return null;
  const previous = { width: state.preview.width, height: state.preview.height };
  scene.setSize(video.width, video.height);
  scene.update(absTime);                 // exactly start + index/fps, as the export does
  scene.render();
  const blob = await new Promise((resolve) => state.canvas.toBlob(resolve, "image/png"));
  let result = null;
  if (blob) {
    result = await fetch(`/api/editor/frame?name=${encodeURIComponent(name)}`,
      { method: "POST", body: blob }).then((r) => r.json()).catch(() => null);
  }
  scene.setSize(previous.width, previous.height);
  state.dirty = true;
  return { name, absTime, bytes: blob ? blob.size : 0, path: result && result.path };
}

async function pollExport() {
  window.clearTimeout(state.exportTimer);
  if (!state.exportRid) return;
  let info = null;
  try {
    info = await api(`/api/editor/export/${state.exportRid}`);
  } catch (error) {
    setMessage(`查询导出状态失败：${error.message}`, "bad");
    return;
  }
  setProgress("export", info.progress, info.state);
  const log = $("export-log");
  log.textContent = (info.log_tail || []).join("\n");
  if (info.state === "running") {
    setMessage(`正在生成… 已经 ${Math.round(info.elapsed)} 秒（` +
      `${info.label === "song" ? "整曲" : "样片"}，` +
      `${info.video.width}x${info.video.height} ${info.video.fps} 帧/秒，` +
      `${info.video.start.toFixed(2)}s 起共 ${info.video.seconds.toFixed(2)}s）`);
    state.exportTimer = window.setTimeout(pollExport, 1500);
    return;
  }
  state.exporting = false;
  updateExportButtons();
  if (info.state === "done") {
    const mb = (info.bytes / 1048576).toFixed(1);
    setMessage(`生成好了：${info.frames} 帧，${mb} MB，用时 `
      + `${(info.timing_ms / 1000).toFixed(1)} 秒（${info.start.toFixed(2)}s 起 `
      + `${info.seconds.toFixed(2)}s，${info.video.width}x${info.video.height}）`, "good");
    const video = $("result");
    video.src = `${info.file}?t=${Date.now()}`;
    video.hidden = false;
    const link = $("download");
    link.href = info.file;
    link.hidden = false;
    link.textContent = `下载 ${info.song.replace("_notes.json", "")}_${info.label}.mp4`;
  } else {
    setMessage(`这次导出失败了：${info.error || "看下面的日志"}。可以再点一次重试。`, "bad");
  }
}

// ── start-up ──────────────────────────────────────────────────────────────
async function init() {
  state.canvas = $("view");
  state.last = now();
  state.renderer = new THREE.WebGLRenderer({
    canvas: state.canvas, antialias: true, alpha: false,
    preserveDrawingBuffer: true, powerPreference: "high-performance",
  });
  state.renderer.setPixelRatio(1);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.NoToneMapping;
  state.renderer.shadowMap.enabled = true;
  state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  state.renderer.debug.onShaderError = (gl, program) => {
    throw new Error(`WebGL shader failed: ${gl.getProgramInfoLog(program)}`);
  };

  state.presentation = (await api("/api/editor/presentation")).config;
  state.presentationGui = presentationGui(state.presentation, (group, field) => {
    // Rest compression changes the plan, not the course geometry.
    if (group === "spatial" && field === "maxRestSeconds") { if (state.song) loadSong(state.song); return; }
    if (group === "physics" || group === "tracks" || group === "spatial" || field === "sideDiameters" || field === "rodLengthWidths" ||
        state.presentation.spatial?.wallMounted && group === "boards" && field !== "glowStrength" ||
        state.presentation.spatial?.enabled && (group === "camera" || field === "screenWidth")) resolveLayout();
    else rebuildScene();
  }, async () => {
    try {
      await api("/api/editor/presentation", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(state.presentation) });
      setMessage("已保存 config.json，之后的命令行导出也使用这些参数。");
    } catch (error) { setMessage(error.message, "bad"); }
  });
  state.schema = await api("/api/editor/schema");
  buildPanel();
  const checked = normalizeSettings({});
  state.settings = checked.value;
  writePanel(state.settings);

  state.source = await (await fetch("/editor/layout.mjs")).text();
  if (!state.source.includes("export const BOARD_W")) {
    throw new Error("layout 源文件没取到");
  }

  $("play").addEventListener("click", () => (state.playing ? pause() : play()));
  $("restart").addEventListener("click", restart);
  $("timeline").addEventListener("input", (event) => {
    // An explicit drag: the picture and the sound both jump there, once.  The
    // seek happens whether or not it is playing, so "pause, drag, press play"
    // resumes from exactly the time on the label.
    setTime(Number(event.target.value), { fromSlider: true, seekAudio: true });
  });
  $("audio-toggle").addEventListener("change", (event) => {
    state.audioOn = event.target.checked;
    if (state.audioOn && state.playing) {
      audio().currentTime = state.t;
      audio().play().catch(() => {});
    } else {
      audio().pause();
    }
  });
  $("reset").addEventListener("click", () => {
    const fresh = normalizeSettings({});
    state.settings = fresh.value;
    writePanel(state.settings);
    setMessage("已恢复默认：尺寸和外观都回到出厂值。");
    resolveLayout();
  });
  $("save").addEventListener("click", async () => {
    const name = $("settings-name").value.trim();
    if (!name) { setMessage("先给这份设置起个名字。", "bad"); return; }
    try {
      const saved = await api(`/api/editor/settings/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: state.settings }),
      });
      state.savedFile = saved.file;
      const link = $("download-settings");
      link.href = saved.file;
      link.download = name + ".json";
      link.hidden = false;
      setMessage(`已保存「${name}」，可以下载这份 JSON 带走。`, "good");
      await refreshSaved();
      $("saved").value = name;
    } catch (error) {
      setMessage(`保存失败：${error.message}`, "bad");
    }
  });
  $("load").addEventListener("click", async () => {
    const name = $("saved").value;
    if (!name) { setMessage("还没有保存过设置。", "bad"); return; }
    try {
      const data = await api(`/api/editor/settings/${encodeURIComponent(name)}`);
      applySettings(data.settings, `已载入「${name}」`);
    } catch (error) {
      setMessage(`载入失败：${error.message}`, "bad");
    }
  });
  $("import-settings").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    let payload = null;
    try {
      payload = JSON.parse(await file.text());
    } catch (error) {
      setMessage(`这个文件不是 JSON：${error.message}`, "bad");
      return;
    }
    const body = payload && payload.settings ? payload.settings : payload;
    const name = $("settings-name").value.trim()
      || (payload && typeof payload.name === "string" ? payload.name : "")
      || file.name.replace(/\.json$/i, "");
    try {
      await api(`/api/editor/settings/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });
      await refreshSaved();
      $("saved").value = name;
      applySettings(body, `已导入「${name}」`);
    } catch (error) {
      setMessage(`导入设置失败：${error.message}`, "bad");
    }
  });
  $("export-sample").addEventListener("click", () => startExport("sample"));
  $("export-song").addEventListener("click", () => startExport("song"));
  $("import-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    event.target.value = "";
    setMessage(`正在导入 ${file.name}…`);
    try {
      const data = await api(`/api/editor/import?name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file });
      await loadSong({ import: data.import });
    } catch (error) {
      setMessage(`导入失败：${error.message}`, "bad");
    }
  });
  // the sample button's meaning depends on where the playhead is
  setInterval(() => { if (!state.exporting) updateExportButtons(); }, 500);

  $("panel").hidden = false;
  $("boot").hidden = true;
  await loadSongs();
  await refreshSaved();
  updateExportButtons();
  raf(loop);
  window.__editor = {
    state,
    loadSong,
    resolveLayout,
    snapshot,
    readPanel,
    api,
    setTime,
    play,
    pause,
  };
  const wanted = new URLSearchParams(window.location.search).get("base");
  if (wanted) {
    const option = [...$("song").options].find((o) => o.value === wanted);
    if (option) {
      $("song").value = wanted;
      await loadSong({ base: wanted });
    }
  }
}

/** Put a settings payload into the panel and re-solve (used by load/import). */
function applySettings(payload, note) {
  const checked = normalizeSettings(payload);
  if (!checked.ok) {
    setMessage(`这份设置不能用：${checked.errors.join("；")}`, "bad");
    return false;
  }
  state.settings = checked.value;
  writePanel(state.settings);
  setMessage(note || "");
  resolveLayout();
  return true;
}

async function refreshSaved() {
  try {
    const data = await api("/api/editor/settings");
    const select = $("saved");
    select.textContent = "";
    for (const name of data.names) {
      const option = el("option", null, name);
      option.value = name;
      select.append(option);
    }
  } catch (error) {
    console.warn("saved settings", error);
  }
}

init().catch((error) => {
  console.error(error);
  setMessage(`编辑页没能启动：${error.message || error}`, "bad");
  $("boot").hidden = true;
});

