import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {planLayerPhrases} from '../src/layer_phrase_plan.mjs';

const score=count=>({landings:Array.from({length:count},(_,i)=>({t:i*.5,midi:60+i%7,lyric:'字'}))});
const checkCoverage=(plan,groups)=>{
  assert.deepEqual(groups.flatMap(g=>Array.from({length:g.end-g.start+1},(_,i)=>g.start+i)),plan.landings.map((_,i)=>i));
  for(const [i,g] of groups.entries()) {
    const size=g.end-g.start+1;
    assert.equal(g.index,i);
    assert.ok(size>=4&&size<=8||plan.landings.length<4);
    assert.ok(g.direction===1||g.direction===-1);
    assert.equal(typeof g.level,'boolean');
    assert.equal(typeof g.fast_rebound,'boolean');
    assert.ok(Array.isArray(g.rebound_starts));
    assert.equal(g.rebound_start,g.rebound_starts[0]);
    if(i)assert.equal(g.direction,-groups[i-1].direction);
  }
};

test('all lengths from zero to forty cover every note without a short tail',()=>{
  for(let count=0;count<=40;count++)for(const seed of [0,1,2026]) {
    const plan=score(count),before=structuredClone(plan),groups=planLayerPhrases(plan,seed);
    checkCoverage(plan,groups);
    assert.deepEqual(plan,before);
    if(count>0&&count<4)assert.equal(groups.length,1);
  }
});

test('rest, long gap and lyric punctuation favour the corresponding phrase boundary',()=>{
  for(const cue of ['rest','gap','punctuation']) {
    const plan=score(12);
    if(cue==='rest')plan.rests=[{onset_sec:2.1,dur_sec:.2}];
    if(cue==='gap')for(let i=5;i<12;i++)plan.landings[i].t+=1.5;
    if(cue==='punctuation')plan.landings[4].lyric='句。';
    for(const seed of [0,1,2026]) {
      const groups=planLayerPhrases(plan,seed);
      assert.deepEqual(groups.map(g=>g.end-g.start+1),[5,7],cue);
    }
  }
});

test('ordinary descents have a clear short-long contrast without rewriting notes',()=>{
  const plan=score(120),before=structuredClone(plan);
  for(const seed of [0,1,2026]) {
    const groups=planLayerPhrases(plan,seed);
    assert.ok(groups.some((a,i)=>{
      const b=groups[i+1];
      return b&&!a.level&&!b.level&&!a.rebound_starts.length&&!b.rebound_starts.length&&
        Math.abs((a.end-a.start)-(b.end-b.start))>=3;
    }),'ordinary descents include adjacent lengths differing by at least three boards');
    checkCoverage(plan,groups);checkSparse(plan,groups);
    assert.deepEqual(planLayerPhrases(plan,seed),groups);
  }
  assert.deepEqual(plan,before);
});

test('seed repeats exactly and permits different phrasing and initial direction',()=>{
  const plan=score(100),groups=planLayerPhrases(plan,2026);
  assert.deepEqual(planLayerPhrases(plan,2026),groups);
  const versions=Array.from({length:12},(_,seed)=>planLayerPhrases(plan,seed));
  assert.ok(new Set(versions.map(gs=>JSON.stringify(gs.map(g=>g.end)))).size>1);
  assert.ok(new Set(versions.map(gs=>gs[0].direction)).size===2);
  assert.ok(new Set(groups.map(g=>g.end-g.start+1)).size>1,'uniform notes do not force fixed six-note cuts');
});

test('the complete real 335-note song has valid varied phrase layers',()=>{
  const plan=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_stall_335.json',import.meta.url)));
  assert.equal(plan.landings.length,335);
  const groups=planLayerPhrases(plan,2026);
  checkCoverage(plan,groups);
  assert.ok(groups.length>=Math.ceil(335/8)&&groups.length<=Math.floor(335/4));
  assert.ok(new Set(groups.map(g=>g.end-g.start+1)).size>=3);
  assert.deepEqual(planLayerPhrases(plan,2026),groups);
  const ends=new Set(groups.map(g=>g.end));
  const marked=plan.landings.flatMap((n,i)=>/[，。！？；：,.!?;:]\s*$/u.test(n.lyric||'')?[i]:[]);
  assert.ok(marked.filter(i=>ends.has(i)).length>=marked.length/2,'most lyric phrase endings align to layers');
});

