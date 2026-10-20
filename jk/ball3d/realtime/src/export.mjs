/**
 * Browser entry point of the realtime renderer.
 *
 * Served by ``export_session.mjs`` from a loopback HTTP server, which also
 * supplies the config (plan + output size/fps) and receives the result.  The
 * page itself uploads only the *encoded* MP4 and a small JSON report, so no raw
 * frame pixels ever cross the Playwright boundary.
 *
 * The frame loop is deliberately explicit instead of timed:
 *
 *   ``start({ initOnly: true })`` -- ``Recorder.start()`` encodes frame 0 by
 *   itself (its ``step()`` is not a no-op), while ``Recorder.step()`` uses
 *   ``frame < duration * frameRate`` as its stop condition, which is a float
 *   product (``(297/30)*30 === 296.99999999999994``).  So the page initialises
 *   the recorder, then drives exactly ``expected`` frames itself, then calls
 *   ``stop()`` -- never the autostop.  A wrong frame count is a failure, never a
 *   shorter video.
 */

import * as THREE from "three";
import { Recorder } from "canvas-record";

import { buildScene } from "./scene.mjs";
import { buildWoodScene } from "./wood_drop.mjs";
import { buildMusicMachine } from "./music_machine.mjs";
import { loadKit } from "./layout_kit.mjs";
import { normalizeSettings, normalizeVideo } from "./settings.mjs";
import { UPLOAD_CHUNK, expectedFrames, glInfo, uploadChunks } from "./verify.mjs";

const params = new URLSearchParams(window.location.search);
const run = params.get("run") ?? "";
const errors = [];
const qaDone = [];

const now = () => performance.now();

