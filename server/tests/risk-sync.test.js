import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFeishuRiskFields,
  buildRiskCaseKey,
  formatWecomRiskSummaryMessage,
  notifyWecomRiskSummary,
  formatWecomRiskMessage,
  syncFlaggedReview,
} from '../services/risk-sync.js';

const baseSettings = {
  feishuEnabled: true,
  feishuAppId: 'cli_xxx',
  feishuAppSecret: 'secret',
  feishuAppToken: 'app_token',
  feishuTableId: 'table_id',
  wecomEnabled: true,
  wecomWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
  feishuBotEnabled: false,
  feishuBotWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
};

const account = {
  id: 'acct-a',
  name: 'account note',
  shopName: 'HECATE官方旗舰店',
};

const review = {
  id: 'r-1',
  reviewId: 'r-1',
  orderNo: '260610-572270866073560',
  userName: '张***',
  stars: 5,
  content: '音质很好，就是漏音',
  flagReason: '当前商品存在漏音问题',
  riskWords: ['漏音'],
  time: '2026-06-20 12:00:00',
};

test('builds a stable local risk case key without exposing it as a required Feishu field', () => {
  assert.equal(buildRiskCaseKey(account, review), 'acct-a:r-1');
  assert.equal(buildRiskCaseKey(account, { orderNo: '260610-1' }), 'acct-a:260610-1');
});

test('maps flagged reviews to a compact Feishu manual-processing record', () => {
  const fields = buildFeishuRiskFields({ account, review, reason: review.flagReason });

  assert.deepEqual(Object.keys(fields), [
    '店铺名称',
    '订单编号',
    '星级',
    '评价内容',
    '标记原因',
    '处理状态',
    '发现时间',
  ]);
  assert.equal(fields['店铺名称'], 'HECATE官方旗舰店');
  assert.equal(fields['订单编号'], '260610-572270866073560');
  assert.equal(fields['处理状态'], '未处理');
  assert.equal(fields['标记原因'], '漏音');
  assert.equal(typeof fields['发现时间'], 'number');
});

test('cleans platform interaction text out of Feishu risk reasons', () => {
  const fields = buildFeishuRiskFields({
    account,
    review: {
      ...review,
      flagReason: '平台不允许回复/互动；风险词：漏音、降噪一般、耳朵疼',
      riskWords: ['漏音', '降噪一般', '耳朵疼'],
    },
    reason: '平台不允许回复/互动',
  });

  assert.equal(fields['标记原因'], '漏音、降噪一般、耳朵疼');
  assert.doesNotMatch(fields['标记原因'], /平台不允许|不可回复|互动/);
});

test('falls back to AI risk reason when the passed reason is only a platform skip reason', () => {
  const fields = buildFeishuRiskFields({
    account,
    review: {
      ...review,
      flagReason: '当前商品存在漏音问题',
      riskWords: [],
    },
    reason: '平台不允许回复/互动',
  });

  assert.equal(fields['标记原因'], '当前商品存在漏音问题');
});

test('formats WeCom notification with real shop name and key review context', () => {
  const content = formatWecomRiskMessage({
    account,
    review,
    reason: review.flagReason,
    feishuUrl: 'https://xcnbc7loouq4.feishu.cn/base/xxx',
    pendingCount: 12,
  });

  assert.match(content, /HECATE官方旗舰店/);
  assert.match(content, /260610-572270866073560/);
  assert.match(content, /漏音/);
  assert.match(content, /未处理疑似差评：12 条/);
  assert.match(content, /https:\/\/xcnbc7loouq4\.feishu\.cn\/base\/xxx/);
});

