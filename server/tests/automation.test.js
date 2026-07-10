import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAutomationManager } from '../services/automation.js';

test('refuses to start unattended auto reply when the setting is disabled', async () => {
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: false }),
    runner: async () => ({ total: 0, success: 0, failed: 0, skipped: 0 }),
  });

  assert.throws(
    () => manager.startReplyGoodReviews(),
    /请先在系统设置中开启自动回复/
  );
});

test('allows dry-run checks even when unattended auto reply is disabled', async () => {
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: false }),
    runner: async () => ({ total: 1, success: 1, failed: 0, skipped: 0, dryRun: true }),
  });

  const job = manager.startReplyGoodReviews({ maxCount: 1, dryRun: true });
  await manager.waitForJob(job.id);

  assert.equal(manager.getJob(job.id).status, 'done');
});

test('streams waiting events when verification or login needs user action', async () => {
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    runner: async (_genReply, onProgress) => {
      onProgress({ status: 'waiting', stage: '进入评价管理', reason: '检测到拼多多验证/风控提示' });
      return { total: 0, success: 0, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyGoodReviews({ dryRun: true });
  const events = [];
  const unsubscribe = manager.subscribe(job.id, event => events.push(event));
  await manager.waitForJob(job.id);
  unsubscribe();

  assert.equal(events.some(event => event.type === 'progress' && event.status === 'waiting'), true);
});

test('starts full-page e2e dry-run without requiring unattended auto reply', async () => {
  let seenOptions;
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: false }),
    e2eRunner: async (_genReply, onProgress, options) => {
      seenOptions = options;
      onProgress({ status: 'e2e-page-done', page: 1, pageCount: 1 });
      return { mode: 'e2e-dry-run', dryRun: true, page: 1, pageCount: 1, lastPageReached: true };
    },
  });

  const job = manager.startE2EDryRun({ safetyMax: 100 });
  const events = [];
  const unsubscribe = manager.subscribe(job.id, event => events.push(event));
  await manager.waitForJob(job.id);
  unsubscribe();

  assert.equal(seenOptions.dryRun, true);
  assert.equal(manager.getJob(job.id).status, 'done');
  assert.equal(events.some(event => event.type === 'progress' && event.status === 'e2e-page-done'), true);
});

test('streams progress and done events for an auto reply job', async () => {
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    runner: async (_genReply, onProgress) => {
      onProgress({ current: 1, total: 1, status: 'ok' });
      return { total: 1, success: 1, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyGoodReviews({ maxCount: 1 });
  const events = [];
  const unsubscribe = manager.subscribe(job.id, event => events.push(event));
  await manager.waitForJob(job.id);
  unsubscribe();

  assert.equal(events[0].type, 'progress');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(manager.getJob(job.id).status, 'done');
});

test('passes stop requests into the runner', async () => {
  let seenStopped = false;
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    runner: async (_genReply, _onProgress, options) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      seenStopped = options.stopSignal.isStopped();
      return { total: 1, success: 0, failed: 0, skipped: 0, stopped: seenStopped };
    },
  });

  const job = manager.startReplyGoodReviews();
  manager.stopJob(job.id);
  await manager.waitForJob(job.id);

  assert.equal(seenStopped, true);
  assert.equal(manager.getJob(job.id).result.stopped, true);
});

test('exposes an active automation job after the browser UI reconnects', async () => {
  let finish;
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    runner: async () => new Promise(resolve => {
      finish = () => resolve({ total: 1, success: 0, failed: 0, skipped: 0 });
    }),
  });

  const job = manager.startReplyGoodReviews();

  assert.equal(manager.getActiveJob().id, job.id);
  assert.equal(manager.getActiveJob().status, 'running');

  finish();
  await manager.waitForJob(job.id);

  assert.equal(manager.getActiveJob(), null);
});

test('refuses to start a second automation job while one is active', async () => {
  let finish;
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    runner: async () => new Promise(resolve => {
      finish = () => resolve({ total: 1, success: 0, failed: 0, skipped: 0 });
    }),
  });

  const job = manager.startReplyGoodReviews();

  assert.throws(
    () => manager.startE2EDryRun({ safetyMax: 100 }),
    /已有自动化任务/
  );

  finish();
  await manager.waitForJob(job.id);
});

