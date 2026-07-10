import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-sentiment-config-test-'));

const store = await import(`../data/store.js?sentiment-config-test=${Date.now()}`);
const sentiment = await import(`../services/sentiment.js?sentiment-config-test=${Date.now()}`);

const {
  addReviewsWithStats,
  getReviews,
  getSentimentPrompt,
  resetSentimentPrompt,
  saveSentimentPrompt,
} = store;

const {
  DEFAULT_SENTIMENT_PROMPT,
  normalizeSentimentResult,
  parseSentimentResponse,
  reanalyzeStoredReviews,
  repairSentimentPrompt,
  renderSentimentPrompt,
  validateSentimentPrompt,
} = sentiment;

test('stores custom sentiment prompt separately and restores the default prompt', () => {
  assert.equal(getSentimentPrompt(), DEFAULT_SENTIMENT_PROMPT);

  const customPrompt = '评价内容：{{reviewContent}}\n星级：{{stars}}\n请只返回 JSON';
  saveSentimentPrompt(customPrompt);

  assert.equal(getSentimentPrompt(), customPrompt);
  assert.equal(resetSentimentPrompt(), DEFAULT_SENTIMENT_PROMPT);
  assert.equal(getSentimentPrompt(), DEFAULT_SENTIMENT_PROMPT);
});

test('renders sentiment prompt variables with empty string fallbacks', () => {
  const rendered = renderSentimentPrompt(
    '店铺={{shopName}} 商品={{productName}} 用户={{userName}} 星级={{stars}} 内容={{reviewContent}}',
    {
      shopName: 'HECATE官方旗舰店',
      stars: 5,
      reviewContent: '音质清晰无杂音',
    }
  );

  assert.equal(rendered, '店铺=HECATE官方旗舰店 商品= 用户= 星级=5 内容=音质清晰无杂音');
});

test('blank sentiment prompt falls back to default and invalid prompt can be repaired', async () => {
  assert.equal(saveSentimentPrompt('   '), DEFAULT_SENTIMENT_PROMPT);
  assert.equal(getSentimentPrompt(), DEFAULT_SENTIMENT_PROMPT);

  const invalid = validateSentimentPrompt('只判断好坏，不返回JSON');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.length > 0, true);

  const repaired = await repairSentimentPrompt('只判断好坏，不返回JSON', async () => DEFAULT_SENTIMENT_PROMPT);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.prompt, DEFAULT_SENTIMENT_PROMPT);
  assert.equal(validateSentimentPrompt(repaired.prompt).ok, true);
});

test('sentiment prompt read falls back to default when the prompt file cannot be created', async () => {
  resetSentimentPrompt();
  const promptPath = Array.from(fs.readdirSync(process.env.PDD_HELPER_DATA_DIR))
    .find(name => name === '情感分析提示词.txt');
  assert.equal(Boolean(promptPath), true);
  rmSync(join(process.env.PDD_HELPER_DATA_DIR, promptPath));

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(file, ...args) {
    if (String(file).includes('情感分析提示词.txt')) {
      const error = new Error('permission denied');
      error.code = 'EPERM';
      throw error;
    }
    return originalWriteFileSync.call(this, file, ...args);
  };

  try {
    assert.equal(getSentimentPrompt(), DEFAULT_SENTIMENT_PROMPT);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test('invalid or incomplete sentiment model output becomes uncertain_skip', () => {
  assert.equal(parseSentimentResponse('不是 JSON').label, 'uncertain_skip');
  assert.equal(parseSentimentResponse('{"label":"bad_label","reason":"x"}').label, 'uncertain_skip');
  assert.equal(normalizeSentimentResult({ label: 'positive_auto_reply' }).label, 'uncertain_skip');
});

test('reanalyze preview and apply update only mutable unreplied review statuses', async () => {
  const accountId = 'reanalyze-account';
  addReviewsWithStats([
    { reviewId: 'safe-1', id: 'safe-1', content: '音质清晰无杂音', stars: 5, replied: false, canReview: true, canInteract: true, replyStatus: 2, flagged: true, flagReason: '旧误判' },
    { reviewId: 'risk-1', id: 'risk-1', content: '音质很好，就是漏音', stars: 5, replied: false, canReview: true, canInteract: true, replyStatus: 2 },
    { reviewId: 'done-1', id: 'done-1', content: '已回复不应修改', stars: 5, replied: true },
    { reviewId: 'blocked-1', id: 'blocked-1', content: '不可回复不应修改', stars: 5, replied: false, replyBlocked: true },
  ], accountId);

  const analyzer = async (review) => {
    if (review.reviewId === 'safe-1') {
      return normalizeSentimentResult({
        label: 'positive_auto_reply',
        can_auto_reply: true,
        is_real_negative: false,
        reason: '明确正面',
        risk_words: [],
        safe_positive_words: ['无杂音'],
      });
    }
    return normalizeSentimentResult({
      label: 'risk_manual_review',
      can_auto_reply: false,
      is_real_negative: true,
      reason: '当前商品存在漏音问题',
      risk_words: ['漏音'],
      safe_positive_words: [],
    });
  };

  const preview = await reanalyzeStoredReviews({ accountId, apply: false, analyzer });
  assert.equal(preview.scanned, 2);
  assert.equal(preview.changed, 2);
  assert.equal(preview.transitions['flagged->pending'], 1);
  assert.equal(preview.transitions['pending->flagged'], 1);

  const beforeApply = getReviews(accountId);
  assert.equal(beforeApply.find(review => review.reviewId === 'safe-1').flagged, true);

  const applied = await reanalyzeStoredReviews({ accountId, apply: true, analyzer });
  assert.equal(applied.changed, 2);

  const reviews = getReviews(accountId);
  const safe = reviews.find(review => review.reviewId === 'safe-1');
  const risk = reviews.find(review => review.reviewId === 'risk-1');
  const done = reviews.find(review => review.reviewId === 'done-1');
  const blocked = reviews.find(review => review.reviewId === 'blocked-1');

  assert.equal(safe.flagged, false);
  assert.equal(safe.sentimentLabel, 'positive_auto_reply');
  assert.deepEqual(safe.safePositiveWords, ['无杂音']);
  assert.equal(risk.flagged, true);
  assert.equal(risk.flagReason, '当前商品存在漏音问题');
  assert.deepEqual(risk.riskWords, ['漏音']);
  assert.equal(done.replied, true);
  assert.equal(blocked.replyBlocked, true);
});
