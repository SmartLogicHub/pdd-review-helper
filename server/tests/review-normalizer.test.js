import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGoodReviewListRequest,
  classifyReviewStatus,
  classifyReplySubmitMessage,
  createReplyRunReport,
  filterReviewRecordsByStatus,
  isLocallyPendingReview,
  isReviewAlreadyReplied,
  mergeReviewRecords,
  mergeReviewRecordsWithStats,
  nextReplyPageAction,
  normalizeReviewStatusFilter,
  normalizePddReviewItem,
  recordReplyRunOutcome,
  reviewPageCountForRows,
  sameReviewIdentity,
  summarizeReviewRecords,
  updateReplyRunLiveState,
  shouldAutoReplyReview,
  shouldContinueReplyRun,
  visibleReviewRows,
  reviewDaysFilterLabel,
} from '../services/review-normalizer.js';

test('builds the verified PDD good-review filter request', () => {
  const request = buildGoodReviewListRequest({ pageNo: 2, pageSize: 20, nowSeconds: 1782266318 });

  assert.equal(request.pageNo, 2);
  assert.equal(request.pageSize, 20);
  assert.deepEqual(request.descScore, ['4', '5']);
  assert.equal(request.replyStatus, '2');
  assert.equal(request.orderSn, '');
  assert.equal(request.endTime, 1782266318);
  assert.ok(request.startTime < request.endTime);
});

test('builds the good-review request with the selected day range', () => {
  const nowSeconds = 1782266318;
  const thirtyDays = buildGoodReviewListRequest({ nowSeconds, reviewDays: 30 });
  const oneHundredEightyDays = buildGoodReviewListRequest({ nowSeconds, reviewDays: 180 });
  const invalidDays = buildGoodReviewListRequest({ nowSeconds, reviewDays: 365 });

  assert.equal(thirtyDays.startTime, nowSeconds - 30 * 24 * 60 * 60);
  assert.equal(oneHundredEightyDays.startTime, nowSeconds - 180 * 24 * 60 * 60);
  assert.equal(invalidDays.startTime, nowSeconds - 90 * 24 * 60 * 60);
  assert.equal(reviewDaysFilterLabel(30), '近30天');
  assert.equal(reviewDaysFilterLabel('180'), '近180天');
  assert.equal(reviewDaysFilterLabel('bad'), '近90天');
});

test('caps visible pagination at the PDD 2000-row display limit while preserving total hits', () => {
  assert.equal(visibleReviewRows({ totalRows: 3104 }), 2000);
  assert.equal(visibleReviewRows({ totalRows: 3104, displayRows: 2000 }), 2000);
  assert.equal(visibleReviewRows({ totalRows: 34, displayRows: 34 }), 34);
  assert.equal(reviewPageCountForRows({ totalRows: 3104, pageSize: 10 }), 200);
  assert.equal(reviewPageCountForRows({ totalRows: 3104, displayRows: 2000, pageSize: 20 }), 100);
  assert.equal(reviewPageCountForRows({ totalRows: 3104, pageSize: 10, maxPages: 3 }), 3);
});

test('matches the same review by review id or order number for single reply lookup', () => {
  assert.equal(
    sameReviewIdentity(
      { reviewId: 'r-1', orderNo: '260610-572270866073560' },
      { id: 'r-1' }
    ),
    true
  );
  assert.equal(
    sameReviewIdentity(
      { reviewId: 'r-2', orderNo: '260610-572270866073560' },
      { orderSn: '260610-572270866073560' }
    ),
    true
  );
  assert.equal(
    sameReviewIdentity(
      { reviewId: 'r-3', orderNo: '260610-572270866073560' },
      { reviewId: 'r-4', orderNo: '260616-417459115584051' }
    ),
    false
  );
});

