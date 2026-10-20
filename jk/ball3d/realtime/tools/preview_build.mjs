#!/usr/bin/env node
/**
 * Build a **self-contained** 2D layout preview HTML for one plan.
 *
 * It bundles ``src/preview2d.mjs`` (which imports only ``layout.mjs``) with the
 * locally installed esbuild and inlines both the bundle and the plan JSON, so
 * the result opens from ``file://`` with no server, no CDN and no three.js.
 *
 * Usage:
 *   node realtime/tools/preview_build.mjs --plan plan.json --out preview.html \
 *     [--seed 0] [--minify]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

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

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (!values.plan || !values.out) {
    throw new Error("--plan and --out are required");
  }
  const planPath = path.resolve(values.plan);
  const outPath = path.resolve(values.out);
  const seed = values.seed ?? 0;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (plan.format !== "ball3d-plan-v1") {
    throw new Error(`${planPath}: not a ball3d-plan-v1 file`);
  }

  const result = await build({
    entryPoints: [path.join(ROOT, "src", "preview2d.mjs")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["edge120"],
    minify: flags.has("minify"),
    write: false,
    legalComments: "none",
    logLevel: "warning",
  });
  const code = result.outputFiles[0].text;

  const html = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>音乐装置 2D 编排预览</title></head>
<body>
<script>window.__PLAN=${JSON.stringify(plan).replaceAll("<", "\\u003c")};window.__LAYOUT_SEED=${JSON.stringify(seed)};</script>
<script>${code}</script>
</body>
</html>
`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  const bytes = Buffer.byteLength(html);
  process.stdout.write(
    `[layout-preview] ${planPath} -> ${outPath} (${bytes} bytes, seed ${seed})\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[layout-preview] ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
