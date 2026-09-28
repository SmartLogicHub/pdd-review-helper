import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-sanitize-'));

const store = await import('../data/store.js');
const strategy = await import(`../services/reply-strategy.js?sanitize=${Date.now()}`);
const { classifyReplySubmitMessage } = await import('../services/review-normalizer.js');
const { sanitizeReplyText, REPLY_MAX_LENGTH } = strategy;

// 截图里被拼多多拒收的真实回复（商品名里带空格）
const REJECTED = '亲爱的您好，看到您每天戴着LolliClip SE边工作边听书，我们心里特别高兴～音质好、不漏音，正是这款耳夹式耳机想带给您的体验。您用得舒心，就是对我们最大的肯定。后续使用中有任何问题，随时联系咱们在线客服，我们一直都在。祝您工作顺利，天天好心情！';

test('the reply Pinduoduo rejected loses its space and becomes submittable', () => {
  const clean = sanitizeReplyText(REJECTED);
  assert.doesNotMatch(clean, /\s/);
  assert.match(clean, /LolliClipSE/);
  assert.ok(clean.length <= REPLY_MAX_LENGTH);
});

test('newlines, full-width spaces, zero-width characters and emoji are removed', () => {
  assert.equal(sanitizeReplyText('感谢支持！\n祝您\u3000愉快🎧\u200b～'), '感谢支持！祝您愉快～');
});

test('over-long replies are cut at the last full sentence within 200 characters', () => {
  const sentence = '感谢您的支持与肯定，我们会继续努力。';
  const long = sentence.repeat(20);
  const clean = sanitizeReplyText(long);
  assert.ok(clean.length <= REPLY_MAX_LENGTH);
  assert.ok(clean.endsWith('。'));
});

test('getReply always returns sanitized text, for AI and template replies alike', async () => {
  strategy.__setReplyGeneratorsForTest({ generateReply: async () => '看到您说 LolliClip SE 很好用\n我们很开心🎉' });
  store.saveSettings({ aiReplyEnabled: true });
  store.saveTemplates('感谢您的 支持，祝您 生活愉快！');
  strategy.resetReplyTemplateCache();
  assert.equal((await strategy.getReply({ content: '音质很好' })).reply, '看到您说LolliClipSE很好用我们很开心');

  store.saveSettings({ aiReplyEnabled: false });
  strategy.resetReplyTemplateCache();
  assert.equal((await strategy.getReply({ content: '音质很好' })).reply, '感谢您的支持，祝您生活愉快！');
});

test('the platform rejection toast is classified as a failure, not a success', () => {
  const result = classifyReplySubmitMessage('回复内容不能包含空格、换行等特殊字符！');
  assert.equal(result.status, 'fail');
  assert.match(result.reason, /拒收/);
  assert.equal(classifyReplySubmitMessage('违规信息'), null, '侧边栏的「违规信息」菜单不应被当成拒收提示');
});
