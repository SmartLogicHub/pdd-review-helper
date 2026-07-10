import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createE2EDryRunReport,
  recordE2EDryRunPage,
  summarizeE2EPageReviews,
  validateGoodReviewPageRequest,
} from '../services/e2e-dry-run.js';

test('records every scanned page without being limited by maxCount', () => {
  const report = createE2EDryRunReport({
    totalRows: 6,
    pageSize: 2,
    safetyMax: 100,
  });

  recordE2EDryRunPage(report, {
    pageNo: 1,
    pageCount: 3,
    requestBody: { pageNo: 1, pageSize: 2, descScore: ['4', '5'], replyStatus: '2' },
    scanned: 2,
    skipped: 1,
    replyable: 1,
    dialogOpened: true,
  });
  recordE2EDryRunPage(report, {
    pageNo: 2,
    pageCount: 3,
    requestBody: { pageNo: 2, pageSize: 2, descScore: ['4', '5'], replyStatus: '2' },
    scanned: 2,
    skipped: 0,
    replyable: 2,
    dialogOpened: true,
  });
  recordE2EDryRunPage(report, {
    pageNo: 3,
    pageCount: 3,
    requestBody: { pageNo: 3, pageSize: 2, descScore: ['4', '5'], replyStatus: '2' },
    scanned: 2,
    skipped: 2,
    replyable: 0,
    dialogOpened: false,
    lastPageReached: true,
  });

  assert.equal(report.page, 3);
  assert.equal(report.pageCount, 3);
  assert.equal(report.lastPageReached, true);
  assert.equal(report.scanned, 6);
  assert.equal(report.replyable, 3);
  assert.equal(report.dialogOpened, 2);
  assert.equal(report.pages.length, 3);
});

test('uses visible display rows for PDD full-page dry-run pagination', () => {
  const report = createE2EDryRunReport({
    totalRows: 3104,
    displayRows: 2000,
    pageSize: 10,
  });

  assert.equal(report.totalRows, 3104);
  assert.equal(report.visibleRows, 2000);
  assert.equal(report.pageCount, 200);
  assert.equal(report.safetyMax, 0);
});

test('validates PDD good-review page request sequence', () => {
  assert.deepEqual(
    validateGoodReviewPageRequest(
      { pageNo: 2, pageSize: 10, descScore: ['4', '5'], replyStatus: '2' },
      { expectedPageNo: 2, expectedPageSize: 10 }
    ),
    { ok: true, reason: '' }
  );

  assert.equal(
    validateGoodReviewPageRequest(
      { pageNo: 3, pageSize: 10, descScore: ['4', '5'], replyStatus: '2' },
      { expectedPageNo: 2, expectedPageSize: 10 }
    ).ok,
    false
  );

  assert.equal(
    validateGoodReviewPageRequest(
      { pageNo: 2, pageSize: 20, descScore: ['4'], replyStatus: '1' },
      { expectedPageNo: 2, expectedPageSize: 10 }
    ).ok,
    false
  );
});

test('records first failure with page and review identity', () => {
  const report = createE2EDryRunReport({ totalRows: 1, pageSize: 10 });

  recordE2EDryRunPage(report, {
    pageNo: 1,
    pageCount: 1,
    requestBody: { pageNo: 1, pageSize: 10, descScore: ['4', '5'], replyStatus: '2' },
    scanned: 1,
    failed: 1,
    failures: [{ reviewId: 'r1', orderSn: 'o1', stage: '打开回复弹窗', reason: '未找到入口' }],
    lastPageReached: true,
  });

  assert.equal(report.failed, 1);
  assert.deepEqual(report.firstFailure, {
    pageNo: 1,
    reviewId: 'r1',
    orderSn: 'o1',
    stage: '打开回复弹窗',
    reason: '未找到入口',
  });
});

test('selects one structural-safe dialog candidate per page without needing AI checks', () => {
  const summary = summarizeE2EPageReviews([
    { reviewId: 'already', orderNo: 'o0', stars: 5, replyCount: 1, replyList: [{ content: 'done' }], canReview: true },
    { reviewId: 'safe-1', orderNo: 'o1', stars: 5, replyCount: 0, replyList: [], replyStatus: 0, canReview: true },
    { reviewId: 'safe-2', orderNo: 'o2', stars: 4, replyCount: 0, replyList: [], replyStatus: 0, canReview: true },
  ]);

  assert.equal(summary.scanned, 3);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.skippedAlreadyReplied, 1);
  assert.equal(summary.replyable, 2);
  assert.equal(summary.candidate.reviewId, 'safe-1');
});
