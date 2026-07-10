import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';

process.env.PDD_HELPER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pdd-review-templates-route-test-'));

const { default: templatesRouter } = await import(`../routes/templates.js?templates-route-test=${Date.now()}`);

async function createTestServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRouter);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('reads and saves neutral templates through the templates API', async () => {
  const server = await createTestServer();
  try {
    const initial = await fetch(`${server.baseUrl}/api/templates/neutral`);
    assert.equal(initial.status, 200);
    const initialJson = await initial.json();
    assert.match(initialJson.content, /感谢您的评价/);

    const customContent = '感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们。';
    const saved = await fetch(`${server.baseUrl}/api/templates/neutral`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: customContent }),
    });
    assert.equal(saved.status, 200);

    const next = await fetch(`${server.baseUrl}/api/templates/neutral`);
    const nextJson = await next.json();
    assert.equal(nextJson.content, customContent);
  } finally {
    await server.close();
  }
});
