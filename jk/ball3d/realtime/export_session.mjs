#!/usr/bin/env node
/**
 * Orchestrator for one realtime render: bundle the page, serve it from
 * ``127.0.0.1`` on an ephemeral port, run it in the **installed** Edge through
 * ``playwright-core`` (channel ``msedge``, so nothing is downloaded), and hand
 * back the MP4 the page encoded with WebCodecs.
 *
 * The browser is never timed or screen-recorded: the page drives the encoder
 * for an exact frame count and uploads the encoded bytes plus a JSON report to
 * this process, so no raw frame pixels travel over the Playwright connection.
 * Every failure path -- missing report, short frame count, empty buffer,
 * encoder error, truncated upload -- throws :class:`ExportIncomplete`, which the
 * CLI turns into a non-zero exit.
 *
 * Usage:
 *   node realtime/export_session.mjs --plan plan.json --out out.mp4 \
 *     --seconds 10 --width 720 --height 1280 --fps 30 \
 *     [--bloom] [--bitrate 8000000] [--qa-frames 0,150] [--timeout 300] \
 *     [--channel msedge] [--no-build] [--no-sandbox] [--json timing.json] \
 *     [--report report.json] [--headful]
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { bundle, BUNDLE_NAME, BUILD_DIR } from "./build.mjs";
import { normalizeSettings, normalizeVideo } from "./src/settings.mjs";
import {
  ExportIncomplete,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK,
  acceptUploadChunk,
  checkExport,
  expectedFrames,
} from "./src/verify.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_LINES = 200;
/**
 * The music-machine style draws the GLB produced by Blender, and the layout's
 * collision constants describe *that* asset.  The compact build (0.30 m wide
 * plank, 0.40 deep, 0.06 thick, matching ``layout.mjs``) is the default; the
 * classic 0.60 m build still exists and can be compared with
 * ``--glb assets/music_machine.glb``, but ``measureAssembly`` will refuse it
 * because its plank does not match the audited collision box.
 */
const GLB_PATH = path.resolve(ROOT, "..", "assets", "reference_music_machine.glb");
const BUILD_GLB_CMD =
  "blender -b -P ball3d/assets/build_reference_music_machine.py";

const LAYOUT_SOURCE = path.resolve(ROOT, "src", "layout.mjs");

const USAGE = `usage: node realtime/export_session.mjs --plan PLAN.json --out OUT.mp4
       --seconds SECONDS --width W --height H --fps FPS
       [--start SECONDS] [--settings SETTINGS.json]
       [--bloom] [--bitrate BPS] [--qa-frames LIST] [--timeout SECONDS]
       [--channel msedge] [--dir BUILD_DIR] [--no-build] [--no-sandbox]
       [--headful] [--json RESULT.json] [--report REPORT.json]
       [--glb GLB]   (default: assets/reference_music_machine.glb)`;

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}\n${USAGE}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      values[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[name] = next;
      i += 1;
    } else {
      flags.add(name);
    }
  }
  return { values, flags };
}

function requireNumber(values, name) {
  const raw = values[name];
  if (raw === undefined) throw new Error(`--${name} is required\n${USAGE}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number (got ${raw})`);
  }
  return value;
}

function parseQaFrames(raw, frames) {
  if (!raw) return [];
  const list = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const out = [];
  for (const part of list) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= frames) {
      throw new Error(`--qa-frames has ${part}; frames are 0..${frames - 1}`);
    }
    if (!out.includes(index)) out.push(index);
  }
  return out;
}

