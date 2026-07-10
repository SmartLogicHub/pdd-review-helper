import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-store-test-'));

const store = await import(`../data/store.js?store-test=${Date.now()}`);
const {
  __testing,
  addReviewsWithStats,
  createAccount,
  getAccountsSummary,
  getAccountsState,
  getNeutralTemplates,
  getReviews,
  getStats,
  markExternalRiskSync,
  markReviewFlagged,
  markReviewNeutral,
  markReviewUncertain,
  saveNeutralTemplates,
  switchAccount,
  updateAccountShopName,
} = store;

test('finds a stored review by order number so single replies update local state', () => {
  const reviews = [
    { id: 'r-1', reviewId: 'r-1', orderNo: '260610-572270866073560', replied: false },
  ];

  const found = __testing.findReviewForUpdate(reviews, {
    reviewId: 'remote-r-1',
    orderSn: '260610-572270866073560',
  });

  assert.equal(found, reviews[0]);
});

test('keeps review pools isolated per account and switches the current account', () => {
  addReviewsWithStats([
    { id: 'default-r1', reviewId: 'default-r1', content: 'default', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
  ]);

  const second = createAccount({ name: 'second shop' });
  switchAccount(second.id);
  addReviewsWithStats([
    { id: 'second-r1', reviewId: 'second-r1', content: 'second', replied: true },
  ]);

  assert.deepEqual(getReviews().map(review => review.reviewId), ['second-r1']);
  assert.equal(getStats().replied, 1);

  switchAccount('default');
  assert.deepEqual(getReviews().map(review => review.reviewId), ['default-r1']);
  assert.equal(getStats().unreplied, 1);

  const state = getAccountsState();
  assert.equal(state.currentAccountId, 'default');
  assert.equal(state.accounts.some(account => account.id === second.id && account.name === 'second shop'), true);
});

test('stores the real detected shop name separately from the account note', () => {
  const account = createAccount({ name: 'account note only' });

  const updated = updateAccountShopName(account.id, 'HECATE官方旗舰店', { source: 'dom' });

  assert.equal(updated.name, 'account note only');
  assert.equal(updated.shopName, 'HECATE官方旗舰店');
  assert.equal(updated.shopNameStatus, 'detected');
  assert.equal(updated.shopNameSource, 'dom');

  const state = getAccountsState();
  const stored = state.accounts.find(item => item.id === account.id);
  assert.equal(stored.shopName, 'HECATE官方旗舰店');
});

test('marks flagged and uncertain reviews in the local pool without mixing their statuses', () => {
  const accountId = 'sentiment_case';
  addReviewsWithStats([
    { id: 'risk-r1', reviewId: 'risk-r1', content: '音质很好，就是漏音', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
    { id: 'uncertain-r1', reviewId: 'uncertain-r1', content: '还行', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
  ], accountId);

  markReviewFlagged({ reviewId: 'risk-r1' }, '当前商品存在漏音问题', accountId);
  markReviewUncertain({ reviewId: 'uncertain-r1' }, '评价信息不足，跳过自动回复', accountId);

  const reviews = getReviews(accountId);
  const risk = reviews.find(review => review.reviewId === 'risk-r1');
  const uncertain = reviews.find(review => review.reviewId === 'uncertain-r1');
  const stats = getStats(accountId);

  assert.equal(risk.flagged, true);
  assert.equal(risk.uncertainSkip, false);
  assert.equal(uncertain.flagged, false);
  assert.equal(uncertain.uncertainSkip, true);
  assert.equal(stats.flagged, 1);
  assert.equal(stats.uncertain, 1);
  assert.equal(stats.unreplied, 0);
});

test('stores external risk sync status on the flagged review', () => {
  const accountId = 'risk_sync_case';
  addReviewsWithStats([
    { id: 'risk-sync-r1', reviewId: 'risk-sync-r1', orderNo: '260610-1', content: '音质很好，就是漏音', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
  ], accountId);
  markReviewFlagged({ reviewId: 'risk-sync-r1' }, '当前商品存在漏音问题', accountId);

  const updated = markExternalRiskSync({ reviewId: 'risk-sync-r1' }, {
    status: 'synced',
    riskCaseKey: 'risk_sync_case:risk-sync-r1',
    feishuRecordId: 'rec123',
    wecomNotifiedAt: '2026-06-26T00:00:00.000Z',
  }, accountId);

  assert.equal(updated.riskSyncStatus, 'synced');
  assert.equal(updated.riskCaseKey, 'risk_sync_case:risk-sync-r1');
  assert.equal(updated.feishuRecordId, 'rec123');
  assert.equal(updated.wecomNotifiedAt, '2026-06-26T00:00:00.000Z');
});

test('does not store platform blocked text as a flagged review reason', () => {
  const accountId = 'flagged_reason_case';
  addReviewsWithStats([
    {
      id: 'risk-blocked-r1',
      reviewId: 'risk-blocked-r1',
      content: '戴久了耳朵疼',
      replied: false,
      canReview: false,
      canInteract: true,
      replyStatus: 2,
      riskWords: ['耳朵疼'],
    },
  ], accountId);

  markReviewFlagged(
    {
      reviewId: 'risk-blocked-r1',
      riskWords: ['耳朵疼'],
      flagReason: '当前商品存在耳朵疼问题',
    },
    '平台不允许回复/互动',
    accountId
  );

  const review = getReviews(accountId).find(item => item.reviewId === 'risk-blocked-r1');

  assert.equal(review.flagged, true);
  assert.equal(review.flagReason, '当前商品存在耳朵疼问题');
  assert.deepEqual(review.riskWords, ['耳朵疼']);
});

test('cleans legacy flagged review reasons when reading stored reviews', () => {
  const accountId = 'legacy_flagged_reason_case';
  addReviewsWithStats([
    {
      id: 'legacy-risk-r1',
      reviewId: 'legacy-risk-r1',
      content: '戴久了耳朵疼',
      replied: false,
      flagged: true,
      flagReason: '平台不允许回复/互动',
      riskWords: ['耳朵疼'],
    },
  ], accountId);

  const review = getReviews(accountId).find(item => item.reviewId === 'legacy-risk-r1');

  assert.equal(review.flagReason, '耳朵疼');
});

test('marks neutral reviews as conservative auto-reply targets', () => {
  const accountId = 'neutral_case';
  addReviewsWithStats([
    { id: 'neutral-r1', reviewId: 'neutral-r1', content: '还行', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
  ], accountId);

  markReviewNeutral({ reviewId: 'neutral-r1' }, '中性评价，使用保守回复', accountId);

  const review = getReviews(accountId).find(item => item.reviewId === 'neutral-r1');
  const stats = getStats(accountId);

  assert.equal(review.neutralReply, true);
  assert.equal(review.flagged, false);
  assert.equal(review.uncertainSkip, false);
  assert.equal(review.sentimentLabel, 'neutral_auto_reply');
  assert.equal(stats.neutral, 1);
  assert.equal(stats.unreplied, 1);
  assert.equal(stats.actionable, 1);
});

test('summarizes every account separately and totals all local review pools', () => {
  const accountA = createAccount({ name: 'summary shop A' });
  const accountB = createAccount({ name: 'summary shop B' });

  addReviewsWithStats([
    { id: 'acct-a-pending', reviewId: 'acct-a-pending', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
    { id: 'acct-a-neutral', reviewId: 'acct-a-neutral', replied: false, canReview: true, canInteract: true, replyStatus: 2, neutralReply: true },
  ], accountA.id);
  addReviewsWithStats([
    { id: 'acct-b-replied', reviewId: 'acct-b-replied', replied: true },
    { id: 'acct-b-blocked', reviewId: 'acct-b-blocked', replied: false, replyBlocked: true },
  ], accountB.id);

  const summary = getAccountsSummary();
  const accountASummary = summary.accounts.find(item => item.id === accountA.id);
  const accountBSummary = summary.accounts.find(item => item.id === accountB.id);

  assert.equal(summary.currentAccountId, getAccountsState().currentAccountId);
  assert.equal(accountASummary.stats.pending, 1);
  assert.equal(accountASummary.stats.neutral, 1);
  assert.equal(accountBSummary.stats.replied, 1);
  assert.equal(accountBSummary.stats.blocked, 1);
  assert.equal(summary.totals.total >= 4, true);
  assert.equal(summary.totals.neutral >= 1, true);
});

test('stores neutral reply templates separately from good-review templates', () => {
  const defaultNeutral = getNeutralTemplates();
  assert.match(defaultNeutral, /感谢您的评价/);

  const customNeutral = '感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们。';
  saveNeutralTemplates(customNeutral);

  assert.equal(getNeutralTemplates(), customNeutral);
});
