import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing } from '../services/playwright.js';

test('treats a closed persistent browser context as unusable', () => {
  const closedContext = {
    pages() {
      throw new Error('Target page, context or browser has been closed');
    },
  };

  assert.equal(__testing.isBrowserContextUsable(closedContext), false);
});

test('treats a persistent browser context with pages as usable', () => {
  const openContext = {
    pages() {
      return [];
    },
  };

  assert.equal(__testing.isBrowserContextUsable(openContext), true);
});

test('extracts a real shop name from PDD header text instead of account notes', () => {
  const text = '拼多多 商家后台 HECATE官方旗舰店 pddd19(干浩) 消息 规则中心';

  assert.equal(__testing.extractShopNameFromText(text), 'HECATE官方旗舰店');
});

test('does not treat generic account labels as real shop names', () => {
  assert.equal(__testing.extractShopNameFromText('账号1 默认账号 评价管理'), '');
});

test('does not treat seller-tool helper text as a real shop name', () => {
  assert.equal(__testing.extractShopNameFromText('快速发布同款 查看安装教程 查看 店'), '');
});
