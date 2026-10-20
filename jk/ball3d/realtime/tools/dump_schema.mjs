#!/usr/bin/env node
/**
 * Write ball3d/editor_schema.json from realtime/src/settings.mjs.
 *
 * The Python API validates the same settings, and it must not drift from the
 * JavaScript schema, so the file is generated from the single source of truth
 * and a test (`--check`) fails when it is stale.
 *
 * Usage: node realtime/tools/dump_schema.mjs [--out FILE] [--check]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schemaJson } from "../src/settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUT = path.join(ROOT, "editor_schema.json");

const args = process.argv.slice(2);
const check = args.includes("--check");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : DEFAULT_OUT;
const text = `${JSON.stringify(schemaJson(), null, 1)}\n`;

if (check) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (current !== text) {
    process.stderr.write(
      `[schema] ${out} is stale: run node realtime/tools/dump_schema.mjs\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`[schema] ${out} is up to date\n`);
  }
} else {
  fs.writeFileSync(out, text);
  process.stdout.write(`[schema] wrote ${out} (${text.length} bytes)\n`);
}

