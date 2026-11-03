import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/services/update-service.js';

test('compares release versions including prereleases', () => {
  assert.equal(compareVersions('v1.0.3', '1.0.2'), 1);
  assert.equal(compareVersions('1.0.2', 'v1.0.2'), 0);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.2-beta.2', '1.0.2'), -1);
  assert.equal(compareVersions('1.0.2-beta.2', '1.0.2-beta.1'), 1);
  assert.equal(compareVersions('bad', '1.0.2'), 0);
});
