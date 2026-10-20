import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {planLevelGroups} from '../src/wall_course.mjs';
import {validatePresentation} from '../src/presentation.mjs';
import {courseKey} from '../src/gravity_layout.mjs';
const C=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const score=(count=100)=>({landings:Array.from({length:count},(_,i)=>({t:i*.5,midi:60}))});
const phrases=Array.from({length:100},(_,i)=>({index:Math.floor(i/4),side:Math.floor(i/4)%2?1:-1}));

test('level passages wait several complete descending phrases and remain short and seeded',()=>{
  const plan=score(),before=structuredClone(plan),groups=planLevelGroups(plan,phrases,C.spatial);
  assert.ok(groups.length>=3&&groups.length<=6);
  let previous=-1;
  for(const g of groups) {
    assert.ok(g.end-g.start>=2&&g.end-g.start<=5);
    const elapsed=phrases[g.start].index-(previous<0?0:phrases[previous].index+1);
    assert.ok(elapsed>=3&&elapsed<=5,'the cooling period counts complete rhythmic phrases');
    assert.ok(g.start>previous+2);
    previous=g.end;
  }
  assert.deepEqual(planLevelGroups(plan,phrases,C.spatial),groups);
  assert.deepEqual(plan,before);
  assert.ok(planLevelGroups(plan,phrases,{...C.spatial,levelPhraseGap:8}).length<groups.length);
  for(const max of [3,4,5,6])assert.ok(planLevelGroups(plan,phrases,{...C.spatial,levelMaxNotes:max}).every(g=>g.end-g.start+1===max));
});

test('only adjacent actual repeated pitches qualify, without crossing rests or long gaps',()=>{
  const plan=score();
  plan.landings.forEach((n,i)=>n.midi=60+i);
  assert.deepEqual(planLevelGroups(plan,phrases,C.spatial),[]);
  assert.deepEqual(planLevelGroups(score(8),phrases,C.spatial),[]);
  for(const [kind,change] of [
    ['octave',p=>p.landings[21].midi=72],
    ['long gap',p=>p.landings[21].t=12],
    ['rest',p=>p.rests=[{onset_sec:10.1,dur_sec:.1}]]
  ]) {
    const p=structuredClone(plan);p.landings[20].midi=p.landings[21].midi=60;
    change(p);
    assert.deepEqual(planLevelGroups(p,phrases,C.spatial),[],kind);
  }
});

test('uneven timing cannot stretch a triple beyond the wall width',()=>{
  const p=score(30);p.landings.forEach((n,i)=>n.midi=60+i);
  for(let i=20;i<=22;i++)p.landings[i].midi=60;
  p.landings[21].t=10.1;
  const groups=planLevelGroups(p,phrases,C.spatial);
  assert.deepEqual(groups,[],'an overwide triple is skipped rather than reduced to a pair');
});

test('level frequency and group size are validated integers and affect layout caching',()=>{
  for(const key of ['levelPhraseGap','levelMaxNotes']) {
    const c=structuredClone(C);c.spatial[key]+=.5;
    assert.throws(()=>validatePresentation(c));
    c.spatial[key]=C.spatial[key]-1;
    assert.notEqual(courseKey(c),courseKey(C));
  }
});

 test('two adjacent equal pitches never create a level passage and sizes outside 3..6 are rejected',()=>{
  const p=score(32);p.landings.forEach((n,i)=>n.midi=60+i);
  p.landings[24].midi=p.landings[25].midi=60;
  assert.deepEqual(planLevelGroups(p,phrases,C.spatial),[]);
  for(const value of [2,7,3.5]) {
    const c=structuredClone(C);c.spatial.levelMaxNotes=value;
    assert.throws(()=>validatePresentation(c));
  }
 });


test('a long approach or departure cannot extrapolate flat-row speed beyond the wall',()=>{
  for(const edge of ['entry','exit']) {
    const p=score(32);p.landings.forEach((n,i)=>n.midi=60+i);
    for(let i=20;i<=22;i++)p.landings[i].midi=60;
    const from=edge==='entry'?20:23;
    for(let i=from;i<p.landings.length;i++)p.landings[i].t+=3;
    assert.deepEqual(planLevelGroups(p,phrases,C.spatial),[],edge);
  }
  const p=score(32);p.landings.forEach((n,i)=>n.midi=60+i);
  for(let i=20;i<=22;i++)p.landings[i].midi=60;
  for(let i=20;i<p.landings.length;i++)p.landings[i].t+=1;
  assert.equal(planLevelGroups(p,phrases,C.spatial).length,1,'a bounded longer entry remains valid');
});
