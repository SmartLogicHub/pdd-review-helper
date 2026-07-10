import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing } from '../services/playwright.js';

test('formats persistent browser profile lock errors with a user action', () => {
  const err = {
    message: 'browserType.launchPersistentContext: Target page, context or browser has been closed',
    log: ['--user-data-dir=C:\\Users\\me\\AppData\\Roaming\\pdd-review-helper\\browser-data'],
  };

  assert.match(
    __testing.formatBrowserLaunchError(err).message,
    /关闭旧的助手浏览器窗口/
  );
});
