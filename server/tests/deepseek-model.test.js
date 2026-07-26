import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { __testing as deepseekTesting } from '../services/deepseek.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildScript = join(__dirname, '..', 'build.js');

test('uses the current DeepSeek V4 flash model instead of deprecated aliases', () => {
  assert.equal(deepseekTesting.DEEPSEEK_MODEL, 'deepseek-v4-flash');
});

test('portable exe launcher is built without a visible console window', () => {
  const source = readFileSync(buildScript, 'utf8');

  assert.match(source, /-OutputType WindowsApplication/);
  assert.match(source, /CreateNoWindow = true/);
  assert.match(source, /ProcessWindowStyle\.Hidden/);
  assert.doesNotMatch(source, /-OutputType ConsoleApplication/);
  assert.doesNotMatch(source, /Console\.ReadKey/);
});
