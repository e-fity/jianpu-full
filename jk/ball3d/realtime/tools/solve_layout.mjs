#!/usr/bin/env node
/**
 * Solve one plan with one settings snapshot and report the audit.
 *
 * The editor page, the export page and this tool run the *same* solver: they
 * instantiate realtime/src/layout.mjs for the requested geometry with
 * layout_kit.mjs.  This tool is the server-side gate -- an export whose
 * trajectory does not solve is refused here, before a browser is launched, with
 * the measured numbers rather than a silent fallback.
 *
 * Usage:
 *   node realtime/tools/solve_layout.mjs --plan plan.json [--settings s.json]
 *        [--json out.json] [--layout out.json] [--quiet]
 *
 * Exit code 0 when the audit passes (forced == 0, clearance_fails == 0,
 * plank_overlaps == 0), 1 otherwise; 2 for bad input.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGravityKit } from "../src/gravity_layout.mjs";
import { validatePresentation } from "../src/presentation.mjs";
import { loadKit } from "../src/layout_kit.mjs";
import { normalizeSettings, sceneGeometry } from "../src/settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAYOUT_SOURCE = path.join(ROOT, "realtime", "src", "layout.mjs");

const USAGE = `usage: node realtime/tools/solve_layout.mjs --plan PLAN.json
       [--settings SETTINGS.json] [--config CONFIG.json] [--json OUT.json] [--layout OUT.json] [--quiet]`;

function parseArgs(argv) {
  const out = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}\n${USAGE}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      flags.add(arg.slice(2));
    }
  }
  return { values: out, flags };
}

export async function solvePlan({ plan, settings, presentation }) {
  const check = normalizeSettings(settings);
  if (!check.ok) throw new Error(`invalid settings: ${check.errors.join("; ")}`);
  const source = fs.readFileSync(LAYOUT_SOURCE, "utf8");
  const started = Date.now();
  const baseKit = await loadKit(source, check.value.geometry);
  const kit = presentation ? createGravityKit(baseKit, validatePresentation(presentation)) : baseKit;
  const layout = kit.buildLayout(plan, { seed: plan.layout_seed ?? 0 });
  const ms = Date.now() - started;
  const audit = layout.audit;
  const ok = audit.forced === 0 && audit.clearance_fails === 0
    && audit.plank_overlaps === 0 && (presentation?.spatial?.enabled || (audit.tracks?.rest_overlaps ?? 0) === 0);
  return {
    ok,
    ms,
    settings: check.value,
    constants: {
      board_w: kit.BOARD_W, board_h: kit.BOARD_H, board_d: kit.BOARD_D,
      ball_r: kit.BALL_R, contact_off: kit.CONTACT_OFF, dx_min: kit.DX_MIN,
      bounce_scale: kit.BOUNCE_SCALE, gravity: kit.G,
    },
    counts: {
      boards: layout.boards.length, groups: layout.groups.length,
      channels: layout.channels.length, segments: layout.segments.length,
    },
    audit: {
      forced: audit.forced,
      clearance_fails: audit.clearance_fails,
      clearance_fail_deep: audit.clearance_fail_deep,
      plank_overlaps: audit.plank_overlaps,
      min_clearance: audit.min_clearance,
      plank_gap_min: audit.plank_gap_min,
      plank_gap_guide: audit.plank_gap_guide,
      plank_gap_fails: audit.plank_gap_fails,
      chutes: audit.chutes,
      slide_clearance_fails: audit.slide_clearance_fails,
      slide_min_clearance: audit.slide_min_clearance,
      max_apex: audit.max_apex,
      clearance_scan: audit.clearance_scan,
      min_contact_spacing: audit.min_contact_spacing, required_contact_spacing: audit.required_contact_spacing,
      fast_notes_without_boards: audit.fast_notes_without_boards, flights: audit.flights,
      tracks: audit.tracks, spatial: audit.spatial,
    },
    apexes: layout.boards.map((b) => [b.t, b.collision ? b.collision.apex : 0, b.tilt || 0]),
    onsets: layout.boards.map((b) => b.t),
    scene_geometry: sceneGeometry(kit),
    layout,
  };
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || !values.plan) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = values.plan ? 0 : 2;
    return;
  }
  const plan = JSON.parse(fs.readFileSync(path.resolve(values.plan), "utf8"));
  if (plan.format !== "ball3d-plan-v1") throw new Error("not a ball3d-plan-v1 plan");
  const settings = values.settings
    ? JSON.parse(fs.readFileSync(path.resolve(values.settings), "utf8"))
    : null;
  const presentation = values.config ? JSON.parse(fs.readFileSync(path.resolve(values.config), "utf8")) : null;
  const solved = await solvePlan({ plan, settings, presentation });
  const summary = { ...solved, layout: undefined };
  if (values.json) fs.writeFileSync(path.resolve(values.json), JSON.stringify(summary, null, 1));
  if (values.layout) {
    fs.writeFileSync(path.resolve(values.layout), JSON.stringify(solved.layout));
  }
  if (!flags.has("quiet")) process.stdout.write(`${JSON.stringify(summary.audit)}\n`);
  process.exitCode = solved.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[solve] ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 2;
  });
}

