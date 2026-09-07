import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFetchMaxPages, reviewStatsPayload } from '../routes/reviews.js';

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

test('review fetch responses expose AI analysis failure statistics', () => {
  assert.deepEqual(reviewStatsPayload({
    total: 10,
    replied: 2,
    unreplied: 3,
    pending: 2,
    neutral: 1,
    actionable: 3,
    flagged: 1,
    blocked: 1,
    uncertain: 1,
    analysisFailed: 2,
  }), {
    total: 10,
    replied: 2,
    unreplied: 3,
    pending: 2,
    neutral: 1,
    actionable: 3,
    flagged: 1,
    blocked: 1,
    uncertain: 1,
    analysisFailed: 2,
  });
});