test('normalizes PDD review list items into stable local review records', () => {
  const review = normalizePddReviewItem({
    reviewId: '759561528495556624',
    comment: '连接很方便，带着体感不错',
    descScore: 5,
    createTime: 1782263046,
    orderSn: '260621-510404871723463',
    goodsName: 'HECATE漫步者G3 MAX无线版电竞头戴式耳机',
    name: '1***',
    replyCount: 0,
    reply: '',
    canReview: true,
    canInteract: true,
    appendReview: { comment: '挺舒服的' },
  });

  assert.equal(review.id, '759561528495556624');
  assert.equal(review.reviewId, '759561528495556624');
  assert.equal(review.content, '连接很方便，带着体感不错');
  assert.equal(review.appendContent, '挺舒服的');
  assert.equal(review.stars, 5);
  assert.equal(review.orderNo, '260621-510404871723463');
  assert.equal(review.replied, false);
  assert.equal(review.replyCount, 0);
  assert.equal(review.canReview, true);
});

test('does not treat a missing canReview field as platform-blocked', () => {
  const review = normalizePddReviewItem({
    reviewId: 'missing-can-review',
    comment: 'good',
    descScore: 5,
    orderSn: 'order-missing-can-review',
    replyCount: 0,
    replyStatus: 2,
  });

  assert.equal(review.canReview, undefined);
  assert.equal(classifyReviewStatus(review), 'pending');
  assert.equal(shouldAutoReplyReview(review).ok, true);
});

test('only auto-replies safe 4/5 star unreplied reviews', () => {
  const base = normalizePddReviewItem({
    reviewId: 'r1',
    comment: '音质不错',
    descScore: 5,
    orderSn: 'o1',
    canReview: true,
    replyCount: 0,
  });

  assert.equal(shouldAutoReplyReview(base).ok, true);
  assert.equal(shouldAutoReplyReview({ ...base, stars: 3 }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, replyCount: 1 }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, replyList: [{ content: '感谢支持' }] }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, replyStatus: 1 }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, canReview: false }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, canReview: undefined }).ok, true);
  assert.equal(shouldAutoReplyReview({ ...base, replyBlocked: true, skipReason: '平台提示不可回复' }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, flagged: true }).ok, false);
  assert.equal(shouldAutoReplyReview({ ...base, uncertainSkip: true }).ok, false);
  assert.match(shouldAutoReplyReview({ ...base, uncertainSkip: true }).reason, /无法判断|跳过/);

  const neutralDecision = shouldAutoReplyReview({ ...base, neutralReply: true, sentimentLabel: 'neutral_auto_reply' });
  assert.equal(neutralDecision.ok, true);
  assert.equal(neutralDecision.replyMode, 'neutral');
});

test('keeps sentiment risk reason when a flagged review is also platform-blocked', () => {
  const review = normalizePddReviewItem({
    reviewId: 'flagged-blocked',
    comment: 'still risk',
    descScore: 5,
    orderSn: 'order-flagged-blocked',
    canReview: false,
    canInteract: true,
    replyCount: 0,
  });
  review.flagged = true;
  review.flagReason = 'AI risk reason';
  review.riskWords = ['risk-word'];

  const decision = shouldAutoReplyReview(review);

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'AI risk reason');
});

test('classifies platform reply-blocked toasts as skippable instead of successful', () => {
  const blocked = classifyReplySubmitMessage('用户将该评价已设置为不可评论，暂不支持回复');

  assert.equal(blocked.status, 'skip');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /不可回复/);

  const success = classifyReplySubmitMessage('回复成功');
  assert.equal(success.status, 'ok');
  assert.equal(success.ok, true);
});

test('local stats keep pending and neutral separate while counting both as actionable', () => {
  const reviews = [
    { reviewId: 'ready', stars: 5, replied: false, canReview: true, canInteract: true, replyStatus: 2 },
    { reviewId: 'neutral', stars: 5, replied: false, canReview: true, canInteract: true, replyStatus: 2, neutralReply: true },
    { reviewId: 'done', replied: true },
    { reviewId: 'risk', replied: false, flagged: true },
    { reviewId: 'uncertain', replied: false, uncertainSkip: true },
    { reviewId: 'blocked', replied: false, replyBlocked: true },
    { reviewId: 'no-can-review', replied: false, canReview: false },
  ];

  assert.equal(isLocallyPendingReview(reviews[0]), true);
  assert.equal(isLocallyPendingReview(reviews[1]), false);
  assert.equal(isLocallyPendingReview(reviews[2]), false);
  assert.equal(isLocallyPendingReview(reviews[4]), false);
  assert.equal(isLocallyPendingReview(reviews[5]), false);

  const stats = summarizeReviewRecords(reviews);
  assert.equal(stats.total, 7);
  assert.equal(stats.replied, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.neutral, 1);
  assert.equal(stats.actionable, 2);
  assert.equal(stats.unreplied, 2);
  assert.equal(stats.flagged, 1);
  assert.equal(stats.uncertain, 1);
  assert.equal(stats.blocked, 2);
});