function checkSparse(plan,groups,wait=4,maxNotes=6) {
  const levels=groups.filter(g=>g.level);
  assert.ok(groups.slice(0,wait).every(g=>!g.level),'several whole phrases descend before the first horizontal accent');
  for(const [i,g] of levels.entries()) {
    assert.ok(g.end-g.start+1>=4&&g.end-g.start+1<=maxNotes);
    assert.ok(g.start>0&&g.end<plan.landings.length-1,'horizontal accents have both an approach and an exit');
    const times=plan.landings.slice(g.start-1,g.end+2).map(n=>n.t);
    const intervals=times.slice(1).map((t,j)=>t-times[j]);
    assert.ok(Math.min(...intervals)>0&&Math.max(...intervals)<=2.4*Math.min(...intervals),'timing stays compatible from the approach through the exit');
    if(i)assert.ok(g.index-levels[i-1].index-1>=wait,'each horizontal phrase has a complete descending cooldown');
  }
  assert.ok(levels.reduce((sum,g)=>sum+g.end-g.start,0)<=.2*Math.max(0,plan.landings.length-1),'horizontal jumps occupy at most one fifth of the score');
}

test('all real songs retain sparse 4–6-note horizontal accents amid descending phrases',()=>{
  for(const name of ['wall_accents','wall_search','wall_stall_335']) {
    const plan=JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url)));
    for(const seed of [1,2026,20261013]) {
      const groups=planLayerPhrases(plan,seed,{levelPhraseGap:4,levelMaxNotes:6});
      checkCoverage(plan,groups);checkSparse(plan,groups);
      assert.ok(groups.some(g=>g.level),`${name} seed ${seed} retains at least one horizontal accent`);
      assert.deepEqual(planLayerPhrases(plan,seed,{levelPhraseGap:4,levelMaxNotes:6}),groups);
    }
  }
});

test('horizontal accents prefer repeated pitch without requiring every pitch to match',()=>{
  const plan=score(120),before=planLayerPhrases(plan,2026);
  const target=before.slice(4,7).filter(g=>g.end-g.start+1<=6&&g.start>0&&g.end<plan.landings.length-1).at(-1);
  assert.ok(target);
  for(let i=target.start;i<=target.end;i++)plan.landings[i].midi=60;
  const groups=planLayerPhrases(plan,2026);
  assert.equal(groups.find(g=>g.level).index,target.index,'the repeated-pitch phrase wins the first candidate window');
  const varied=planLayerPhrases(score(120),2026);
  assert.ok(varied.some(g=>g.level),'a stable phrase with varied pitches remains eligible');
  checkSparse(plan,groups);checkSparse(score(120),varied);
});

test('steady phrases with long entry and exit gaps are not horizontal accents',()=>{
  const plan=score(72);
  for(const [i,n] of plan.landings.entries()) {
    n.t+=Math.floor(i/6)*2.5;
    if(i%6===5)n.lyric='句。';
  }
  const groups=planLayerPhrases(plan,20261013);
  assert.ok(groups.every(g=>g.end-g.start+1===6),'the long gaps retain their musical phrase boundaries');
  assert.ok(groups.every(g=>!g.level),'uniform timing inside a phrase is insufficient when its connections are too slow');
});

test('existing cooldown and maximum-note options constrain sparse accents',()=>{
  const plan=score(240);
  const groups=planLayerPhrases(plan,2026,{levelPhraseGap:8,levelMaxNotes:5});
  checkSparse(plan,groups,8,5);
  assert.ok(groups.some(g=>g.level));
  assert.ok(planLayerPhrases(plan,2026,{levelMaxNotes:3}).every(g=>!g.level),'four-note phrases cannot be reduced to fit a smaller accent limit');
  for(let count=0;count<=40;count++)checkSparse(score(count),planLayerPhrases(score(count),2026));
});

