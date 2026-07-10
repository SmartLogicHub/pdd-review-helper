import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing } from '../services/playwright.js';

test('builds stable row-scoped hints for locating the reply action', () => {
  const hints = __testing.buildReviewActionHints({
    orderNo: '260619-252539082263354',
    reviewId: '759282196574554128',
    content: '该用户觉得商品较好，后续还会继续购买。',
  });

  assert.deepEqual(hints, [
    '260619-252539082263354',
    '759282196574554128',
    '该用户觉得商品较好，后续还',
  ]);
});

test('counts only visible non-feedback textarea nodes as reply inputs', () => {
  const summary = __testing.describeTextareaSnapshots([
    { width: 0, height: 0, display: 'none', visibility: 'visible', opacity: '1', withinFeedback: false },
    { width: 260, height: 80, display: 'block', visibility: 'hidden', opacity: '1', withinFeedback: false },
    { width: 260, height: 80, display: 'block', visibility: 'visible', opacity: '1', withinFeedback: true },
    { width: 320, height: 96, display: 'block', visibility: 'visible', opacity: '1', withinFeedback: false },
  ]);

  assert.equal(summary.total, 4);
  assert.equal(summary.hidden, 2);
  assert.equal(summary.feedback, 1);
  assert.equal(summary.visibleReply, 1);
});

test('prefers an enabled target page number before falling back to next arrow', () => {
  const pick = __testing.pickPaginationControlSnapshot([
    { index: 0, text: '4', className: 'PGT_number PGT_active' },
    { index: 1, text: '5', className: 'PGT_number' },
    { index: 2, text: '>', className: 'PGT_next' },
  ], 5);

  assert.deepEqual(pick, { index: 1, strategy: 'page-number' });
});

test('skips disabled pagination controls when choosing a fallback next arrow', () => {
  const pick = __testing.pickPaginationControlSnapshot([
    { index: 0, text: '5', className: 'PGT_number PGT_disabled' },
    { index: 1, text: '>', className: 'PGT_next_disabled' },
    { index: 2, text: '›', className: 'PGT_next' },
  ], 5);

  assert.deepEqual(pick, { index: 2, strategy: 'next-arrow' });
});

test('sanitizes reply-related network snapshots without leaking request bodies', () => {
  const event = __testing.sanitizeNetworkSnapshot({
    url: 'https://mms.pinduoduo.com/saturn/reviews/list?token=secret',
    method: 'POST',
    status: 200,
    postData: JSON.stringify({
      pageNo: 2,
      pageSize: 10,
      replyStatus: '2',
      descScore: ['4', '5'],
      antiContent: 'secret-value',
    }),
  });

  assert.deepEqual(event, {
    method: 'POST',
    status: 200,
    host: 'mms.pinduoduo.com',
    path: '/saturn/reviews/list',
    bodyKeys: ['antiContent', 'descScore', 'pageNo', 'pageSize', 'replyStatus'],
    bodySample: {
      descScore: ['4', '5'],
      pageNo: 2,
      pageSize: 10,
      replyStatus: '2',
    },
  });
});

test('matches a good-review order search response only for the target order number', () => {
  const matcher = __testing.requestMatchesGoodReviewOrderSearch('260610-572270866073560');
  const response = (orderSn) => ({
    url: () => 'https://mms.pinduoduo.com/saturn/reviews/list',
    status: () => 200,
    request: () => ({
      method: () => 'POST',
      postData: () => JSON.stringify({
        pageNo: 1,
        pageSize: 10,
        replyStatus: '2',
        descScore: ['4', '5'],
        orderSn,
      }),
    }),
  });

  assert.equal(matcher(response('260610-572270866073560')), true);
  assert.equal(matcher(response('260616-417459115584051')), false);
});

test('names the popup cleanup stage after a review-list request returns', () => {
  assert.equal(
    __testing.reviewListPopupCleanupStage('按订单编号搜索评价'),
    '按订单编号搜索评价后弹窗检查'
  );
});

test('uses the verified PDD order number input xpath as the primary selector', () => {
  assert.equal(
    __testing.ORDER_SEARCH_INPUT_XPATH,
    '/html/body/div[1]/div/div/div/main/div[3]/div/div/div/div/div[3]/div[2]/div/form/div/div/div[1]/div/div[2]/div/div/div/div/div/input'
  );
  assert.equal(
    __testing.orderSearchInputLocator(),
    'xpath=/html/body/div[1]/div/div/div/main/div[3]/div/div/div/div/div[3]/div[2]/div/form/div/div/div[1]/div/div[2]/div/div/div/div/div/input'
  );
});

test('recognizes reply action text even when PDD inserts spaces around the slash', () => {
  assert.equal(__testing.isReplyActionText('回复/互动'), true);
  assert.equal(__testing.isReplyActionText('回复 / 互动'), true);
  assert.equal(__testing.isReplyActionText('回复\n/\n互动'), true);
  assert.equal(__testing.isReplyActionText('查看订单 举报 回复/互动'), false);
});
