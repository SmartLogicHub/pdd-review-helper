import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAutomationManager } from '../services/automation.js';
import { summarizeFailureReasons } from '../services/review-normalizer.js';

test('failure reasons are grouped with numbers normalized, most frequent first', () => {
  const records = [
    { status: 'fail', reason: '翻到第 3 页失败：等待评价列表接口超时' },
    { status: 'fail', reason: '翻到第 7 页失败：等待评价列表接口超时' },
    { status: 'fail', reason: '未找到可填写的回复输入框（textarea 总数 3，可见回复框 0）' },
    { status: 'fail', reason: '翻到第 12 页失败：等待评价列表接口超时' },
    { status: 'ok', reason: '提交成功' },
    { status: 'skip', reason: '评价已回复' },
  ];

  const summary = summarizeFailureReasons(records);

  assert.equal(summary.length, 2);
  assert.equal(summary[0].count, 3);
  assert.equal(summary[0].reason, '翻到第 N 页失败：等待评价列表接口超时');
  assert.equal(summary[0].example, '翻到第 3 页失败：等待评价列表接口超时');
  assert.equal(summary[1].count, 1);
});

test('a finished run carries grouped failure reasons and its full report is persisted', async () => {
  const written = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: '漫步者极音专卖店' }),
    writeRunReport: report => written.push(report),
    runner: async () => ({
      total: 3,
      success: 1,
      failed: 2,
      skipped: 0,
      records: [
        { reviewId: 'r1', status: 'ok', reason: '提交成功' },
        { reviewId: 'r2', status: 'fail', reason: '回复弹窗未出现' },
        { reviewId: 'r3', status: 'fail', reason: '回复弹窗未出现' },
      ],
    }),
  });

  const job = manager.startReplyGoodReviews();
  const finished = await manager.waitForJob(job.id);

  assert.deepEqual(finished.result.failureReasons, [{ reason: '回复弹窗未出现', count: 2, example: '回复弹窗未出现' }]);
  assert.equal(written.length, 1);
  assert.equal(written[0].status, 'done');
  assert.equal(written[0].result.records.length, 3);
});

test('all-account runs aggregate failure reasons across accounts', async () => {
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    listAccounts: () => ({ accounts: [{ id: 'a', name: 'A', shopName: 'A店' }, { id: 'b', name: 'B', shopName: 'B店' }] }),
    runner: async (_genReply, _onProgress, options) => ({
      total: 1,
      success: 0,
      failed: 1,
      skipped: 0,
      records: [{ reviewId: options.accountId, status: 'fail', reason: '提交后未确认成功' }],
    }),
  });

  const job = manager.startReplyAllAccounts();
  const finished = await manager.waitForJob(job.id);

  assert.deepEqual(finished.result.failureReasons, [{ reason: '提交后未确认成功', count: 2, example: '提交后未确认成功' }]);
});

test('failed runs are persisted too, so crashes leave a trace', async () => {
  const written = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1' }),
    writeRunReport: report => written.push(report),
    runner: async () => { throw new Error('浏览器启动失败'); },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.equal(written.length, 1);
  assert.equal(written[0].status, 'error');
  assert.equal(written[0].error, '浏览器启动失败');
});