/** Read a whole request body with a hard cap; resolves to the bytes. */
function readBody(request, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error(`request body exceeded ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** Stream a request body straight to ``dest`` and return the byte count. */
function writeBody(request, dest, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const part = `${dest}.part`;
    const stream = fs.createWriteStream(part);
    let bytes = 0;
    const fail = (error) => {
      request.destroy();
      stream.destroy();
      fs.rmSync(part, { force: true });
      reject(error);
    };
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) fail(new Error(`upload exceeded ${limit} bytes`));
    });
    request.on("error", fail);
    stream.on("error", fail);
    request.pipe(stream);
    stream.on("finish", () => {
      fs.renameSync(part, dest);
      resolve(bytes);
    });
  });
}

/**
 * Append one bounded upload chunk to ``part`` and resolve with its byte count.
 *
 * The encoded video arrives as a series of ``UPLOAD_CHUNK``-sized requests
 * instead of one giant POST: while the DevTools Network domain is on the
 * browser mirrors a request body into a protocol event, and a single 106 MB
 * body became a ~583 MB message that Node could not hold as a string
 * (``ERR_STRING_TOO_LONG``) -- after all 5276 frames had been encoded.  Chunks
 * keep every message a few MB, and appending means an interrupted upload leaves
 * a short ``.part`` file behind instead of a finished-looking video.
 */
function appendBody(request, part, limit = UPLOAD_CHUNK) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(part, { flags: "a" });
    let bytes = 0;
    const fail = (error) => {
      request.destroy();
      stream.destroy();
      reject(error);
    };
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) fail(new Error(`upload chunk exceeded ${limit} bytes`));
    });
    request.on("error", fail);
    stream.on("error", fail);
    request.pipe(stream);
    stream.on("finish", () => resolve(bytes));
  });
}

/**
 * Run one export session.
 *
 * @param {object} options parsed CLI options
 * @returns {Promise<object>} the result record (also written to ``--json``)
 */
export async function runSession(options) {
  const wallStart = Date.now();
  const planPath = path.resolve(options.plan);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const presentation = JSON.parse(fs.readFileSync(options.config || path.join(ROOT, "config.json"), "utf8"));
  if (plan.format !== "ball3d-plan-v1") {
    throw new Error(`${planPath}: not a ball3d-plan-v1 file`);
  }

  // The music-machine device is the GLB the Blender script builds; refuse to
  // run silently without it rather than drawing a different plank.
  const musicMachine = plan.visual_style === "music-machine";
  const glbPath = options.glb ? path.resolve(options.glb) : GLB_PATH;
  if (musicMachine && !fs.existsSync(glbPath)) {
    throw new Error(`${glbPath} is missing: build it with \`${BUILD_GLB_CMD}\``);
  }

  // The editor snapshot: geometry, look and the absolute window start travel
  // with the task, so an export can never quietly fall back to default CLI
  // geometry or to the wrong part of the song.
  const settingsCheck = normalizeSettings(options.settings);
  if (!settingsCheck.ok) {
    throw new Error(`invalid settings: ${settingsCheck.errors.join("; ")}`);
  }
  const settings = settingsCheck.value;

  const { width, height, fps, seconds } = options;
  const start = Number(options.start ?? 0);
  if (!Number.isFinite(start) || start < 0) {
    throw new Error(`--start must be a finite number >= 0 (got ${options.start})`);
  }
  const frames = expectedFrames(seconds, fps);
  const expected = frames;
  const outPath = path.resolve(options.out);
  const outDir = path.dirname(outPath);
  const qaDir = path.join(outDir, "qa");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "config.json"), JSON.stringify(presentation, null, 2));

  let build = null;
  if (!options.noBuild) {
    build = await bundle({ outdir: options.dir });
  } else if (!fs.existsSync(path.join(options.dir, BUNDLE_NAME))) {
    throw new Error(`${options.dir} has no ${BUNDLE_NAME}: run \`node realtime/build.mjs\``);
  }
  const buildDir = options.dir;

  const token = randomUUID();
  const session = {
    report: null,
    bytes: 0,
    qa: [],
    upload: { received: 0, chunks: null, total: null, bytes: 0, done: false },
    error: null,
  };
  let resolveReport;
  let rejectReport;
  const reported = new Promise((resolve, reject) => {
    resolveReport = resolve;
    rejectReport = reject;
  });
  const consoleLines = [];
  const browserErrors = [];
  let launchMs = 0;
  let gotoMs = 0;

  const config = {
    name: path.basename(outPath, path.extname(outPath)),
    width,
    height,
    fps,
    seconds,
    frames,
    start,
    presentation,
    bitrate: options.bitrate,
    bloom: options.bloom,
    qaFrames: options.qaFrames,
    settings,
    plan,
    // The URL names the file that is actually served, so a page (or a log)
    // can never claim the compact boards while receiving the classic ones.
    assets: musicMachine ? { glb: `/${path.basename(glbPath)}`, hdr: "/environment.hdr" } : null,
  };

  const pageFiles = {
    "/": { file: path.join(buildDir, "export.html"), type: "text/html; charset=utf-8" },
    [`/${BUNDLE_NAME}`]: {
      file: path.join(buildDir, BUNDLE_NAME),
      type: "text/javascript; charset=utf-8",
    },
  };
  if (musicMachine) {
    if (path.basename(presentation.environment.file) !== presentation.environment.file) throw new Error("HDR must be an asset filename");
    pageFiles["/environment.hdr"] = { file: path.join(ROOT, "../assets", presentation.environment.file), type: "application/octet-stream" };
    pageFiles[`/${path.basename(glbPath)}`] = { file: glbPath, type: "model/gltf-binary" };
    // the unchanged layout source: the page instantiates it for this task's
    // geometry (layout_kit.mjs) -- one file, one solver, per-config modules
    pageFiles["/layout.mjs"] = {
      file: LAYOUT_SOURCE, type: "text/javascript; charset=utf-8",
    };
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.searchParams.get("run") !== token) {
      response.writeHead(403).end("forbidden\n");
      return;
    }
    try {
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/config") {
        const body = Buffer.from(JSON.stringify(config));
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": body.length,
          "cache-control": "no-store",
        });
        response.end(body);
        return;
      }
      if (request.method === "GET" && pageFiles[url.pathname]) {
        const entry = pageFiles[url.pathname];
        const body = url.pathname === "/"
          ? Buffer.from(fs.readFileSync(entry.file, "utf8").replace(
            `src="./${BUNDLE_NAME}"`, `src="./${BUNDLE_NAME}?run=${token}"`))
          : fs.readFileSync(entry.file);
        response.writeHead(200, {
          "content-type": entry.type,
          "content-length": body.length,
          "cache-control": "no-store",
        });
        response.end(body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/export") {
        const asked = {
          seq: Number(url.searchParams.get("seq")),
          chunks: Number(url.searchParams.get("chunks")),
          total: Number(url.searchParams.get("total")),
          bytes: 0,
        };
        const part = `${outPath}.part`;
        // The body length is validated after the chunk is written, so cap the
        // read at the chunk size itself: anything longer is a protocol breach.
        const written = await appendBody(request, part, UPLOAD_CHUNK);
        asked.bytes = written;
        try {
          acceptUploadChunk(session.upload, asked);
        } catch (error) {
          fs.rmSync(part, { force: true });
          throw error;
        }
        session.bytes = session.upload.bytes;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${session.upload.bytes}
`);
        if (session.upload.done) fs.renameSync(part, outPath);
        return;
      }
      if (request.method === "POST" && url.pathname === "/qa") {
        const frame = Number(url.searchParams.get("frame"));
        fs.mkdirSync(qaDir, { recursive: true });
        const dest = path.join(qaDir, `frame${String(frame).padStart(5, "0")}.png`);
        const bytes = await writeBody(request, dest, 64 * 1024 * 1024);
        session.qa.push({ frame, file: dest, bytes });
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`${bytes}\n`);
        return;
      }
      if (request.method === "POST" && url.pathname === "/report") {
        const body = await readBody(request);
        session.report = JSON.parse(body.toString("utf8"));
        const claimed = Number(session.report.bytes ?? 0);
        if (claimed > 0 && !session.upload.done) {
          throw new ExportIncomplete(
            `the page reports ${claimed} bytes but ${session.upload.bytes} arrived `
            + `in ${session.upload.received}/${session.upload.chunks ?? "?"} chunks`,
          );
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok\n");
        resolveReport(session.report);
        return;
      }
      response.writeHead(404).end("not found\n");
    } catch (error) {
      session.error = session.error ?? String(error);
      response.writeHead(500).end(`${error}\n`);
      // A failing /export or /report means the run cannot complete.
      if (url.pathname === "/export" || url.pathname === "/report") {
        rejectReport(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/?run=${token}`;

  let browser = null;
  let timeout = null;
  const result = {
    ok: false,
    plan: planPath,
    out: outPath,
    width,
    height,
    fps,
    seconds,
    start,
    frames,
    expected,
    bytes: 0,
    bloom: Boolean(options.bloom),
    bitrate: options.bitrate,
    settings,
    presentation,
    qa: options.qaFrames,
    build: build ? { bytes: build.bytes, inputs: build.inputs, ms: build.ms } : null,
    webgl: null,
    scene: null,
    timings: {},
    browser_errors: browserErrors,
    console: consoleLines,
  };

  try {
    const launchStart = Date.now();
    browser = await chromium.launch({
      channel: options.channel,
      headless: !options.headful,
      args: [
        // GPU first, but a machine without one still renders (and says so via
        // report.webgl.software) instead of refusing WebGL.
        "--ignore-gpu-blocklist",
        "--enable-unsafe-swiftshader",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--mute-audio",
        ...(options.noSandbox ? ["--no-sandbox"] : []),
      ],
    });
    launchMs = Date.now() - launchStart;

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      const line = `[${message.type()}] ${message.text()}`;
      if (consoleLines.length < MAX_LOG_LINES) consoleLines.push(line);
      if (message.text().startsWith("[realtime]")) process.stdout.write(`${message.text()}\n`);
    });
    page.on("pageerror", (error) => {
      browserErrors.push(`pageerror: ${error && error.stack ? error.stack : error}`);
    });
    page.on("requestfailed", (request) => {
      browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
    });
    page.on("download", (download) => {
      browserErrors.push(`unexpected browser download: ${download.suggestedFilename()}`);
    });

    const gotoStart = Date.now();
    await page.goto(pageUrl, { waitUntil: "load", timeout: options.timeoutMs });
    gotoMs = Date.now() - gotoStart;

    const exportStart = Date.now();
    const timer = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new ExportIncomplete(
          `the export did not finish within ${options.timeoutMs} ms ` +
          `(upload ${session.upload.bytes} of ${session.upload.total ?? "unknown"} bytes ` +
          `in ${session.upload.received}/${session.upload.chunks ?? "?"} chunks; ` +
          `${consoleLines.slice(-5).join(" | ")})`,
        ));
      }, options.timeoutMs);
    });
    const report = await Promise.race([reported, timer]);
    const exportMs = Date.now() - exportStart;

    checkExport(report, expected);
    const onDisk = fs.statSync(outPath).size;
    if (onDisk !== report.bytes) {
      throw new ExportIncomplete(
        `uploaded ${onDisk} of ${report.bytes} bytes for ${outPath}`,
      );
    }
    if (browserErrors.length) {
      throw new ExportIncomplete(`browser reported: ${browserErrors[0]}`);
    }

    result.ok = true;
    result.bytes = onDisk;
    result.webgl = report.gl;
    result.scene = report.stats;
    result.frames = report.frames;
    result.report = report;
    result.qa = session.qa.map((entry) => entry.file);
    result.timings = {
      build_ms: build ? build.ms : 0,
      launch_ms: launchMs,
      goto_ms: gotoMs,
      export_ms: exportMs,
      browser: report.timings,
      wall_ms: Date.now() - wallStart,
    };
    return result;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    result.bytes = session.bytes;
    result.report = session.report ?? null;
    result.webgl = session.report?.gl ?? null;
    result.scene = session.report?.stats ?? null;
    result.timings = {
      build_ms: build ? build.ms : 0,
      launch_ms: launchMs,
      goto_ms: gotoMs,
      wall_ms: Date.now() - wallStart,
    };
    if (error instanceof Error) error.result = result;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (session.error) result.server_error = session.error;
  }
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const width = requireNumber(values, "width");
  const height = requireNumber(values, "height");
  const fps = requireNumber(values, "fps");
  const seconds = requireNumber(values, "seconds");
  if (!values.plan || !values.out) throw new Error(`--plan and --out are required\n${USAGE}`);

  const frames = expectedFrames(seconds, fps);
  let settings = null;
  if (values.settings) {
    const settingsPath = path.resolve(values.settings);
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (error) {
      throw new Error(`--settings ${settingsPath}: ${error.message}`);
    }
  }
  const options = {
    plan: values.plan,
    out: values.out,
    width: Math.round(width),
    height: Math.round(height),
    fps: Math.round(fps),
    seconds,
    start: values.start === undefined ? 0 : Number(values.start),
    settings,
    bloom: !flags.has("no-bloom"),
    bitrate: Math.round(Number(values.bitrate ?? 8_000_000)),
    qaFrames: parseQaFrames(values["qa-frames"], frames),
    timeoutMs: Math.round(Number(values.timeout ?? 300) * 1000),
    channel: values.channel ?? "msedge",
    dir: values.dir ? path.resolve(values.dir) : BUILD_DIR,
    noBuild: flags.has("no-build"),
    noSandbox: flags.has("no-sandbox"),
    headful: flags.has("headful"),
    json: values.json,
    report: values.report,
    glb: values.glb,
    config: values.config,
  };
  if (!(options.bitrate > 0)) throw new Error("--bitrate must be positive");

  let result = null;
  let failure = null;
  try {
    result = await runSession(options);
  } catch (error) {
    failure = error;
    result = error.result ?? null;
  }

  if (options.report && result && result.report) {
    fs.writeFileSync(options.report, JSON.stringify(result.report, null, 2));
  }
  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify(
      result ?? { ok: false, error: String(failure?.message ?? failure ?? "no result") },
      null, 2,
    ));
  }

  if (failure) {
    process.stderr.write(`[realtime] export failed: ${failure.message}\n`);
    process.exitCode = 1;
    return;
  }

  const gl = result.webgl ?? {};
  process.stdout.write(
    `[realtime] ${result.frames}/${result.expected} frames, ` +
    `${result.bytes} bytes -> ${result.out}\n` +
    `[realtime] webgl vendor=${gl.vendor} renderer=${gl.unmaskedRenderer ?? gl.renderer}` +
    `${gl.software ? " (SOFTWARE)" : ""}\n` +
    `[realtime] build ${result.timings.build_ms} ms, launch ${result.timings.launch_ms} ms, ` +
    `export ${result.timings.export_ms} ms, wall ${result.timings.wall_ms} ms\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[realtime] ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
