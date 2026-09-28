import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-reply-personalization-'));

const store = await import(`../data/store.js?reply-personalization=${Date.now()}`);
const strategy = await import(`../services/reply-strategy.js?reply-personalization=${Date.now()}`);
const { __testing: deepseekTesting } = await import('../services/deepseek.js');
const { buildReplyPrompt } = deepseekTesting;

const LONG_TITLE = '漫步者 Lollipods Pro 真无线蓝牙耳机 主动降噪 超长续航 游戏低延迟 适用苹果华为小米';

test('reply prompt uses the real shop name and product title instead of a hard-coded brand', () => {
  const prompt = buildReplyPrompt({
    reviewContent: '音质很好，降噪也不错',
    templates: '亲爱的您好，感谢您的支持\n感谢您的评价',
    shopName: '漫步者极音专卖店',
    productName: LONG_TITLE,
  });

  assert.match(prompt, /漫步者极音专卖店/);
  assert.match(prompt, /Lollipods Pro/);
  assert.match(prompt, /不要照抄完整标题/);
  assert.match(prompt, /不要编造参数/);
  assert.doesNotMatch(prompt, /HECATE/);
});

test('reply prompt marks missing shop or product as unknown rather than inventing one', () => {
  const prompt = buildReplyPrompt({ reviewContent: '很好', templates: 'T' });

  assert.match(prompt, /## 店铺名称：\n（未知）/);
  assert.match(prompt, /## 商品标题：\n（未知）/);
});

test('reply prompt keeps instructions and templates as a stable prefix for DeepSeek context caching', () => {
  const templates = '模板一\n模板二\n模板三';
  const a = buildReplyPrompt({ reviewContent: '音质很好', templates, shopName: 'A店', productName: '商品A' });
  const b = buildReplyPrompt({ reviewContent: '续航给力', templates, shopName: 'B店', productName: '商品B' });
  const prefix = a.slice(0, a.indexOf('## 店铺名称'));

  assert.ok(prefix.includes('模板三'), '话术模板应位于固定前缀内');
  assert.ok(b.startsWith(prefix), '不同店铺、不同评价的提示词应共享同一前缀');
});

test('getReply passes the account shop name and the review product title to the reply generator', async () => {
  const calls = [];
  strategy.__setReplyGeneratorsForTest({
    generateReply: async (_content, _templates, context) => {
      calls.push(context);
      return '感谢亲的支持，Lollipods Pro 用得开心就好～';
    },
  });
  store.saveSettings({ aiReplyEnabled: true });
  store.saveTemplates('亲爱的您好，感谢您的支持\n感谢您的评价');
  strategy.resetReplyTemplateCache();

  const result = await strategy.getReply(
    { content: '音质很好', productName: LONG_TITLE },
    { shopName: '漫步者极音专卖店' }
  );

  assert.equal(result.method, 'llm');
  assert.deepEqual(calls, [{ shopName: '漫步者极音专卖店', productName: LONG_TITLE }]);
});

test('template fallback picks from every template instead of four fixed ones', async () => {
  store.saveSettings({ aiReplyEnabled: false });
  store.saveTemplates('A\nB\nC\nD\nE');
  strategy.resetReplyTemplateCache();

  const originalRandom = Math.random;
  Math.random = () => 0.5; // 5 条模板取下标 2；旧逻辑只在 A/B/D/E 里挑，永远取不到 C
  try {
    const result = await strategy.getReply({ content: '音质很好' });
    assert.equal(result.method, 'template');
    assert.equal(result.reply, 'C');
  } finally {
    Math.random = originalRandom;
  }
});
