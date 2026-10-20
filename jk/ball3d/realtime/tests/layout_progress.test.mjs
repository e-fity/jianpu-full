import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as kit from "../src/layout.mjs";
import { buildGravityLayout } from "../src/gravity_layout.mjs";
const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));
const plan = { duration: 7, tempo_qpm: 100, landings: Array.from({ length: 10 }, (_, i) =>
  ({ t: 1 + .5 * i, n: i % 7 + 1, midi: 60 + i, dur: .5 })) };

for (const mode of ["wall", "spatial", "gravity", "classic"]) {
  test(`${mode}: reporting real phases leaves the seeded layout unchanged`, () => {
    const c = structuredClone(config);
    c.spatial.enabled = mode !== "gravity";
    c.spatial.wallMounted = mode === "wall";
    const updates = [];
    const build = notify => mode === "classic"
      ? kit.buildLayout(plan, { onProgress: notify })
      : buildGravityLayout(plan, kit, c, notify);
    const expected = build();
    assert.deepEqual(build(p => updates.push(p)), expected);
    assert.ok(updates.some(p => p.stage === "排列木板" && p.percent > 0));
    assert.ok(updates.some(p => p.stage === "检查球路"));
    for (const p of updates) {
      assert.ok(p.percent >= 0 && p.percent < 100, JSON.stringify(p));
      if (p.total) assert.ok(p.completed >= 0 && p.completed <= p.total);
    }
  });
}
