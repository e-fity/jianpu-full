import fs from "node:fs";
import crypto from "node:crypto";
import { loadKit, geometryKey } from "../src/layout_kit.mjs";
import { normalizeSettings } from "../src/settings.mjs";

let source = fs.readFileSync("src/layout.mjs", "utf8");
const fineArg = process.argv[4];
if (fineArg) source = source.replace(/export const FINE_SAMPLES = \d+;/, "export const FINE_SAMPLES = " + fineArg + ";");
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const configs = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
for (const [name, cfg] of Object.entries(configs)) {
  const checked = normalizeSettings(cfg);
  if (!checked.ok) { console.log(name, "REJECTED", checked.errors); continue; }
  const t0 = Date.now();
  const L = await loadKit(source, checked.value.geometry);
  const layout = L.buildLayout(plan);
  const a = layout.audit;
  console.log(name, "key=" + geometryKey(checked.value.geometry).slice(0, 24),
    "L.BOARD_W=" + L.BOARD_W, "L.BOUNCE=" + L.BOUNCE_SCALE,
    "segs=" + layout.segments.length,
    JSON.stringify({ ms: Date.now() - t0, boards: layout.boards.length,
      poses: crypto.createHash("sha1").update(JSON.stringify(layout.boards.map((b) => [b.t, b.midi, b.tilt, b.top_y, b.pos, b.collision ? b.collision.apex : null]))).digest("hex").slice(0, 12),
      forced: a.forced, clearance_fails: a.clearance_fails,
      path_fails: a.path_clearance_fails, path_scan: a.path_scan,
      path_planks: a.path_planks_checked,
      min_clearance: a.min_clearance, path_min: a.path_min_clearance,
      path_travel: a.path_travel_clearance, travel_worst: a.path_travel_worst,
      worst: a.path_worst, overlaps: a.plank_overlaps }));
}