test('classifies local reviews into one shared status vocabulary', () => {
  assert.equal(classifyReviewStatus({ replied: true }), 'replied');
  assert.equal(classifyReviewStatus({ flagged: true, replied: false }), 'flagged');
  assert.equal(classifyReviewStatus({ uncertainSkip: true, replied: false }), 'uncertain');
  assert.equal(classifyReviewStatus({ neutralReply: true, replied: false }), 'neutral');
  assert.equal(classifyReviewStatus({ replyBlocked: true, replied: false }), 'blocked');
  assert.equal(classifyReviewStatus({ canReview: false, replied: false }), 'blocked');
  assert.equal(classifyReviewStatus({ canInteract: false, replied: false }), 'blocked');
  assert.equal(classifyReviewStatus({ replied: false, canReview: true, canInteract: true, replyStatus: 2 }), 'pending');
});

test('filters local reviews by shared status for the reviews API', () => {
  const reviews = [
    { reviewId: 'ready', replied: false, canReview: true, canInteract: true, replyStatus: 2 },
    { reviewId: 'neutral', replied: false, canReview: true, canInteract: true, replyStatus: 2, neutralReply: true },
    { reviewId: 'done', replied: true },
    { reviewId: 'risk', flagged: true },
    { reviewId: 'uncertain', uncertainSkip: true },
    { reviewId: 'blocked', replyBlocked: true },
    { reviewId: 'no-can-review', canReview: false },
  ];

  assert.deepEqual(filterReviewRecordsByStatus(reviews, 'pending').map(r => r.reviewId), ['ready']);
  assert.deepEqual(filterReviewRecordsByStatus(reviews, 'neutral').map(r => r.reviewId), ['neutral']);
  assert.deepEqual(filterReviewRecordsByStatus(reviews, 'replied').map(r => r.reviewId), ['done']);
  assert.deepEqual(filterReviewRecordsByStatus(reviews, 'flagged').map(r => r.reviewId), ['risk']);
  assert.deepEqual(filterReviewRecordsByStatus(reviews, 'uncertain').map(r => r.reviewId), ['uncertain']);
  assert.deepEqual(filterReviewRecordsByStatus(reviews, 'blocked').map(r => r.reviewId), ['blocked', 'no-can-review']);
  assert.equal(filterReviewRecordsByStatus(reviews, 'all').length, 7);
});

test('normalizes new and legacy review list status filters', () => {
  assert.equal(normalizeReviewStatusFilter({ status: 'pending' }), 'pending');
  assert.equal(normalizeReviewStatusFilter({ status: 'neutral' }), 'neutral');
  assert.equal(normalizeReviewStatusFilter({ status: 'blocked' }), 'blocked');
  assert.equal(normalizeReviewStatusFilter({ status: 'uncertain' }), 'uncertain');
  assert.equal(normalizeReviewStatusFilter({ replied: 'true' }), 'replied');
  assert.equal(normalizeReviewStatusFilter({ replied: 'false' }), 'pending');
  assert.equal(normalizeReviewStatusFilter({ flagged: 'true' }), 'flagged');
  assert.equal(normalizeReviewStatusFilter({ status: 'unknown' }), 'all');
});

test('treats mixed replied reviews from unreplied filter as already replied', () => {
  const mixed = normalizePddReviewItem({
    reviewId: 'r-mixed',
    comment: '很满意',
    descScore: 5,
    orderSn: 'o-mixed',
    canReview: true,
    replyCount: 1,
    replyList: [{ content: '感谢您的支持' }],
    replyStatus: 0,
  });

  assert.equal(isReviewAlreadyReplied(mixed), true);
  const decision = shouldAutoReplyReview(mixed);
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /已回复/);
});

