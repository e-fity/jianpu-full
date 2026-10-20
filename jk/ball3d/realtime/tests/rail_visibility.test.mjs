import test from 'node:test';
import assert from 'node:assert/strict';
import { railVisible } from '../src/rail_glow.mjs';

test('wall fixtures remain present before, during and after passage, including reverse seeks',()=>{
  const rail={visibleFrom:4,visibleUntil:7};
  for(const t of [0,3.999,4,5,6.999,7,12,7,5,0])assert.equal(railVisible(rail,t,true),true);
});
test('legacy phrase visibility remains unchanged',()=>{
  const rail={visibleFrom:4,visibleUntil:7};
  for(const t of [0,3,7,12])assert.equal(railVisible(rail,t),false);
  for(const t of [4,5,6])assert.equal(railVisible(rail,t),true);
});
