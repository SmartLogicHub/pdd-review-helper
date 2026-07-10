import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  categorizeAutomationError,
  standardActionStarted,
  standardAutomationError,
} from '../services/automation-api-response.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');
const manifestPath = join(rootDir, 'automation-manifest.json');

test('automation manifest describes health, SSE events, stop endpoint, actions and workflows', () => {
  assert.equal(existsSync(manifestPath), true);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.service.baseUrl, 'http://localhost:3001');
  assert.deepEqual(manifest.health, { method: 'GET', path: '/api/health' });
  assert.equal(manifest.events.type, 'sse');
  assert.equal(manifest.events.path, '/api/automation/events/{jobId}');
  assert.deepEqual(manifest.stop, { method: 'POST', path: '/api/automation/stop/{jobId}' });

  const actions = Object.fromEntries(manifest.actions.map(action => [action.id, action]));
  for (const id of [
    'fetch_reviews_current_account',
    'reply_good_reviews_current_account',
    'reply_good_reviews_all_accounts',
    'e2e_dry_run_current_account',
    'detect_all_shop_names',
  ]) {
    assert.ok(actions[id], `missing action ${id}`);
    assert.ok(actions[id].dryRun === true || actions[id].dryRunOnly === true, `${id} must declare dryRun`);
  }
  assert.equal(actions.reply_good_reviews_current_account.endpoint.path, '/api/automation/reply-good-reviews');
  assert.equal(actions.reply_good_reviews_all_accounts.endpoint.path, '/api/automation/reply-all-accounts');
  assert.equal(actions.e2e_dry_run_current_account.dryRunOnly, true);

  const workflowIds = manifest.workflows.map(workflow => workflow.id);
  assert.deepEqual(workflowIds, [
    'current_account_safe_reply',
    'all_accounts_safe_reply',
    'acceptance_dry_run',
  ]);
});

test('standard action started response keeps the legacy job object while exposing jobId', () => {
  const response = standardActionStarted({ id: 'job-1', type: 'reply-good-reviews', status: 'running' });

  assert.deepEqual(response, {
    jobId: 'job-1',
    status: 'started',
    message: '任务已启动',
    job: { id: 'job-1', type: 'reply-good-reviews', status: 'running' },
  });
});

test('standard automation errors include category, recoverable and suggestion', () => {
  assert.equal(categorizeAutomationError(new Error('检测到拼多多验证/风控提示，请手动完成')), 'manual_required');
  assert.equal(categorizeAutomationError(new Error('已有自动化任务正在运行或停止中')), 'blocked');
  assert.equal(categorizeAutomationError(new Error('Timeout 45000ms exceeded')), 'timeout');
  assert.equal(categorizeAutomationError(new Error('DeepSeek API Key 配置缺失')), 'service_failed');

  const error = standardAutomationError(new Error('检测到验证码，请手动完成'));
  assert.deepEqual(Object.keys(error), ['error', 'category', 'recoverable', 'suggestion']);
  assert.equal(error.category, 'manual_required');
  assert.equal(error.recoverable, true);
  assert.match(error.suggestion, /手动|登录|验证|检查/);
});