test('syncs a flagged review to Feishu without per-review WeCom notification by default', async () => {
  const createdRecords = [];
  const sentMessages = [];
  const localStatuses = [];

  const result = await syncFlaggedReview({
    account,
    review,
    reason: review.flagReason,
    settings: baseSettings,
    feishuClient: {
      createRecord: async (fields) => {
        createdRecords.push(fields);
        return { recordId: 'rec123' };
      },
      countPendingRecords: async () => 8,
    },
    wecomClient: {
      sendText: async (content, mentionedList) => {
        sentMessages.push({ content, mentionedList });
        return { ok: true };
      },
    },
    markExternalRiskSync: (targetReview, patch, accountId) => {
      localStatuses.push({ targetReview, patch, accountId });
      return { ...targetReview, ...patch };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.feishuRecordId, 'rec123');
  assert.equal(createdRecords.length, 1);
  assert.equal(createdRecords[0]['店铺名称'], 'HECATE官方旗舰店');
  assert.equal(sentMessages.length, 0);
  assert.equal(localStatuses[0].accountId, 'acct-a');
  assert.equal(localStatuses[0].patch.status, 'synced');
  assert.equal(localStatuses[0].patch.wecomNotificationDeferred, true);
});

test('sends one WeCom summary notification for a shop after risk records are written', async () => {
  const sentMessages = [];
  const content = formatWecomRiskSummaryMessage({
    account,
    newRiskCount: 3,
    failedCount: 1,
    pendingCount: 8,
    feishuUrl: 'https://xcnbc7loouq4.feishu.cn/base/xxx',
  });

  assert.match(content, /HECATE官方旗舰店/);
  assert.match(content, /本次新增疑似差评：3 条/);
  assert.match(content, /飞书写入失败：1 条/);
  assert.match(content, /未处理疑似差评：8 条/);

  const result = await notifyWecomRiskSummary({
    account,
    settings: baseSettings,
    newRiskCount: 3,
    failedCount: 1,
    feishuClient: {
      countPendingRecords: async () => 8,
    },
    wecomClient: {
      sendText: async (message, mentionedList) => {
        sentMessages.push({ message, mentionedList });
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'notified');
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0].mentionedList, ['@all']);
  assert.match(sentMessages[0].message, /本次新增疑似差评：3 条/);
});

test('formats WeCom summary as completed when Feishu has no pending records', async () => {
  const sentMessages = [];
  const content = formatWecomRiskSummaryMessage({
    account,
    newRiskCount: 2,
    failedCount: 0,
    pendingCount: 0,
    feishuUrl: 'https://xcnbc7loouq4.feishu.cn/base/xxx',
  });

  assert.match(content, /已全部处理完成|暂无未处理/);
  assert.doesNotMatch(content, /未处理疑似差评：0 条/);

  const result = await notifyWecomRiskSummary({
    account,
    settings: baseSettings,
    newRiskCount: 2,
    failedCount: 0,
    feishuClient: {
      countPendingRecords: async () => 0,
    },
    wecomClient: {
      sendText: async (message, mentionedList) => {
        sentMessages.push({ message, mentionedList });
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'notified');
  assert.equal(result.pendingCount, 0);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message, /已全部处理完成|暂无未处理/);
});

test('can summarize WeCom without uploading a new Feishu record when only notification is enabled', async () => {
  let createdRecord = false;
  const sentMessages = [];

  const result = await syncFlaggedReview({
    account,
    review,
    reason: review.flagReason,
    settings: { ...baseSettings, feishuEnabled: false, wecomEnabled: true },
    feishuClient: {
      createRecord: async () => {
        createdRecord = true;
      },
      countPendingRecords: async () => 5,
    },
    wecomClient: {
      sendText: async (content) => {
        sentMessages.push(content);
        return { ok: true };
      },
    },
    markExternalRiskSync: (_targetReview, patch) => patch,
  });

  assert.equal(createdRecord, false);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'summary-pending');
  assert.equal(sentMessages.length, 0);

  const summary = await notifyWecomRiskSummary({
    account,
    settings: { ...baseSettings, feishuEnabled: false, wecomEnabled: true },
    newRiskCount: 1,
    feishuClient: {
      countPendingRecords: async () => 5,
    },
    wecomClient: {
      sendText: async (content) => {
        sentMessages.push(content);
      },
    },
  });
  assert.equal(summary.status, 'notified');
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /未处理疑似差评：5 条/);
});

test('can send one shop summary to a Feishu bot without WeCom notification', async () => {
  const wecomMessages = [];
  const feishuBotMessages = [];

  const result = await notifyWecomRiskSummary({
    account,
    settings: {
      ...baseSettings,
      feishuEnabled: false,
      wecomEnabled: false,
      feishuBotEnabled: true,
      feishuBotWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
    },
    discoveredRiskCount: 2,
    newRiskCount: 2,
    feishuClient: {
      countPendingRecords: async () => 4,
    },
    wecomClient: {
      sendText: async (content) => {
        wecomMessages.push(content);
      },
    },
    feishuBotClient: {
      sendText: async (content) => {
        feishuBotMessages.push(content);
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'notified');
  assert.equal(result.wecomNotifiedAt, '');
  assert.match(result.feishuBotNotifiedAt, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(wecomMessages.length, 0);
  assert.equal(feishuBotMessages.length, 1);
  assert.match(feishuBotMessages[0], /HECATE官方旗舰店/);
  assert.match(feishuBotMessages[0], /未处理疑似差评：4 条/);
});

test('can upload to Feishu without notifying WeCom when only upload is enabled', async () => {
  let wecomCalled = false;

  const result = await syncFlaggedReview({
    account,
    review,
    reason: review.flagReason,
    settings: { ...baseSettings, feishuEnabled: true, wecomEnabled: false },
    feishuClient: {
      createRecord: async () => ({ recordId: 'rec456' }),
      countPendingRecords: async () => 6,
    },
    wecomClient: {
      sendText: async () => {
        wecomCalled = true;
      },
    },
    markExternalRiskSync: (_targetReview, patch) => patch,
  });

  assert.equal(wecomCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'synced');
  assert.equal(result.feishuRecordId, 'rec456');
});

test('does not sync to external systems when the real shop name is missing', async () => {
  let feishuCalled = false;
  const result = await syncFlaggedReview({
    account: { id: 'acct-b', name: '账号2' },
    review,
    reason: review.flagReason,
    settings: baseSettings,
    feishuClient: {
      createRecord: async () => {
        feishuCalled = true;
      },
    },
    markExternalRiskSync: (_targetReview, patch) => patch,
  });

  assert.equal(feishuCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'missing-shop-name');
});

test('skips duplicate external writes when the review already has a Feishu record id', async () => {
  let feishuCalled = false;
  const result = await syncFlaggedReview({
    account,
    review: { ...review, feishuRecordId: 'rec-existing', riskSyncStatus: 'synced' },
    reason: review.flagReason,
    settings: baseSettings,
    feishuClient: {
      createRecord: async () => {
        feishuCalled = true;
      },
    },
    markExternalRiskSync: (_targetReview, patch) => patch,
  });

  assert.equal(feishuCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'already-synced');
});
