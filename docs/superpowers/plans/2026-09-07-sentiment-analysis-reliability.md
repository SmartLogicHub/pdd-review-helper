# Sentiment Analysis Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent DeepSeek request and output-format failures from being misreported as semantic “无法判断”, retry transient failures safely, and keep every final technical failure blocked from automatic reply.

**Architecture:** Add a small reliability module around the existing OpenAI-compatible DeepSeek call, plus a strict parser that distinguishes invalid output from a valid `uncertain_skip`. Persist technical failures as a separate review state, recognize historical failure reasons, and keep the existing batch reanalysis workflow as the recovery path.

**Tech Stack:** Node.js ESM, OpenAI Node SDK, Express, React, Ant Design, Node test runner.

---

## File map

- Create `server/services/sentiment-reliability.js`: typed error classification, retry policy, backoff orchestration, sanitized failure metadata.
- Create `server/tests/sentiment-reliability.test.js`: retry and non-retry behavior.
- Modify `server/services/sentiment-core.js`: strict parsing API alongside the compatibility parser.
- Modify `server/tests/sentiment-prompt-config.test.js`: strict parser tests.
- Modify `server/services/deepseek.js`: use reliable request flow and 500-token output budget.
- Modify `server/services/reply-strategy.js`: convert exhausted technical failures into safe analysis-failure results.
- Modify `server/services/review-normalizer.js`: shared `analysis_failed` status, historical compatibility, blocking, stats and filters.
- Modify `server/data/store.js`: persist and clear technical failure metadata.
- Modify `server/services/sentiment.js`: apply/clear technical failure metadata during reanalysis.
- Modify `server/services/automation.js`: persist technical analysis failures through a dedicated callback.
- Modify `server/services/playwright.js`: skip already replied/blocked rows before AI and propagate technical failure metadata.
- Modify backend tests covering normalizer, automation and reanalysis behavior.
- Modify `server/routes/reviews.js`: expose `analysisFailed` statistics.
- Modify `web/src/pages/Dashboard.jsx`, `web/src/pages/Reviews.jsx`, and `web/src/components/StatsCards.jsx`: show/filter “AI分析失败”.
- Modify `web/src/pages/Settings.jsx`: explain that technical failures are retried and remain safe-blocked.

### Task 1: Strict sentiment output parsing

**Files:**
- Modify: `server/services/sentiment-core.js`
- Test: `server/tests/sentiment-prompt-config.test.js`

- [ ] **Step 1: Write failing strict-parser tests**

Add tests asserting that `parseSentimentResponseStrict`:

```js
assert.equal(parseSentimentResponseStrict(validUncertainJson).label, 'uncertain_skip');
assert.throws(() => parseSentimentResponseStrict('不是 JSON'), err => err.kind === 'invalid_json');
assert.throws(() => parseSentimentResponseStrict('{"label":"bad"}'), err => err.kind === 'invalid_schema');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/sentiment-prompt-config.test.js`

Expected: FAIL because the strict parser export does not exist.

- [ ] **Step 3: Implement the strict parser**

Add a `SentimentOutputError` carrying `kind`, and parse the first JSON object. Throw `invalid_json` for missing/malformed JSON and `invalid_schema` for missing required keys or illegal labels. Keep the current `parseSentimentResponse` behavior by catching the strict error and returning the existing uncertain fallback.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/sentiment-prompt-config.test.js`

Expected: PASS.

### Task 2: Reliable DeepSeek request orchestration

**Files:**
- Create: `server/services/sentiment-reliability.js`
- Create: `server/tests/sentiment-reliability.test.js`

- [ ] **Step 1: Write failing retry-policy tests**

Cover these exact behaviors with injected `request` and `sleep` functions:

```js
// invalid JSON then success => 2 attempts
// status 429 then success => 2 attempts
// timeout/ECONNRESET then success => retry
// status 500 then success => retry
// 401, 402, 403, and balance-message errors => one attempt only
// unknown errors => one attempt only
// all three invalid JSON responses => throws sanitized failure with attempts === 3
// error text containing `sk-secret-value` => public message does not contain the secret
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test tests/sentiment-reliability.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement minimal reliability module**

Export:

```js
export function classifySentimentError(error) { /* kind, retryable, publicMessage */ }
export async function requestSentimentWithRetry({ request, parse, prompt, sleep, maxAttempts = 3 }) { /* loop */ }
export function sanitizeSentimentError(error) { /* no credentials or long payloads */ }
```

Use exponential delays of 1s and 2s by default. Add the correction suffix only after parser failures. Preserve `kind`, `attempts`, and safe public text on the final thrown error.

- [ ] **Step 4: Run the new test and verify GREEN**

Run: `node --test tests/sentiment-reliability.test.js`

Expected: PASS.

### Task 3: Wire reliability into DeepSeek and strategy

**Files:**
- Modify: `server/services/deepseek.js`
- Modify: `server/services/reply-strategy.js`
- Test: `server/tests/deepseek-model.test.js`
- Test: `server/tests/sentiment-detection.test.js`

- [ ] **Step 1: Add failing integration-level unit tests**

Assert the DeepSeek request options use `max_tokens: 500` and low temperature through an exported test helper. Assert a thrown typed reliability error becomes a result with:

```js
{
  analysisFailed: true,
  analysisErrorKind: 'rate_limited',
  analysisAttempts: 3,
  canAutoReply: false,
  uncertain: false,
  flagged: false,
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/deepseek-model.test.js tests/sentiment-detection.test.js`

- [ ] **Step 3: Implement wiring**

Have `deepseek.analyzeSentiment` call `requestSentimentWithRetry`, using `parseSentimentResponseStrict`. Have `reply-strategy.analyzeSentiment` convert an exhausted error into a separate technical-failure result; never silently use the optimistic local fallback after AI was configured.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/deepseek-model.test.js tests/sentiment-detection.test.js`

### Task 4: Persist and classify technical failures safely

**Files:**
- Modify: `server/services/review-normalizer.js`
- Modify: `server/data/store.js`
- Modify: `server/services/sentiment.js`
- Modify: `server/services/automation.js`
- Test: `server/tests/review-normalizer.test.js`
- Test: `server/tests/sentiment-prompt-config.test.js`
- Test: `server/tests/automation.test.js`

- [ ] **Step 1: Write failing state and persistence tests**

Test that:

```js
classifyReviewStatus({ analysisFailed: true, uncertainSkip: true }) === 'analysis_failed';
classifyReviewStatus({ uncertainReason: 'AI情感分析失败，跳过自动回复' }) === 'analysis_failed';
shouldAutoReplyReview({ ...replyable, analysisFailed: true }).ok === false;
summarizeReviewRecords(records).analysisFailed === expectedCount;
normalizeReviewStatusFilter({ status: 'analysis_failed' }) === 'analysis_failed';
```

Also test that saving a technical failure clears stale semantic flags, and a successful reanalysis clears all analysis-failure fields.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/review-normalizer.test.js tests/sentiment-prompt-config.test.js tests/automation.test.js`

- [ ] **Step 3: Implement state handling**

Add a shared historical-reason detector. Give `analysis_failed` precedence after `replied` and before all semantic states. Add `markReviewAnalysisFailed` to the store, clear stale `flagged`, `uncertainSkip`, `neutralReply`, and `sentimentLabel` fields, and wire it through automation. Ensure every successful semantic patch clears technical failure metadata.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/review-normalizer.test.js tests/sentiment-prompt-config.test.js tests/automation.test.js`

### Task 5: Skip terminal rows before AI analysis

**Files:**
- Modify: `server/services/playwright.js`
- Test: `server/tests/automation.test.js` or a focused Playwright service unit test following existing dependency-injection patterns.

- [ ] **Step 1: Write a failing regression test**

Provide an already-replied review to the reply loop and assert the sentiment analyzer is never invoked and no uncertain/analysis-failure callback runs.

- [ ] **Step 2: Run the focused test and verify RED**

Run the selected test file with `node --test`.

- [ ] **Step 3: Implement pre-analysis eligibility check**

Check terminal platform state before `analyzeAndMark`. Only pending, replyable 4/5-star rows reach AI analysis. Preserve the existing report counters and skip reasons.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the selected test file with `node --test`.

### Task 6: Display and filter AI analysis failures

**Files:**
- Modify: `server/routes/reviews.js`
- Modify: `web/src/pages/Dashboard.jsx`
- Modify: `web/src/pages/Reviews.jsx`
- Modify: `web/src/components/StatsCards.jsx`
- Modify: `web/src/pages/Settings.jsx`
- Test: `server/tests/reviews-route.test.js`

- [ ] **Step 1: Write failing reviews-route statistics/filter test**

Assert the API accepts `status=analysis_failed`, returns only technical failures, and exposes `analysisFailed` in statistics.

- [ ] **Step 2: Run the backend test and verify RED**

Run: `node --test tests/reviews-route.test.js`

- [ ] **Step 3: Implement backend and UI display**

Add an “AI分析失败” filter/tag/stat card using a distinct warning color. Tooltip text must use the sanitized `analysisError` and direct the user to “系统设置 → 重新分析”. Keep “无法判断” exclusively for valid semantic `uncertain_skip`.

- [ ] **Step 4: Run backend test, lint and build**

Run:

```text
cd server && node --test tests/reviews-route.test.js
cd web && npm run lint
cd web && npm run build
```

Expected: all commands PASS.

### Task 7: Full regression verification and portable build

**Files:**
- Modify if required: `README.md`

- [ ] **Step 1: Run the complete backend suite**

Run: `cd server && npm test`

Expected: all tests PASS with no unhandled rejections.

- [ ] **Step 2: Run frontend verification**

Run: `cd web && npm run lint && npm run build`

Expected: lint and Vite production build PASS.

- [ ] **Step 3: Build the portable distribution**

Run: `cd server && npm run build`

Expected: `server/dist/` is produced without embedding settings, reviews, API keys, browser profiles, or the user-provided ZIP.

- [ ] **Step 4: Inspect the distribution contents**

Confirm the portable output contains launcher/program assets only and no runtime-data files or credentials.

- [ ] **Step 5: Document recovery instructions**

Update README only if the existing instructions do not explain: launch the fixed version, test the API key, preview “重新分析全部账号”, then apply after reviewing the transition summary.

- [ ] **Step 6: Commit verified implementation**

```text
git add <only files changed by this fix>
git commit -m "fix: make sentiment analysis failures retryable"
```
