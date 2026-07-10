import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-neutral-reply-test-'));

const store = await import(`../data/store.js?neutral-reply-test=${Date.now()}`);
const strategy = await import(`../services/reply-strategy.js?neutral-reply-test=${Date.now()}`);

const {
  saveNeutralTemplates,
  saveSettings,
  saveTemplates,
} = store;
const { getReply, resetReplyTemplateCache } = strategy;

test('uses neutral templates for neutral reviews when AI replies are disabled', async () => {
  saveSettings({ aiReplyEnabled: false });
  saveTemplates('这是一条普通好评模板，不能用于中性评价');
  saveNeutralTemplates('感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们。');
  resetReplyTemplateCache();

  const result = await getReply({ content: '还行', neutralReply: true });

  assert.equal(result.method, 'neutral-template');
  assert.equal(result.reply, '感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们。');
});

test('falls back to neutral templates when neutral AI generation fails', async () => {
  saveSettings({ aiReplyEnabled: true, deepseekApiKey: '' });
  saveNeutralTemplates('感谢您的反馈，如后续需要帮助欢迎随时联系店铺客服。');
  resetReplyTemplateCache();

  const result = await getReply({ content: '刚拿到，还没用', neutralReply: true });

  assert.equal(result.method, 'neutral-template');
  assert.equal(result.reply, '感谢您的反馈，如后续需要帮助欢迎随时联系店铺客服。');
});