/** POST to the orchestrator, authenticated by the run token in the query. */
async function post(path, body, contentType) {
  const url = new URL(path, window.location.href);
  if (run) url.searchParams.set("run", run);
  const response = await fetch(url, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body,
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: HTTP ${response.status}`);
  }
  return response;
}

/**
 * Upload the encoded MP4 in bounded sequential chunks.
 *
 * One request per chunk keeps every DevTools protocol message small: the
 * browser mirrors the request body into ``Network.requestWillBeSent``, and a
 * single 106 MB body used to become a ~583 MB protocol message that Node could
 * not turn into a string (``ERR_STRING_TOO_LONG``), killing an export whose
 * frames had all been encoded.  The orchestrator validates the sequence, each
 * chunk's size and the declared total, so a truncated upload fails loudly.
 */
async function uploadVideo(buffer) {
  const bytes = new Uint8Array(
    buffer instanceof Uint8Array
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      : buffer,
  );
  const total = bytes.byteLength;
  const chunks = uploadChunks(total);
  for (let seq = 0; seq < chunks; seq += 1) {
    const from = seq * UPLOAD_CHUNK;
    const slice = bytes.subarray(from, Math.min(total, from + UPLOAD_CHUNK));
    await post(
      `/export?seq=${seq}&chunks=${chunks}&total=${total}`,
      slice,
      "application/octet-stream",
    );
  }
}

const state = {
  frames: 0,
  expected: 0,
  bytes: 0,
  errors,
  qa: qaDone,
  gl: null,
  stats: null,
  bloom: false,
  timings: {},
};

/** Send whatever is known, plus ``extra``; used on success and on failure. */
async function finish(extra = {}) {
  const report = { ...state, ...extra };
  window.__ball3d = { done: true, report };
  document.body.dataset.status = report.error ? "failed" : "done";
  const status = document.getElementById("status");
  if (status) {
    status.textContent = report.error
      ? `failed after ${report.frames}/${report.expected} frames`
      : `${report.frames} frames, ${report.bytes} bytes`;
  }
  try {
    await post("/report", JSON.stringify(report), "application/json");
  } catch (error) {
    // The orchestrator will time out with the console text instead.
    console.error("[realtime] report upload failed:", error);
  }
}

async function main() {
  const started = now();
  const response = await fetch(`/config?run=${encodeURIComponent(run)}`);
  if (!response.ok) throw new Error(`GET /config failed: HTTP ${response.status}`);
  const config = await response.json();
  state.timings.config = now() - started;

  if (typeof VideoEncoder !== "function") {
    throw new Error(
      "WebCodecs VideoEncoder is unavailable: the page needs a secure context " +
      "(http://127.0.0.1 qualifies) and a Chromium build with WebCodecs",
    );
  }

  const { width, height, fps, seconds, plan, bloom, bitrate, qaFrames } = config;
  // The task snapshot: settings are re-validated in the page (the export must
  // never silently fall back to the default CLI geometry) and the window start
  // is an absolute score time, shared with the preview.
  const settingsCheck = normalizeSettings(config.settings);
  if (!settingsCheck.ok) {
    throw new Error(`the export config carries invalid settings: ${settingsCheck.errors.join("; ")}`);
  }
  const settings = settingsCheck.value;
  const start = Number(config.start ?? 0);
  if (!Number.isFinite(start) || start < 0) {
    throw new Error(`the export config carries an invalid window start: ${config.start}`);
  }
  state.settings = settings;
  state.start = start;
  state.expected = expectedFrames(seconds, fps);
  state.bloom = Boolean(bloom);
  if (state.expected !== config.frames) {
    throw new Error(
      `config disagrees with itself: ${config.frames} frames requested, ` +
      `but ${seconds}s at ${fps}fps is ${state.expected}`,
    );
  }

  const canvas = document.getElementById("view");
  canvas.width = width;
  canvas.height = height;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    depth: true,
    stencil: false,
    // A VideoFrame is taken from the canvas between renders; without this the
    // drawing buffer may already be cleared when the encoder reads it.
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; // Blender's "Standard"
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.debug.onShaderError = (gl, program) => {
    throw new Error(`WebGL shader failed: ${gl.getProgramInfoLog(program)}`);
  };

  state.gl = glInfo(renderer.getContext());
  console.log(`[realtime] webgl ${JSON.stringify(state.gl)}`);

  // The plan names the style; anything but "music-machine" keeps the classic look.
  const musicMachine = plan.visual_style === "music-machine";
  const glb = musicMachine && config.assets?.glb
    ? `${config.assets.glb}?run=${encodeURIComponent(run)}`
    : null;
  let kit = null;
  if (musicMachine) {
    // The geometry lives in exactly one module instance per task: the source of
    // realtime/src/layout.mjs is rewritten for this config's geometry and
    // imported as its own blob module, so two exports cannot bleed parameters.
    const source = await (await fetch(`/layout.mjs?run=${encodeURIComponent(run)}`)).text();
    if (!source.includes("export const BOARD_W")) {
      throw new Error("GET /layout.mjs did not return the layout module source");
    }
    kit = await loadKit(source, settings.geometry, (text) => import(
      URL.createObjectURL(new Blob([text], { type: "text/javascript" })),
    ));
  }
  const scene = musicMachine
    ? await buildMusicMachine({
      renderer, plan, width, height, bloom: Boolean(bloom), glbUrl: glb,
      kit, visuals: settings.visuals, presentation: config.presentation,
      hdrUrl: `${config.assets.hdr}?run=${encodeURIComponent(run)}`,
    })
    : (plan.visual_style === "wood-drop" ? buildWoodScene : buildScene)({ renderer, plan, width, height, bloom: Boolean(bloom) });
  state.stats = scene.stats();
  // A config whose trajectory does not solve must never produce a video: the
  // same audit the editor preview shows gates the export, so a failed solve is
  // reported with its measured numbers instead of being rendered as success.
  const audit = scene.layout?.audit ?? null;
  if (audit) {
    state.audit = {
      boards: scene.layout.boards.length,
      forced: audit.forced,
      clearance_fails: audit.clearance_fails,
      plank_overlaps: audit.plank_overlaps,
      min_clearance: audit.min_clearance,
      plank_gap_min: audit.plank_gap_min,
      chutes: audit.chutes, gravity: scene.constants.G,
      min_contact_spacing:audit.min_contact_spacing, required_contact_spacing:audit.required_contact_spacing,
      fast_notes_without_boards:audit.fast_notes_without_boards, flights:audit.flights,
      tracks:audit.tracks, spatial:audit.spatial,
    };
  }
  if (musicMachine && audit
      && (audit.forced > 0 || audit.clearance_fails > 0 || audit.plank_overlaps > 0)) {
    throw new Error(
      "the geometry does not solve for this song (forced=" + audit.forced
      + ", clearance_fails=" + audit.clearance_fails
      + ", plank_overlaps=" + audit.plank_overlaps + "); the export is refused",
    );
  }
  const setup = now();
  state.timings.setup = setup - started - state.timings.config;

  // Initialise GPU transmission/shadow targets before any encoded frame.
  // The warm-up samples the same absolute time, it never advances animation.
  scene.update(start);
  scene.render();
  const recorder = new Recorder(renderer.getContext(), {
    name: config.name ?? "ball3d-realtime",
    duration: seconds,
    frameRate: fps,
    extension: "mp4",
    target: "in-browser",
    download: false, // the bytes are uploaded; no browser download plumbed in
    encoderOptions: {
      bitrate, // H.264, ~8 Mbps for 720x1280@30
      bitrateMode: "variable",
      groupOfPictures: 20,
    },
    onError: (error) => {
      errors.push(String(error && error.stack ? error.stack : error));
    },
  });

  const qa = new Set(qaFrames ?? []);
  const visualFrames = [];
  const repeatFrames = [];
  let updateMs = 0;
  let encodeMs = 0;
  let lastProgress = -Infinity;
  try {
    await recorder.start({ initOnly: true });

    for (let i = 0; i < state.expected; i += 1) {
      const before = now();
      // absolute score time: frame 0 of this clip is ``start`` in the song, the
      // same instant the preview shows, so preview and export share one sampling
      scene.update(start + i / fps); // exact: never an accumulated 1/fps
      scene.render();
      const rendered = now();
      recorder.time = i / fps;
      await recorder.step(); // awaits encoder/muxer backpressure
      const stepped = now();
      updateMs += rendered - before;
      encodeMs += stepped - rendered;

      if (scene.measureFrame) {
        const measurement=scene.measureFrame();
        visualFrames.push({frame:i,...measurement});
        if(!config.presentation?.spatial?.enabled && measurement.rest && measurement.visible_rails.length)
          throw new Error(`rest frame ${i} contains visible rails`);
      }
      if (qa.has(i)) {
        repeatFrames.push({ frame: i, png: canvas.toDataURL("image/png") });
        await snapshot(canvas, i);
      }
      if (now() - lastProgress >= 500 || i === state.expected - 1) {
        lastProgress = now();
        console.log(`[realtime] frame ${i + 1}/${state.expected}`);
        const status = document.getElementById("status");
        if (status) status.textContent = `frame ${i + 1}/${state.expected}`;
      }
      state.frames = i + 1;
    }

    if (visualFrames.length) state.visual_frames = visualFrames;
    // Repeat the selected frames out of sequence after all encoding is done.
    // Exact PNG equality catches hidden frame-history state in the GPU scene.
    state.repeat_frames = [];
    for (const saved of repeatFrames.reverse()) {
      scene.update(start + saved.frame / fps);
      scene.render();
      const identical = saved.png === canvas.toDataURL("image/png");
      state.repeat_frames.push({ frame: saved.frame, identical });
      if (!identical) {
        await snapshot(canvas, state.expected + saved.frame);
        throw new Error(`frame ${saved.frame} changed after seeking`);
      }
    }
    state.stats = scene.stats();
    const buffer = await recorder.stop();
    const bytes = buffer
      ? (buffer.byteLength ?? buffer.length ?? 0)
      : 0;
    state.bytes = bytes;
    if (bytes > 0) {
      await uploadVideo(buffer);
    }
  } finally {
    await recorder.dispose();
    state.timings.update = updateMs;
    state.timings.encode = encodeMs;
    state.timings.total = now() - started;
    scene.dispose();
    renderer.dispose();
  }

  await finish();
}

/** Optional QA still: a handful of PNGs, never a frame sequence. */
async function snapshot(canvas, frame) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`PNG snapshot of frame ${frame} produced nothing`);
  await post(`/qa?frame=${frame}`, blob, "image/png");
  qaDone.push(frame);
  console.log(`[realtime] qa snapshot frame ${frame}`);
}

main().catch(async (error) => {
  const text = String(error && error.stack ? error.stack : error);
  console.error("[realtime] export failed:", text);
  await finish({ error: text });
});
