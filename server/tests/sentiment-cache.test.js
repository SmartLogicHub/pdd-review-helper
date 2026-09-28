import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-sentiment-cache-'));

const store = await import('../data/store.js');
const { sentimentFingerprint } = await import('../services/reply-strategy.js');
const { createSentimentCache } = await import('../services/sentiment-cache.js');
const { __testing } = await import('../services/playwright.js');
const { normalizePddReviewItem } = await import('../services/review-normalizer.js');
const { createAutomationManager } = await import('../services/automation.js');

const RISK = { label: 'risk_manual_review', flagged: true, uncertain: false, neutral: false, reason: '先夸后踩：降噪一般', riskWords: ['降噪一般'] };

function memoryCache(options = {}) {
  const saved = [];
  let loads = 0;
  const cache = createSentimentCache({
    load: () => { loads += 1; return options.initial || {}; },
    save: entries => saved.push(JSON.parse(JSON.stringify(entries))),
    fingerprint: (content, stars) => `fp:${content}:${stars}`,
    ...options,
  });
  return { cache, saved, loads: () => loads };
}

function replyableReview(overrides = {}) {
  return normalizePddReviewItem({ reviewId: 'r1', comment: '音质不错，就是降噪一般', descScore: 5, orderSn: 'o1', canReview: true, replyCount: 0, ...overrides });
}

test('cache reuses a verdict only while the fingerprint is unchanged', () => {
  const { cache } = memoryCache();

  assert.equal(cache.get('r1', 'fp-a'), null);
  cache.set('r1', 'fp-a', RISK);
  assert.equal(cache.get('r1', 'fp-a').label, 'risk_manual_review');
  assert.equal(cache.get('r1', 'fp-b'), null, '指纹变化（如改了提示词）必须重判');
  assert.deepEqual(cache.stats(), { hits: 1, misses: 2, stored: 1 });
});

test('cache never stores failed analyses so they are retried next run', () => {
  const { cache } = memoryCache();
  cache.set('r1', 'fp', { analysisFailed: true, analysisErrorKind: 'network' });
  assert.equal(cache.get('r1', 'fp'), null);
});

test('cache loads lazily and only writes when something changed', () => {
  const { cache, saved, loads } = memoryCache();
  cache.flush();
  assert.equal(loads(), 0);
  assert.equal(saved.length, 0);

  cache.set('r1', 'fp', RISK);
  cache.flush();
  cache.flush();
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]), ['r1']);
});

test('cache prunes entries older than the retention window on flush', () => {
  const now = Date.UTC(2026, 8, 28);
  const { cache, saved } = memoryCache({
    now: () => now,
    maxAgeDays: 200,
    initial: { stale: { fp: 'x', at: now - 201 * 86400000, result: RISK } },
  });
  cache.set('fresh', 'fp', RISK);
  cache.flush();
  assert.deepEqual(Object.keys(saved[0]), ['fresh']);
});

test('analyzeAndMark calls the AI once per review and reuses the verdict afterwards', async () => {
  const { cache } = memoryCache();
  let calls = 0;
  const analyzer = async () => { calls += 1; return RISK; };

  const first = await __testing.analyzeAndMark(replyableReview(), analyzer, { cache });
  const second = await __testing.analyzeAndMark(replyableReview(), analyzer, { cache });

  assert.equal(calls, 1);
  assert.equal(first.flagged, true);
  assert.equal(second.flagged, true);
  assert.equal(second.flagReason, '先夸后踩：降噪一般');
  assert.deepEqual(second.riskWords, ['降噪一般']);

  await __testing.analyzeAndMark(replyableReview({ comment: '音质很好' }), analyzer, { cache });
  assert.equal(calls, 2, '评价内容变了要重新判断');
});

test('analyzeAndMark retries reviews whose previous analysis failed', async () => {
  const { cache } = memoryCache();
  let calls = 0;
  const analyzer = async () => { calls += 1; return { analysisFailed: true, analysisErrorKind: 'network', analysisError: '超时' }; };

  await __testing.analyzeAndMark(replyableReview(), analyzer, { cache });
  await __testing.analyzeAndMark(replyableReview(), analyzer, { cache });
  assert.equal(calls, 2);
});

test('the fingerprint changes when the sentiment prompt changes, so edits trigger re-judging', () => {
  store.saveSettings({ aiSentimentEnabled: true, deepseekApiKey: 'sk-test12345678' });
  const before = sentimentFingerprint('音质不错', 5, { shopName: 'A店' });
  assert.equal(sentimentFingerprint('音质不错', 5, { shopName: 'A店' }), before, '输入不变指纹应稳定');

  store.saveSentimentPrompt(`${store.getSentimentPrompt()}\n补充：赠品问题不算差评。`);
  assert.notEqual(sentimentFingerprint('音质不错', 5, { shopName: 'A店' }), before);
  assert.notEqual(sentimentFingerprint('音质不错', 5, { shopName: 'B店' }), before);
});

test('store round-trips the per-account cache and clears it', () => {
  store.saveSentimentCache({ r1: { fp: 'x', at: 1, result: RISK } }, 'acct-a');
  assert.deepEqual(Object.keys(store.getSentimentCache('acct-a')), ['r1']);
  assert.deepEqual(store.getSentimentCache('acct-b'), {});
  store.clearAllSentimentCaches();
  assert.deepEqual(store.getSentimentCache('acct-a'), {});
});

test('automation hands the runner a cache, saves it after the run and reports reuse', async () => {
  const flushed = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: '漫步者极音专卖店' }),
    createRunSentimentCache: accountId => ({
      fingerprint: () => 'fp',
      get: () => null,
      set: () => {},
      flush: () => flushed.push(accountId),
      stats: () => ({ hits: 7, misses: 3, stored: 3 }),
    }),
    runner: async (_genReply, _onProgress, options) => {
      assert.equal(typeof options.sentimentCache?.get, 'function');
      return { total: 10, success: 3, failed: 0, skipped: 7 };
    },
  });

  const job = manager.startReplyGoodReviews();
  const finished = await manager.waitForJob(job.id);

  assert.deepEqual(flushed, ['acct-a']);
  assert.equal(finished.result.sentimentCacheHits, 7);
});