test('ordinary real-song rebound accents retain their sparse interior placement',()=>{
  for(const name of ['wall_accents','wall_search','wall_stall_335']) {
    const plan=JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url)));
    for(const seed of [1,2026,20261013]) {
      const groups=planLayerPhrases(plan,seed),rebounds=groups.filter(g=>g.rebound_start!=null&&!g.fast_rebound);
      assert.ok(rebounds.length>0,`${name} seed ${seed} includes a rebound`);
      assert.ok(rebounds[0].index>=3,'opening phrases retain the descending pattern');
      for(const [i,g] of rebounds.entries()) {
        const p=g.rebound_start;
        assert.ok(g.start<p&&p+1<g.end,'both rebound boards lie inside the phrase');
        assert.ok(!g.level&&!groups[g.index-1]?.level&&!groups[g.index+1]?.level,'horizontal phrases and their neighbours stay clear');
        if(i)assert.ok(g.index-rebounds[i-1].index>=4,'at least three whole phrases separate rebounds');
        assert.ok(p>=2&&p+3<plan.landings.length,'the complete transition window lies inside the score');
        const times=plan.landings.slice(p-2,p+4).map(n=>n.t);
        const intervals=times.slice(1).map((t,j)=>t-times[j]);
        assert.ok(Math.min(...intervals)>0&&Math.max(...intervals)<=2.4*Math.min(...intervals),'the crossing and both surrounding transitions have compatible timing');
      }
      checkCoverage(plan,groups);checkSparse(plan,groups);
      assert.deepEqual(planLayerPhrases(plan,seed),groups);
    }
  }
});

test('a long rest just before the 335-note song rebound prevents premature reversal',()=>{
  const plan=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_stall_335.json',import.meta.url)));
  assert.ok(plan.landings[112].t-plan.landings[111].t>2,'the reported approach contains the two-second rest');
  const groups=planLayerPhrases(plan,20261013);
  assert.ok(groups.every(g=>!g.rebound_starts.includes(113)),'the short crossing cannot hide its long approach transition');
  assert.ok(groups.some(g=>g.rebound_start!=null),'other stable rebound accents remain');
});

test('rebound timing eligibility rejects abrupt short-long alternation',()=>{
  const plan=score(240);
  let onset=0;
  for(const [i,n] of plan.landings.entries()) {n.t=onset;onset+=i%2?.1:1;}
  assert.ok(planLayerPhrases(plan,20261013).every(g=>g.rebound_start==null));
  const placements=Array.from({length:12},(_,seed)=>planLayerPhrases(score(240),seed)
    .filter(g=>g.rebound_start!=null).map(g=>g.rebound_start));
  assert.ok(new Set(placements.map(JSON.stringify)).size>1,'the seed varies rebound placement');
});