test('passes reply success callback into the runner so local stats can update', async () => {
  const seen = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    markReplySuccess: (review) => seen.push(review.reviewId),
    runner: async (_genReply, _onProgress, options) => {
      options.onReplySuccess({ reviewId: 'r-success' });
      return { total: 1, success: 1, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(seen, ['r-success']);
});

test('passes reply blocked callback into the runner so local pending stats can update', async () => {
  const seen = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    markReplyBlocked: (review, reason) => seen.push([review.reviewId, reason]),
    runner: async (_genReply, _onProgress, options) => {
      options.onReplyBlocked({ reviewId: 'r-blocked' }, '平台提示不可回复');
      return { total: 1, success: 0, failed: 0, skipped: 1 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(seen, [['r-blocked', '平台提示不可回复']]);
});

test('passes skipped risk and uncertain callbacks into the runner so local status can update', async () => {
  const flagged = [];
  const uncertain = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    markReviewFlagged: (review, reason) => flagged.push([review.reviewId, reason]),
    markReviewUncertain: (review, reason) => uncertain.push([review.reviewId, reason]),
    runner: async (_genReply, _onProgress, options) => {
      options.onReviewFlagged({ reviewId: 'r-risk' }, '当前商品存在负面体验');
      options.onReviewUncertain({ reviewId: 'r-uncertain' }, '评价信息不足，跳过自动回复');
      return { total: 2, success: 0, failed: 0, skipped: 2 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(flagged, [['r-risk', '当前商品存在负面体验']]);
  assert.deepEqual(uncertain, [['r-uncertain', '评价信息不足，跳过自动回复']]);
});

test('passes neutral callback into the runner so conservative reply targets can update', async () => {
  const neutral = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true }),
    markReviewNeutral: (review, reason) => neutral.push([review.reviewId, reason]),
    runner: async (_genReply, _onProgress, options) => {
      options.onReviewNeutral({ reviewId: 'r-neutral' }, '中性评价，使用保守回复');
      return { total: 1, success: 1, failed: 0, skipped: 0, neutralReplies: 1 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(neutral, [['r-neutral', '中性评价，使用保守回复']]);
});

test('passes current account and review day range into auto reply jobs', async () => {
  let seenOptions;
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 180 }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '店铺A' }),
    runner: async (_genReply, _onProgress, options) => {
      seenOptions = options;
      return { total: 1, success: 1, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyGoodReviews({ maxCount: 1 });
  await manager.waitForJob(job.id);

  assert.equal(seenOptions.accountId, 'acct-a');
  assert.equal(seenOptions.accountName, '店铺A');
  assert.equal(seenOptions.reviewDays, 180);
});

test('runs all accounts sequentially with isolated callbacks', async () => {
  const order = [];
  const success = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    listAccounts: () => ({
      currentAccountId: 'acct-a',
      accounts: [
        { id: 'acct-a', name: '店铺A' },
        { id: 'acct-b', name: '店铺B' },
      ],
    }),
    markReplySuccess: (review, accountId) => success.push([accountId, review.reviewId]),
    runner: async (_genReply, onProgress, options) => {
      order.push(options.accountId);
      options.onReplySuccess({ reviewId: `${options.accountId}-review` });
      onProgress({ status: 'report', success: 1, total: 1 });
      return { total: 1, success: 1, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyAllAccounts({ maxCount: 10 });
  const events = [];
  const unsubscribe = manager.subscribe(job.id, event => events.push(event));
  await manager.waitForJob(job.id);
  unsubscribe();

  assert.deepEqual(order, ['acct-a', 'acct-b']);
  assert.deepEqual(success, [
    ['acct-a', 'acct-a-review'],
    ['acct-b', 'acct-b-review'],
  ]);
  assert.equal(events.some(event => event.type === 'progress' && event.accountId === 'acct-b'), true);
  assert.equal(manager.getJob(job.id).result.success, 2);
});

test('detects missing real shop names before running all accounts', async () => {
  const detected = [];
  const seenOptions = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    listAccounts: () => ({
      currentAccountId: 'acct-a',
      accounts: [
        { id: 'acct-a', name: '账号1' },
        { id: 'acct-b', name: '账号2', shopName: '已识别店铺' },
      ],
    }),
    detectShopName: async (account) => {
      detected.push(account.id);
      return { ...account, shopName: `${account.id}-真实店铺` };
    },
    runner: async (_genReply, _onProgress, options) => {
      seenOptions.push({
        accountId: options.accountId,
        accountName: options.accountName,
        shopName: options.shopName,
      });
      return { total: 1, success: 1, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyAllAccounts({ maxCount: 10 });
  await manager.waitForJob(job.id);

  assert.deepEqual(detected, ['acct-a']);
  assert.deepEqual(seenOptions, [
    { accountId: 'acct-a', accountName: '账号1', shopName: 'acct-a-真实店铺' },
    { accountId: 'acct-b', accountName: '账号2', shopName: '已识别店铺' },
  ]);
});

test('passes flagged reviews through external risk sync with the detected shop name', async () => {
  const synced = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30, feishuEnabled: true }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1' }),
    detectShopName: async (account) => ({ ...account, shopName: 'HECATE官方旗舰店' }),
    markReviewFlagged: (review) => ({ ...review, flagged: true }),
    syncRiskReview: async ({ account, review, reason }) => {
      synced.push({ shopName: account.shopName, reviewId: review.reviewId, reason });
      return { ok: true, status: 'synced' };
    },
    runner: async (_genReply, _onProgress, options) => {
      await options.onReviewFlagged({ reviewId: 'risk-1', flagged: true }, '当前商品存在漏音问题');
      return { total: 1, success: 0, failed: 0, skipped: 1 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(synced, [
    { shopName: 'HECATE官方旗舰店', reviewId: 'risk-1', reason: '当前商品存在漏音问题' },
  ]);
});

test('does not overwrite flagged risk reason with platform block reason', async () => {
  const flagged = [];
  const synced = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30, feishuEnabled: true }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: 'HECATE官方旗舰店' }),
    markReviewFlagged: (review, reason) => {
      flagged.push({ reviewId: review.reviewId, reason });
      return { ...review, flagged: true, flagReason: reason };
    },
    syncRiskReview: async ({ review, reason }) => {
      synced.push({ reviewId: review.reviewId, reason, flagReason: review.flagReason, riskWords: review.riskWords });
      return { ok: true, status: 'synced' };
    },
    runner: async (_genReply, _onProgress, options) => {
      await options.onReviewFlagged(
        {
          reviewId: 'risk-blocked',
          flagged: true,
          flagReason: '当前商品存在漏音问题',
          riskWords: ['漏音'],
          canReview: false,
        },
        '平台不允许回复/互动'
      );
      return { total: 1, success: 0, failed: 0, skipped: 1 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(flagged, [
    { reviewId: 'risk-blocked', reason: '当前商品存在漏音问题' },
  ]);
  assert.deepEqual(synced, [
    {
      reviewId: 'risk-blocked',
      reason: '当前商品存在漏音问题',
      flagReason: '当前商品存在漏音问题',
      riskWords: ['漏音'],
    },
  ]);
});

test('sends one shop-level WeCom summary after multiple flagged reviews in one account', async () => {
  const synced = [];
  const summaries = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30, feishuEnabled: true, wecomEnabled: true }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: 'HECATE官方旗舰店' }),
    markReviewFlagged: (review) => ({ ...review, flagged: true }),
    syncRiskReview: async ({ account, review, reason }) => {
      synced.push({ shopName: account.shopName, reviewId: review.reviewId, reason });
      return { ok: true, status: 'synced', feishuRecordId: `rec-${review.reviewId}` };
    },
    notifyRiskSummary: async ({ account, newRiskCount, failedCount }) => {
      summaries.push({ shopName: account.shopName, newRiskCount, failedCount });
      return { ok: true, status: 'notified' };
    },
    runner: async (_genReply, _onProgress, options) => {
      await options.onReviewFlagged({ reviewId: 'risk-1', flagged: true, riskWords: ['漏音'] }, '当前商品存在漏音问题');
      await options.onReviewFlagged({ reviewId: 'risk-2', flagged: true, riskWords: ['耳朵疼'] }, '当前商品存在耳朵疼问题');
      await options.onReviewFlagged({ reviewId: 'risk-3', flagged: true, riskWords: ['降噪一般'] }, '当前商品存在降噪一般问题');
      return { total: 3, success: 0, failed: 0, skipped: 3 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.equal(synced.length, 3);
  assert.deepEqual(summaries, [
    { shopName: 'HECATE官方旗舰店', newRiskCount: 3, failedCount: 0 },
  ]);
});

test('still sends a WeCom summary for already-synced flagged reviews so Feishu pending count is reported', async () => {
  const summaries = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30, feishuEnabled: true, wecomEnabled: true }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: 'HECATE官方旗舰店' }),
    markReviewFlagged: (review) => ({ ...review, flagged: true }),
    syncRiskReview: async () => ({ ok: true, status: 'already-synced', feishuRecordId: 'rec-existing' }),
    notifyRiskSummary: async ({ newRiskCount, discoveredRiskCount }) => {
      summaries.push({ newRiskCount, discoveredRiskCount });
      return { ok: true, status: 'notified', pendingCount: 0 };
    },
    runner: async (_genReply, _onProgress, options) => {
      await options.onReviewFlagged({ reviewId: 'risk-old', flagged: true, feishuRecordId: 'rec-existing' }, '当前商品存在负面体验');
      return { total: 1, success: 0, failed: 0, skipped: 1 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(summaries, [{ newRiskCount: 0, discoveredRiskCount: 1 }]);
});

test('sends one WeCom summary per shop when processing all accounts', async () => {
  const summaries = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30, feishuEnabled: true, wecomEnabled: true }),
    listAccounts: () => ({
      currentAccountId: 'acct-a',
      accounts: [
        { id: 'acct-a', name: '账号1', shopName: '店铺A' },
        { id: 'acct-b', name: '账号2', shopName: '店铺B' },
        { id: 'acct-c', name: '账号3', shopName: '店铺C' },
      ],
    }),
    markReviewFlagged: (review) => ({ ...review, flagged: true }),
    syncRiskReview: async ({ review }) => ({ ok: true, status: 'synced', feishuRecordId: `rec-${review.reviewId}` }),
    notifyRiskSummary: async ({ account, newRiskCount }) => {
      summaries.push({ shopName: account.shopName, newRiskCount });
      return { ok: true, status: 'notified' };
    },
    runner: async (_genReply, _onProgress, options) => {
      await options.onReviewFlagged({ reviewId: `${options.accountId}-risk`, flagged: true }, '当前商品存在负面体验');
      return { total: 1, success: 0, failed: 0, skipped: 1 };
    },
  });

  const job = manager.startReplyAllAccounts({ maxCount: 10 });
  await manager.waitForJob(job.id);

  assert.deepEqual(summaries, [
    { shopName: '店铺A', newRiskCount: 1 },
    { shopName: '店铺B', newRiskCount: 1 },
    { shopName: '店铺C', newRiskCount: 1 },
  ]);
});

test('sends a shop summary when only Feishu bot notification is enabled', async () => {
  const summaries = [];
  const manager = createAutomationManager({
    getSettings: () => ({
      autoReplyEnabled: true,
      reviewDays: 30,
      feishuEnabled: false,
      wecomEnabled: false,
      feishuBotEnabled: true,
    }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: 'HECATE官方旗舰店' }),
    markReviewFlagged: (review) => ({ ...review, flagged: true }),
    syncRiskReview: async ({ review }) => ({ ok: true, status: 'summary-pending', riskCaseKey: `acct-a:${review.reviewId}` }),
    notifyRiskSummary: async ({ account, discoveredRiskCount, newRiskCount }) => {
      summaries.push({ shopName: account.shopName, discoveredRiskCount, newRiskCount });
      return { ok: true, status: 'notified', pendingCount: 1 };
    },
    runner: async (_genReply, _onProgress, options) => {
      await options.onReviewFlagged({ reviewId: 'risk-feishu-bot', flagged: true, riskWords: ['漏音'] }, '当前商品存在漏音问题');
      return { total: 1, success: 0, failed: 0, skipped: 1 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(summaries, [
    { shopName: 'HECATE官方旗舰店', discoveredRiskCount: 1, newRiskCount: 1 },
  ]);
});

test('continues to the next account when one account fails safety checks', async () => {
  const order = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30 }),
    listAccounts: () => ({
      currentAccountId: 'acct-a',
      accounts: [
        { id: 'acct-a', name: '店铺A' },
        { id: 'acct-b', name: '店铺B' },
      ],
    }),
    runner: async (_genReply, _onProgress, options) => {
      order.push(options.accountId);
      if (options.accountId === 'acct-a') {
        throw new Error('本次筛选命中 3104 条，超过安全上限 100 条，已停止');
      }
      return { total: 1, success: 1, failed: 0, skipped: 0 };
    },
  });

  const job = manager.startReplyAllAccounts({ maxCount: 10 });
  await manager.waitForJob(job.id);
  const result = manager.getJob(job.id).result;

  assert.deepEqual(order, ['acct-a', 'acct-b']);
  assert.equal(manager.getJob(job.id).status, 'done');
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.accounts[0].status, 'error');
  assert.equal(result.accounts[1].accountId, 'acct-b');
});
