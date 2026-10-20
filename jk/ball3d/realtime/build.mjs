#!/usr/bin/env node
/**
 * Bundle the browser side with the *locally installed* esbuild.
 *
 * No CDN, no import map, no network at runtime: the page gets one local file,
 * ``build/export.bundle.js``, plus the copied ``build/export.html``.  Run it
 * with ``node realtime/build.mjs`` (``export_session.mjs`` also calls it).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BUILD_DIR = path.join(ROOT, "build");
export const BUNDLE_NAME = "export.bundle.js";
export const EDITOR_BUNDLE_NAME = "editor.bundle.js";

// The page explicitly requires WebCodecs. Stub unused encoder classes rather
// than leaving bare package imports that a browser cannot resolve.
const unusedEncoders = {
  name: "ball3d-unused-encoders",
  setup(context) {
    const namespace = "ball3d-unused-encoders";
    context.onResolve({ filter: /(H264MP4|GIF|Frame|FFmpeg|MP4Wasm|MediaCapture)Encoder\.js$/ }, (args) => ({
      path: args.path,
      namespace,
    }));
    context.onLoad({ filter: /.*/, namespace }, () => ({
      contents:
        "export default class UnsupportedEncoder { constructor() { " +
        "throw new Error('This exporter requires WebCodecs'); } }",
      loader: "js",
    }));
  },
};

/**
 * Build the browser bundles and the editor layout worker.
 *
 * ``export.bundle.js``  is the headless export page (WebCodecs encoder).
 * ``editor.bundle.js``  is the 3D editor page (``web/editor.html``) -- the same
 *                       modules, one shared format so a runtime
 *                       ``import(blobUrl)`` of the layout source still works.
 * ``layout-worker.js``   is the editor's cancellable CPU-only solver.
 *
 * @param {object} [options]
 * @param {string} [options.outdir] defaults to ``realtime/build``
 * @param {boolean} [options.minify]
 * @param {string} [options.logLevel] esbuild log level
 * @returns {Promise<{outdir, bundle, bytes, inputs, ms, editor, editorBytes}>}
 */
export async function bundle({ outdir = BUILD_DIR, minify = false, logLevel = "warning" } = {}) {
  const started = Date.now();
  fs.mkdirSync(outdir, { recursive: true });

  const result = await build({
    entryPoints: { "export.bundle": path.join(ROOT, "src", "export.mjs") },
    outdir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["edge120"],
    minify,
    sourcemap: false,
    legalComments: "eof",
    external: [],
    plugins: [unusedEncoders],
    metafile: true,
    logLevel,
  });

  const editorResult = await build({
    entryPoints: {
      "editor.bundle": path.join(ROOT, "src", "editor_app.mjs"),
      "layout-worker": path.join(ROOT, "src", "layout_worker.mjs"),
    },
    outdir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["edge120"],
    minify,
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    logLevel,
  });

  fs.copyFileSync(
    path.join(ROOT, "src", "export.html"),
    path.join(outdir, "export.html"),
  );

  const bundlePath = path.join(outdir, BUNDLE_NAME);
  const bytes = fs.statSync(bundlePath).size;
  const inputs = Object.keys(result.metafile.inputs).length;
  const editorBundle = path.join(outdir, EDITOR_BUNDLE_NAME);
  const editorBytes = fs.statSync(editorBundle).size;
  const html = fs.readFileSync(path.join(ROOT, "src", "export.html"), "utf8");
  if (!html.includes(BUNDLE_NAME)) {
    throw new Error(`src/export.html does not reference ${BUNDLE_NAME}`);
  }
  return {
    outdir, bundle: bundlePath, bytes, inputs, ms: Date.now() - started,
    editor: editorBundle, editorBytes,
    editorInputs: Object.keys(editorResult.metafile.inputs).length,
  };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const info = await bundle({ minify: process.argv.includes("--minify") });
  console.log(
    `[realtime] bundled ${info.inputs} modules -> ${info.bundle} ` +
    `(${info.bytes} bytes, ${info.ms} ms)`,
  );
  console.log(
    `[realtime] bundled ${info.editorInputs} modules -> ${info.editor} ` +
    `(${info.editorBytes} bytes)`,
  );
}