test('dense real rhythms favour short rebound bursts while slower songs keep ordinary accents',()=>{
  for(const name of ['wall_accents','wall_search','wall_stall_335']) {
    const plan=JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url)));
    for(const seed of [1,2026,20261013]) {
      const groups=planLayerPhrases(plan,seed),fast=groups.filter(g=>g.fast_rebound);
      const gaps=plan.landings.slice(1).map((n,i)=>n.t-plan.landings[i].t),sorted=gaps.slice().sort((a,b)=>a-b);
      const threshold=Math.min(.3,1.1*sorted[Math.floor(sorted.length/2)]);
      if(name==='wall_accents')assert.equal(fast.length,0,'isolated short notes do not turn a slow song into constant collisions');
      else assert.ok(fast.length>0,`${name} includes stable fast passages`);
      for(const [i,g] of fast.entries()) {
        assert.ok(g.rebound_starts.length>=1&&g.rebound_starts.length<=3);
        assert.equal(g.rebound_start,g.rebound_starts[0]);
        assert.ok(g.index>=3,'opening phrases still establish the descending route');
        assert.ok(!g.level&&!groups[g.index-1]?.level&&!groups[g.index+1]?.level);
        if(i)assert.ok(g.index-fast[i-1].index>=2,'at least one whole phrase separates fast bursts');
        if(g.rebound_starts.length===2) {
          assert.equal(g.rebound_starts[1],g.rebound_starts[0]+2,'a burst has at most four consecutive rebound boards');
          assert.ok(gaps[g.rebound_starts[0]+1]<=threshold+1e-7,'the two pairs belong to the same fast run');
        }
        if(g.rebound_starts.length===3) {
          assert.deepEqual(g.rebound_starts,[g.start+1,g.start+3,g.start+5]);
          const window=gaps.slice(g.start,g.end);
          assert.equal(window.length,7,'six rebound boards retain their entry and exit transitions');
          assert.ok(Math.min(...window)>0&&Math.max(...window)<=2.4*Math.min(...window)+1e-7);
          assert.ok(window.filter(dt=>dt<=threshold+1e-7).length>=3,'a mixed run still needs several fast beats');
        }
        for(const p of g.rebound_starts) {
          assert.ok(g.start<p&&p+1<g.end);
          if(g.rebound_starts.length===3)continue;
          assert.ok(gaps[p]<=threshold+1e-7,'the crossing is both absolutely short and near the score tempo');
          const window=gaps.slice(p-2,p+3);
          assert.equal(window.length,5);
          assert.ok(Math.min(...window)>0&&Math.max(...window)<=2.4*Math.min(...window)+1e-7);
          assert.ok(window.filter(dt=>dt<=threshold+1e-7).length>=3,'one isolated short note does not qualify');
        }
      }
      const occupied=fast.reduce((sum,g)=>sum+2*g.rebound_starts.length,0);
      assert.ok(occupied<.35*plan.landings.length,'rebound bursts remain accents rather than every beat');
      checkCoverage(plan,groups);checkSparse(plan,groups);
      assert.deepEqual(planLayerPhrases(plan,seed),groups);
    }
  }
});

test('a sustained fast passage can use two consecutive pairs and preserves sparse horizontal accents',()=>{
  const plan=score(240);
  for(const [i,n] of plan.landings.entries())n.t=i*.2;
  const before=structuredClone(plan),groups=planLayerPhrases(plan,20261013);
  assert.ok(groups.some(g=>g.fast_rebound&&g.rebound_starts.length===2));
  assert.ok(groups.some(g=>!g.fast_rebound&&!g.level),'not every fast phrase is converted to rebounds');
  assert.ok(planLayerPhrases(score(240),20261013).every(g=>!g.fast_rebound),'half-second notes retain ordinary rebound timing');
  assert.deepEqual(plan,before);
  checkCoverage(plan,groups);checkSparse(plan,groups);
});

test('a stable mixed-rhythm phrase can fit three consecutive pairs with entry and exit boards',()=>{
  const plan=score(96);let onset=.8;
  for(const [i,n] of plan.landings.entries()) {
    n.t=onset;n.lyric=i%8===7?'字，':'字';
    onset+=[.2,.2,.2,.2,.4,.4,.4,.8][i%8];
  }
  const before=structuredClone(plan),groups=planLayerPhrases(plan,20261013);
  const bursts=groups.filter(g=>g.rebound_starts.length===3);
  assert.ok(bursts.length>0,'a stable six-board run is not reduced to isolated pairs');
  for(const g of bursts) {
    assert.equal(g.fast_rebound,true);
    assert.deepEqual(g.rebound_starts,[g.start+1,g.start+3,g.start+5]);
    assert.ok(g.rebound_starts.at(-1)+1<g.end,'the last rebound retains a receiving board');
    assert.ok(!g.level&&!groups[g.index-1]?.level&&!groups[g.index+1]?.level);
  }
  assert.deepEqual(plan,before);
  checkCoverage(plan,groups);checkSparse(plan,groups);
});
