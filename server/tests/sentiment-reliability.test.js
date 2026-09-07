import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSentimentResponseStrict } from '../services/sentiment-core.js';
import {
  classifySentimentError,
  requestSentimentWithRetry,
  sanitizeSentimentError,
} from '../services/sentiment-reliability.js';

const VALID_RESPONSE = JSON.stringify({
  label: 'positive_auto_reply',
  can_auto_reply: true,
  is_real_negative: false,
  reason: '明确正面',
  risk_words: [],
  safe_positive_words: ['满意'],
});

function apiError(status, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.status = status;
  return error;
}

test('retries invalid sentiment JSON with a correction prompt and then succeeds', async () => {
  const prompts = [];
  const sleeps = [];
  const responses = ['不是 JSON', VALID_RESPONSE];

  const outcome = await requestSentimentWithRetry({
    prompt: '原始提示词',
    request: async prompt => {
      prompts.push(prompt);
      return responses.shift();
    },
    parse: parseSentimentResponseStrict,
    sleep: async delay => sleeps.push(delay),
  });

  assert.equal(outcome.result.label, 'positive_auto_reply');
  assert.equal(outcome.attempts, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /严格 JSON|修正/);
  assert.deepEqual(sleeps, [1000]);
});

test('retries rate limits, network timeouts and server errors', async () => {
  for (const failure of [
    apiError(429),
    Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    apiError(500),
  ]) {
    let attempts = 0;
    const outcome = await requestSentimentWithRetry({
      prompt: 'p',
      request: async () => {
        attempts += 1;
        if (attempts === 1) throw failure;
        return VALID_RESPONSE;
      },
      parse: parseSentimentResponseStrict,
      sleep: async () => {},
    });

    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.result.label, 'positive_auto_reply');
  }
});

test('does not retry authentication, billing, permission or unknown failures', async () => {
  const failures = [
    [apiError(401), 'authentication'],
    [apiError(402), 'billing'],
    [apiError(403), 'permission'],
    [new Error('Insufficient Balance for this request'), 'billing'],
    [new Error('unexpected local failure'), 'unknown'],
  ];

  for (const [failure, expectedKind] of failures) {
    let attempts = 0;
    await assert.rejects(
      requestSentimentWithRetry({
        prompt: 'p',
        request: async () => {
          attempts += 1;
          throw failure;
        },
        parse: parseSentimentResponseStrict,
        sleep: async () => {},
      }),
      error => error?.kind === expectedKind && error?.attempts === 1
    );
    assert.equal(attempts, 1);
  }
});

test('stops after three invalid responses and reports a sanitized technical failure', async () => {
  let attempts = 0;
  await assert.rejects(
    requestSentimentWithRetry({
      prompt: 'p',
      request: async () => {
        attempts += 1;
        return '```json\n{"label":';
      },
      parse: parseSentimentResponseStrict,
      sleep: async () => {},
    }),
    error => error?.kind === 'invalid_json'
      && error?.attempts === 3
      && error?.retryable === true
  );
  assert.equal(attempts, 3);
});

test('classifies retryable errors and removes credentials from public messages', () => {
  assert.deepEqual(
    classifySentimentError(apiError(429)).kind,
    'rate_limited'
  );
  const sanitized = sanitizeSentimentError(new Error('Authorization: Bearer sk-secret-value request failed'));
  assert.doesNotMatch(sanitized, /sk-secret-value|Bearer/i);
  assert.match(sanitized, /\[REDACTED\]/);
});