test('maxCount counts successful replyable targets, not skipped rows', () => {
  const report = createReplyRunReport({ target: 2, totalRows: 4, limit: 2, dryRun: true });

  recordReplyRunOutcome(report, {
    review: { reviewId: 'skip-1', orderNo: 'order-skip', replyCount: 1, replyList: [{ content: 'done' }] },
    status: 'skip',
    reason: '评价已回复',
  });
  assert.equal(shouldContinueReplyRun(report, 2), true);
  assert.equal(report.remainingTargets, 2);
  assert.equal(report.total, 3);

  recordReplyRunOutcome(report, { review: { reviewId: 'ok-1', orderNo: 'order-1' }, status: 'dry-run', reply: '谢谢' });
  assert.equal(shouldContinueReplyRun(report, 2), true);
  assert.equal(report.remainingTargets, 1);
  assert.equal(report.total, 3);

  recordReplyRunOutcome(report, { review: { reviewId: 'ok-2', orderNo: 'order-2' }, status: 'dry-run', reply: '感谢支持' });
  assert.equal(shouldContinueReplyRun(report, 2), false);
  assert.equal(report.scanned, 3);
  assert.equal(report.success, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.skippedAlreadyReplied, 1);
});

test('reply run report separates positive, neutral and skipped categories', () => {
  const report = createReplyRunReport({ target: 4, totalRows: 4, dryRun: true });

  recordReplyRunOutcome(report, { review: { reviewId: 'positive-1' }, status: 'dry-run', reply: 'thanks' });
  recordReplyRunOutcome(report, { review: { reviewId: 'neutral-1', neutralReply: true }, status: 'dry-run', reply: 'thanks' });
  recordReplyRunOutcome(report, { review: { reviewId: 'risk-1', flagged: true }, status: 'skip', reason: '疑似差评' });
  recordReplyRunOutcome(report, { review: { reviewId: 'uncertain-1', uncertainSkip: true }, status: 'skip', reason: '无法判断' });
  recordReplyRunOutcome(report, { review: { reviewId: 'blocked-1', replyBlocked: true }, status: 'skip', reason: '不可回复' });

  assert.equal(report.positiveReplies, 1);
  assert.equal(report.neutralReplies, 1);
  assert.equal(report.skippedFlagged, 1);
  assert.equal(report.skippedUncertain, 1);
  assert.equal(report.skippedBlocked, 1);
});

test('live progress uses the current unreplied pool instead of the initial hit count', () => {
  const report = createReplyRunReport({ target: 58, totalRows: 58 });

  for (let i = 0; i < 25; i++) {
    recordReplyRunOutcome(report, { review: { reviewId: `ok-${i}` }, status: 'ok', reply: 'thanks' });
  }
  for (let i = 0; i < 9; i++) {
    recordReplyRunOutcome(report, { review: { reviewId: `skip-${i}` }, status: 'skip', reason: '疑似差评' });
  }

  updateReplyRunLiveState(report, { totalRows: 34, pageNo: 1, pageCount: 4 });

  assert.equal(report.initialTotalRows, 58);
  assert.equal(report.liveTotalRows, 34);
  assert.equal(report.remainingTargets, 25);
  assert.equal(report.total, 59);

  updateReplyRunLiveState(report, { totalRows: 9, pageNo: 1, pageCount: 1 });

  assert.equal(report.remainingTargets, 0);
  assert.equal(report.total, 34);
});

test('reply run report keeps total hits and visible rows separate', () => {
  const report = createReplyRunReport({ target: 3104, totalRows: 3104, displayRows: 2000 });

  assert.equal(report.initialTotalRows, 3104);
  assert.equal(report.initialVisibleRows, 2000);
  assert.equal(report.visibleRows, 2000);

  recordReplyRunOutcome(report, { review: { reviewId: 'ok-1' }, status: 'ok', reply: 'thanks' });
  updateReplyRunLiveState(report, { totalRows: 3103, displayRows: 2000, pageNo: 1, pageCount: 200 });

  assert.equal(report.liveTotalRows, 3103);
  assert.equal(report.visibleRows, 2000);
  assert.equal(report.pageCount, 200);
  assert.equal(report.remainingTargets, 3103);
});

