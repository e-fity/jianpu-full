import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as kit from '../src/layout.mjs';
import { buildGravityLayout, sampleBall } from '../src/gravity_layout.mjs';
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
config.spatial.layeredPhrases=false; // These regressions exercise the earlier search.
const plan=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_search.json',import.meta.url)));

test('a real score escapes a short repeated-note dead end without cycling through the prefix',()=>{
  const before=structuredClone(plan),updates=[];
  const layout=buildGravityLayout(plan,kit,config,p=>updates.push(p));
  assert.equal(layout.boards.length,215);
  assert.deepEqual(plan,before,'search cannot rewrite the score');
  assert.equal(layout.audit.forced,0);
  assert.equal(layout.audit.clearance_fails,0);
  assert.equal(layout.audit.plank_overlaps,0);
  assert.ok(layout.audit.min_contact_spacing>=layout.audit.required_contact_spacing);
  assert.ok(layout.audit.spatial.steering.retries<215*2,'reserve a bounded search budget for entry, level passage and exit');
  assert.ok(updates.filter(p=>p.stage==='排列木板').length<215*6,'avoid repeatedly rebuilding the same prefix');
  for(const group of layout.audit.spatial.phrasing.level_groups) {
    assert.ok(group.end-group.start>=2&&group.end-group.start<=5);
    assert.ok(group.descending_phrases>=3);
  }
  assert.ok(layout.boards.some(b=>b.level_repeat),'retain feasible repeated-note groups');
  for(const b of layout.boards.slice().reverse()) {
    assert.ok(Math.hypot(...sampleBall(layout,b.t).map((x,k)=>x-b.p[k]))<1e-8);
    assert.ok(b.p[0]===0||b.p[0]*b.phrase_side>0);
  }
  assert.deepEqual(buildGravityLayout(plan,kit,config),layout,'the repaired search remains seeded and reproducible');
});


test('the 335-note song completes past plank 282 after leaving a horizontal passage',()=>{
  const score=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_stall_335.json',import.meta.url)));
  const before=structuredClone(score),updates=[];
  const layout=buildGravityLayout(score,kit,config,p=>updates.push(p));
  assert.equal(layout.boards.length,335);assert.deepEqual(score,before);
  assert.equal(layout.audit.forced,0);assert.equal(layout.audit.clearance_fails,0);
  assert.equal(layout.audit.plank_overlaps,0);
  assert.ok(layout.audit.min_contact_spacing>=layout.audit.required_contact_spacing);
  assert.ok(layout.audit.spatial.steering.retries<335*2,'escape blocked transitions instead of repeatedly rebuilding the same region');
  assert.ok(updates.filter(p=>p.stage==='排列木板').length<335*6);
  assert.ok(layout.audit.spatial.phrasing.level_groups.length>0,'retain safe horizontal passages');
  for(const group of layout.audit.spatial.phrasing.level_groups) {
    const row=layout.boards.slice(group.start,group.end+1);
    assert.ok(row.length>=3&&row.length<=6);
    for(const b of row) {
      assert.deepEqual(b.quaternion,[0,0,0,1]);assert.equal(b.top_y,row[0].top_y);
      assert.deepEqual(b.collision.normal,[0,1,0]);
    }
  }
  for(const b of layout.boards.slice().reverse())
    assert.ok(Math.hypot(...sampleBall(layout,b.t).map((x,k)=>x-b.p[k]))<1e-8);
});
