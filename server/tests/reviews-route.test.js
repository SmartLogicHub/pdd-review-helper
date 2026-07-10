import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFetchMaxPages } from '../routes/reviews.js';

test('defaults fetch-latest to a small recent-page scan', () => {
  assert.equal(normalizeFetchMaxPages(undefined), 3);
  assert.equal(normalizeFetchMaxPages(null), 3);
  assert.equal(normalizeFetchMaxPages(''), 3);
});

test('respects explicit fetch max page limits', () => {
  assert.equal(normalizeFetchMaxPages('1'), 1);
  assert.equal(normalizeFetchMaxPages(5), 5);
  assert.equal(normalizeFetchMaxPages('bad'), 3);
  assert.equal(normalizeFetchMaxPages(0), 3);
});
