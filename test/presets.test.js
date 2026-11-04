import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { STYLE_PRESETS, findPreset } from '../public/js/features/presets.js';

test('preset catalog has unique ids and local preview assets', () => {
  const ids = new Set();
  for (const preset of STYLE_PRESETS) {
    assert.equal(ids.has(preset.id), false, `duplicate preset ${preset.id}`);
    ids.add(preset.id);
    assert.ok(preset.title);
    assert.ok(preset.style);
    assert.match(preset.image, /^\/assets\/presets\/[a-z0-9-]+\.(webp|jpg)$/);
    const relative = preset.image.replace(/^\//, '');
    assert.equal(existsSync(path.join(process.cwd(), 'public', relative)), true, preset.image);
  }
  assert.equal(STYLE_PRESETS.length, 16);
  assert.equal(findPreset('missing'), null);
});

test('preset style text does not inject subjects, props, or scenes', () => {
  const leaks = /女性|心形|人物|动物|点心|玩偶|家居|冒险|怪生物|老百姓|角色/;
  for (const preset of STYLE_PRESETS) {
    assert.doesNotMatch(preset.style, leaks, preset.id);
  }
  const watercolor = STYLE_PRESETS.find((preset) => preset.id === 'handraw-fa-021');
  assert.doesNotMatch(watercolor.style, /女性|心形/);
  const deadpan = STYLE_PRESETS.find((preset) => preset.id === 'handraw-fa-001');
  assert.doesNotMatch(deadpan.style, /简单动物|动物/);
});