test('live submit refreshes the first page after successful replies because unreplied list shrinks', () => {
  assert.equal(
    nextReplyPageAction({ dryRun: false, pageHadSuccess: true, pageNo: 2, pageCount: 8 }),
    'refresh-first'
  );
  assert.equal(
    nextReplyPageAction({ dryRun: false, pageHadSuccess: true, pageNo: 4, pageCount: 4 }),
    'refresh-first'
  );
  assert.equal(
    nextReplyPageAction({ dryRun: false, pageHadSuccess: false, pageNo: 2, pageCount: 4 }),
    'next-page'
  );
  assert.equal(
    nextReplyPageAction({ dryRun: false, pageHadSuccess: false, pageNo: 4, pageCount: 4 }),
    'done'
  );
  assert.equal(
    nextReplyPageAction({ dryRun: true, pageHadSuccess: true, pageNo: 2, pageCount: 8 }),
    'next-page'
  );
});

test('sequential page traversal can test real replies across different pages', () => {
  assert.equal(
    nextReplyPageAction({
      dryRun: false,
      pageHadSuccess: true,
      pageNo: 2,
      pageCount: 8,
      refreshAfterSuccess: false,
    }),
    'next-page'
  );
  assert.equal(
    nextReplyPageAction({
      dryRun: false,
      pageHadSuccess: true,
      pageNo: 8,
      pageCount: 8,
      refreshAfterSuccess: false,
    }),
    'done'
  );
});

test('merges reviews by reviewId and preserves local replied state', () => {
  const existing = [
    { id: 'r1', reviewId: 'r1', content: 'old', replied: true, repliedAt: '2026-06-24T00:00:00.000Z' },
  ];
  const incoming = [
    { id: 'r1', reviewId: 'r1', content: 'new', replied: false },
    { id: 'r2', reviewId: 'r2', content: 'another', replied: false },
  ];

  const merged = mergeReviewRecords(existing, incoming);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].content, 'new');
  assert.equal(merged[0].replied, true);
  assert.equal(merged[0].repliedAt, '2026-06-24T00:00:00.000Z');
  assert.equal(merged[1].id, 'r2');
});

test('clears stale local replied state when a review reappears as explicitly unreplied', () => {
  const merged = mergeReviewRecords(
    [
      { id: 'r1', reviewId: 'r1', content: 'old', replied: true, repliedAt: '2026-06-24T00:00:00.000Z', replyCount: 1 },
    ],
    [
      { id: 'r1', reviewId: 'r1', content: 'still unreplied', replied: false, replyStatus: 2, replyCount: 0, replyList: [], reply: '' },
    ]
  );

  assert.equal(merged[0].replied, false);
  assert.equal(merged[0].repliedAt, undefined);
  assert.equal(merged[0].replyCount, 0);
});

test('clears stale local replyBlocked state when the platform explicitly allows replies again', () => {
  const merged = mergeReviewRecords(
    [
      {
        id: 'r1',
        reviewId: 'r1',
        content: 'old',
        replied: false,
        replyBlocked: true,
        canReview: false,
        skipReason: '平台不允许回复/互动',
      },
    ],
    [
      {
        id: 'r1',
        reviewId: 'r1',
        content: 'updated',
        replied: false,
        replyStatus: 2,
        replyCount: 0,
        replyList: [],
        reply: '',
        canReview: true,
        canInteract: true,
      },
    ]
  );

  assert.equal(merged[0].replyBlocked, false);
  assert.equal(merged[0].canReview, true);
  assert.equal(merged[0].skipReason, '');
  assert.equal(classifyReviewStatus(merged[0]), 'pending');
});

test('reports fetched, new, total and unreplied counts when merging fetched reviews', () => {
  const result = mergeReviewRecordsWithStats(
    [
      { id: 'r1', reviewId: 'r1', content: 'old', replied: true },
      { id: 'r2', reviewId: 'r2', content: 'waiting', replied: false },
    ],
    [
      { id: 'r1', reviewId: 'r1', content: 'updated', replied: false },
      { id: 'r3', reviewId: 'r3', content: 'new one', replied: false },
    ]
  );

  assert.equal(result.fetchedCount, 2);
  assert.equal(result.newCount, 1);
  assert.equal(result.total, 3);
  assert.equal(result.unreplied, 2);
  assert.equal(result.reviews.find(review => review.reviewId === 'r1').replied, true);
});
