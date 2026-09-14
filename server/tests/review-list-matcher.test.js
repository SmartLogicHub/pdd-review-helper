import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../services/playwright.js';

const { requestMatchesGoodReviewFilter } = __testing;

function fakeResponse({
  url = 'https://mms.pinduoduo.com/saturn/reviews/list',
  status = 200,
  method = 'POST',
  body = {},
} = {}) {
  return {
    url: () => url,
    status: () => status,
    request: () => ({
      method: () => method,
      postData: () => JSON.stringify(body),
    }),
  };
}

const stringFilter = { replyStatus: '2', descScore: ['4', '5'], pageNo: 1 };
const numberFilter = { replyStatus: 2, descScore: [4, 5], pageNo: 1 };

test('matches the unreplied good-review filter when values are strings', () => {
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ body: stringFilter })), true);
});

test('matches the same filter when pinduoduo sends numbers instead of strings', () => {
  // 拼多多返回体已改为数字，请求体同样可能变数字；类型漂移不能再导致匹配失败
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ body: numberFilter })), true);
});

test('matches mixed string and number filter values', () => {
  assert.equal(
    requestMatchesGoodReviewFilter(fakeResponse({ body: { replyStatus: 2, descScore: ['4', 5] } })),
    true
  );
});

test('rejects responses that are not the unreplied good-review filter', () => {
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ body: { replyStatus: 1, descScore: [4, 5] } })), false);
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ body: { replyStatus: 2, descScore: [5] } })), false);
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ body: { replyStatus: 2, descScore: 'all' } })), false);
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ body: {} })), false);
});

test('rejects non-matching url, status or method', () => {
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ url: 'https://mms.pinduoduo.com/other', body: numberFilter })), false);
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ status: 500, body: numberFilter })), false);
  assert.equal(requestMatchesGoodReviewFilter(fakeResponse({ method: 'GET', body: numberFilter })), false);
});
