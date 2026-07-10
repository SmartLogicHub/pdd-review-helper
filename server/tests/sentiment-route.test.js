import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-sentiment-route-test-'));

const store = await import(`../data/store.js?sentiment-route-test=${Date.now()}`);
const sentiment = await import(`../services/sentiment.js?sentiment-route-test=${Date.now()}`);
const { createSentimentRouter } = await import(`../routes/sentiment.js?sentiment-route-test=${Date.now()}`);

async function createTestServer(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/sentiment', router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('sentiment prompt route rejects invalid prompts without overwriting the current prompt', async () => {
  const validPrompt = sentiment.DEFAULT_SENTIMENT_PROMPT;
  store.saveSentimentPrompt(validPrompt);
  const server = await createTestServer(createSentimentRouter());
  try {
    const response = await fetch(`${server.baseUrl}/api/sentiment/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '只判断好坏，不返回固定JSON' }),
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.validation.ok, false);
    assert.equal(store.getSentimentPrompt(), validPrompt);
  } finally {
    await server.close();
  }
});

test('sentiment prompt repair route returns a validated repaired prompt without saving it', async () => {
  const oldPrompt = sentiment.DEFAULT_SENTIMENT_PROMPT;
  store.saveSentimentPrompt(oldPrompt);
  const server = await createTestServer(createSentimentRouter({
    repairPromptWithAI: async () => sentiment.DEFAULT_SENTIMENT_PROMPT,
  }));
  try {
    const response = await fetch(`${server.baseUrl}/api/sentiment/prompt/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '随便判断一下' }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.validation.ok, true);
    assert.equal(json.content, sentiment.DEFAULT_SENTIMENT_PROMPT);
    assert.equal(store.getSentimentPrompt(), oldPrompt);
  } finally {
    await server.close();
  }
});

test('sentiment test route normalizes model output for a single review', async () => {
  const server = await createTestServer(createSentimentRouter({
    analyzeReview: async () => sentiment.normalizeSentimentResult({
      label: 'neutral_auto_reply',
      can_auto_reply: true,
      is_real_negative: false,
      reason: '中性评价',
      risk_words: [],
      safe_positive_words: [],
    }),
  }));
  try {
    const response = await fetch(`${server.baseUrl}/api/sentiment/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewContent: '还行', stars: 5 }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.result.label, 'neutral_auto_reply');
    assert.equal(json.result.canAutoReply, true);
  } finally {
    await server.close();
  }
});
