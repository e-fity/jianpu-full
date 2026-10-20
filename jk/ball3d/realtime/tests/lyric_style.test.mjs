import test from 'node:test';
import assert from 'node:assert/strict';
import {lyricMetrics} from '../src/lyric_style.mjs';

test('large lyrics keep the same frame proportion at 720x1280 and 1080x1920',()=>{
  const small=lyricMetrics('都',720/1280),large=lyricMetrics('都',1080/1920);
  assert.equal(small.halfH*1280,80);
  assert.equal(large.halfH*1920,120);
  assert.equal(small.halfW,large.halfW);
  assert.equal(small.gap*1280/2,8);
  assert.equal(large.gap*1920/2,12);
});

test('sharp lyric textures preserve the text aspect ratio and glyph padding',()=>{
  for(const text of ['都','一起','不频繁']) {
    const metrics=lyricMetrics(text,9/16);
    assert.equal(metrics.textureHeight,256);
    assert.equal(metrics.fontSize/metrics.textureHeight,40/64);
    assert.equal(metrics.textureWidth/metrics.textureHeight,metrics.halfW*(9/16)/metrics.halfH);
    assert.ok(metrics.textureWidth>=metrics.fontSize*text.length);
    assert.ok(metrics.textureHeight>metrics.fontSize);
  }
});
