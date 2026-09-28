import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAutomationManager } from '../services/automation.js';
import {
  createFeishuClient,
  formatWecomRiskSummaryMessage,
  syncFlaggedReview,
} from '../services/risk-sync.js';

const settings = {
  feishuEnabled: true,
  feishuAppId: 'cli_test',
  feishuAppSecret: 'secret',
  feishuAppToken: 'app_token',
  feishuTableId: 'tbl_risk',
};

const RISK_FIELDS = ['店铺名称', '订单编号', '星级', '评价内容', '标记原因', '处理状态', '发现时间'];
// 真实踩过的坑：链接复制成了同一个多维表格里的「评论判断结果」表
const WRONG_TABLE_FIELDS = ['订单号', '评论内容', 'AI判断评论属性', '商品名称', 'AI判断商品属性', '店铺', '创建时间'];

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// 每个测试用自己的 fetch，token 和表结构缓存按 fetch 隔离，互不影响
function mockFeishu({ fields = RISK_FIELDS, tableError = null, createResponse = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method });
    if (url.includes('tenant_access_token')) {
      return reply(200, { code: 0, msg: 'ok', tenant_access_token: 't-123', expire: 7200 });
    }
    if (tableError) return reply(200, tableError);
    if (url.includes('/fields')) {
      return reply(200, { code: 0, data: { has_more: false, items: fields.map(field_name => ({ field_name })) } });
    }
    if (url.includes('/records') && method === 'POST') {
      return createResponse ? reply(...createResponse) : reply(200, { code: 0, data: { record: { record_id: 'rec_1' } } });
    }
    if (url.includes('/records')) {
      return reply(200, {
        code: 0,
        data: {
          has_more: false,
          items: [{ fields: { 处理状态: '未处理' } }, { fields: { 处理状态: '已处理' } }, { fields: { 处理状态: { text: '未处理' } } }],
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const count = predicate => calls.filter(predicate).length;
  return { fetchImpl, calls, count };
}

test('Feishu HTTP 200 business errors are reported instead of being counted as zero pending records', async () => {
  const { fetchImpl } = mockFeishu({ tableError: { code: 1254041, msg: 'TableIdNotFound' } });
  const client = createFeishuClient(settings, fetchImpl);

  await assert.rejects(client.countPendingRecords(), /飞书数据表不存在.*TableIdNotFound/);
});

test('a wrongly selected table fails fast with the missing field names and never posts records', async () => {
  const { fetchImpl, count } = mockFeishu({ fields: WRONG_TABLE_FIELDS });
  const client = createFeishuClient(settings, fetchImpl);

  await assert.rejects(client.createRecord({}), /缺少字段：店铺名称、订单编号、星级、评价内容、标记原因、处理状态、发现时间/);
  await assert.rejects(createFeishuClient(settings, fetchImpl).createRecord({}), /可能不是「拼多多疑似差评」表/);

  assert.equal(count(c => c.url.includes('/fields')), 1, '表结构校验结果应被缓存，不应每条评价都重查');
  assert.equal(count(c => c.method === 'POST' && c.url.includes('/records')), 0);
});

test('the wrong-table reason is stored on the review and returned by syncFlaggedReview', async () => {
  const { fetchImpl } = mockFeishu({ fields: WRONG_TABLE_FIELDS });
  const patches = [];

  const result = await syncFlaggedReview({
    account: { id: 'acct-a', shopName: '漫步者极音专卖店' },
    review: { reviewId: 'r-1', orderNo: '260610-1', stars: 5, content: '就是有点闷', flagReason: '音质偏闷' },
    settings,
    feishuClient: createFeishuClient(settings, fetchImpl),
    markExternalRiskSync: (_review, patch) => patches.push(patch),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /缺少字段/);
  assert.match(patches[0].error, /缺少字段/);
});

test('a correct table writes records, counts pending ones, and reuses token and schema checks across clients', async () => {
  const { fetchImpl, count } = mockFeishu();

  assert.equal((await createFeishuClient(settings, fetchImpl).createRecord({ 店铺名称: 'A' })).recordId, 'rec_1');
  assert.equal((await createFeishuClient(settings, fetchImpl).createRecord({ 店铺名称: 'B' })).recordId, 'rec_1');
  assert.equal(await createFeishuClient(settings, fetchImpl).countPendingRecords(), 2);

  assert.equal(count(c => c.url.includes('tenant_access_token')), 1);
  assert.equal(count(c => c.url.includes('/fields')), 1);
  assert.equal(count(c => c.method === 'POST' && c.url.includes('/records')), 2);
});

test('HTTP error bodies from Feishu are translated into an actionable permission hint', async () => {
  const { fetchImpl } = mockFeishu({ createResponse: [403, { code: 1254302, msg: 'RolePermNotAllow' }] });

  await assert.rejects(createFeishuClient(settings, fetchImpl).createRecord({}), /编辑权限.*RolePermNotAllow/);
});

test('validateRiskTable reports ok for the correct table and the missing fields for a wrong one', async () => {
  const good = await createFeishuClient(settings, mockFeishu().fetchImpl).validateRiskTable({ force: true });
  assert.equal(good.ok, true);

  const bad = await createFeishuClient(settings, mockFeishu({ fields: ['店铺名称', '订单编号'] }).fetchImpl).validateRiskTable({ force: true });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missingFields, ['星级', '评价内容', '标记原因', '处理状态', '发现时间']);
});

test('the shop summary no longer claims everything was handled when Feishu writes failed', () => {
  const content = formatWecomRiskSummaryMessage({
    account: { shopName: '漫步者极音专卖店' },
    discoveredRiskCount: 206,
    newRiskCount: 0,
    failedCount: 206,
    failureReason: '飞书表缺少字段：店铺名称、订单编号',
    pendingCount: 0,
  });

  assert.doesNotMatch(content, /已全部处理完成/);
  assert.match(content, /未能写入台账/);
  assert.match(content, /飞书写入失败：206 条/);
  assert.match(content, /失败原因：飞书表缺少字段：店铺名称、订单编号/);
});

test('the automation passes the most common Feishu failure reason into the shop summary', async () => {
  const summaries = [];
  const manager = createAutomationManager({
    getSettings: () => ({ autoReplyEnabled: true, reviewDays: 30, feishuEnabled: true, wecomEnabled: true }),
    getCurrentAccount: () => ({ id: 'acct-a', name: '账号1', shopName: '漫步者极音专卖店' }),
    markReviewFlagged: review => ({ ...review, flagged: true }),
    syncRiskReview: async ({ review }) => (review.reviewId === 'risk-3'
      ? { ok: false, status: 'failed', error: '网络超时' }
      : { ok: false, status: 'failed', error: '飞书表缺少字段：店铺名称' }),
    notifyRiskSummary: async ({ failedCount, failureReason }) => {
      summaries.push({ failedCount, failureReason });
      return { ok: true, status: 'notified' };
    },
    runner: async (_genReply, _onProgress, options) => {
      for (const reviewId of ['risk-1', 'risk-2', 'risk-3']) {
        await options.onReviewFlagged({ reviewId, flagged: true, riskWords: ['闷'] }, '音质偏闷');
      }
      return { total: 3, success: 0, failed: 0, skipped: 3 };
    },
  });

  const job = manager.startReplyGoodReviews();
  await manager.waitForJob(job.id);

  assert.deepEqual(summaries, [{ failedCount: 3, failureReason: '飞书表缺少字段：店铺名称' }]);
});
