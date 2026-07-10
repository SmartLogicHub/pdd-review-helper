import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskApiKey, maskSecret, mergeSettings, parseFeishuBitableUrl, publicSettings } from '../data/settings-utils.js';

test('masks API keys before returning settings to the browser', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-1***********cdef');
});

test('merges only supported settings fields', () => {
  const merged = mergeSettings(
    { deepseekApiKey: 'old', storeName: 'old-store', autoReplyEnabled: false, aiReplyEnabled: false },
    { deepseekApiKey: 'sk-new-valid-key', storeName: 'new-store', autoReplyEnabled: true, aiReplyEnabled: true, reviewDays: 30, injected: 'ignored' }
  );

  assert.equal(merged.deepseekApiKey, 'sk-new-valid-key');
  assert.equal(merged.storeName, 'new-store');
  assert.equal(merged.autoReplyEnabled, true);
  assert.equal(merged.aiReplyEnabled, true);
  assert.equal(merged.reviewDays, 30);
  assert.equal(Object.hasOwn(merged, 'injected'), false);
});

test('preserves the real API key when the browser submits a masked key', () => {
  const merged = mergeSettings(
    { deepseekApiKey: 'sk-real-secret', storeName: 'old-store', autoReplyEnabled: false },
    { deepseekApiKey: 'sk-r******cret', storeName: 'new-store' }
  );

  assert.equal(merged.deepseekApiKey, 'sk-real-secret');
  assert.equal(merged.storeName, 'new-store');
});

test('does not replace DeepSeek API key with webhook or URL autofill values', () => {
  const merged = mergeSettings(
    {
      deepseekApiKey: 'sk-real-deepseek-key',
      wecomWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=real-key',
    },
    {
      deepseekApiKey: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wrong-field',
      wecomWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-real-key',
    }
  );

  assert.equal(merged.deepseekApiKey, 'sk-real-deepseek-key');
  assert.equal(merged.wecomWebhookUrl, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=new-real-key');
});

test('drops invalid persisted DeepSeek API key values instead of exposing them as configured', () => {
  const exposed = publicSettings({
    deepseekApiKey: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wrong-field',
  });

  assert.equal(exposed.deepseekApiKey, '');
  assert.equal(exposed.hasDeepseekApiKey, false);
});

test('normalizes review day range to the supported choices', () => {
  assert.equal(mergeSettings({}, { reviewDays: 30 }).reviewDays, 30);
  assert.equal(mergeSettings({}, { reviewDays: '180' }).reviewDays, 180);
  assert.equal(mergeSettings({}, { reviewDays: 365 }).reviewDays, 90);
  assert.equal(mergeSettings({}, { reviewDays: 'bad' }).reviewDays, 90);
});

test('parses Feishu bitable links into app token and table id', () => {
  const parsed = parseFeishuBitableUrl('https://xcnbc7loouq4.feishu.cn/base/Q1oFbAEPJayegrsU4jycW1Lenod?table=tblYg38HBMRyMKtX&view=vewbYGZPvB');

  assert.deepEqual(parsed, {
    appToken: 'Q1oFbAEPJayegrsU4jycW1Lenod',
    tableId: 'tblYg38HBMRyMKtX',
    viewId: 'vewbYGZPvB',
  });
});

test('stores and masks external integration secrets without overwriting masked values', () => {
  const current = {
    feishuAppSecret: 'real-feishu-secret',
    wecomWebhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=real-key',
    feishuBotWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/real-token',
  };
  const merged = mergeSettings(current, {
    feishuEnabled: true,
    feishuAppId: 'cli_xxx',
    feishuAppSecret: maskSecret(current.feishuAppSecret),
    feishuBitableUrl: 'https://xcnbc7loouq4.feishu.cn/base/Q1oFbAEPJayegrsU4jycW1Lenod?table=tblYg38HBMRyMKtX',
    wecomEnabled: true,
    wecomWebhookUrl: maskSecret(current.wecomWebhookUrl),
    feishuBotEnabled: true,
    feishuBotWebhookUrl: maskSecret(current.feishuBotWebhookUrl),
  });

  assert.equal(merged.feishuAppSecret, 'real-feishu-secret');
  assert.equal(merged.wecomWebhookUrl, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=real-key');
  assert.equal(merged.feishuBotWebhookUrl, 'https://open.feishu.cn/open-apis/bot/v2/hook/real-token');
  assert.equal(merged.feishuAppToken, 'Q1oFbAEPJayegrsU4jycW1Lenod');
  assert.equal(merged.feishuTableId, 'tblYg38HBMRyMKtX');

  const exposed = publicSettings(merged);
  assert.equal(exposed.hasFeishuAppSecret, true);
  assert.equal(exposed.hasWecomWebhookUrl, true);
  assert.equal(exposed.hasFeishuBotWebhookUrl, true);
  assert.match(exposed.feishuAppSecret, /\*/);
  assert.match(exposed.wecomWebhookUrl, /\*/);
  assert.match(exposed.feishuBotWebhookUrl, /\*/);
});

test('keeps Feishu upload, WeCom notification and Feishu bot notification switches independent', () => {
  const uploadOnly = mergeSettings({}, { feishuEnabled: true, wecomEnabled: false, feishuBotEnabled: false });
  const wecomOnly = mergeSettings({}, { feishuEnabled: false, wecomEnabled: true, feishuBotEnabled: false });
  const feishuBotOnly = mergeSettings({}, { feishuEnabled: false, wecomEnabled: false, feishuBotEnabled: true });

  assert.equal(uploadOnly.feishuEnabled, true);
  assert.equal(uploadOnly.wecomEnabled, false);
  assert.equal(uploadOnly.feishuBotEnabled, false);
  assert.equal(wecomOnly.feishuEnabled, false);
  assert.equal(wecomOnly.wecomEnabled, true);
  assert.equal(wecomOnly.feishuBotEnabled, false);
  assert.equal(feishuBotOnly.feishuEnabled, false);
  assert.equal(feishuBotOnly.wecomEnabled, false);
  assert.equal(feishuBotOnly.feishuBotEnabled, true);
});
