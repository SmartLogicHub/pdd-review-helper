import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPddPageState, isSecurityVerificationText } from '../services/pdd-page-state.js';

test('classifies login pages as waiting for manual login', () => {
  const state = classifyPddPageState({
    url: 'https://mms.pinduoduo.com/login/',
    visibleText: '拼多多商家后台 手机号登录',
  });

  assert.equal(state.kind, 'login');
  assert.equal(state.waiting, true);
});

test('classifies evaluation-page verification overlays with close controls as closeable', () => {
  const state = classifyPddPageState({
    url: 'https://mms.pinduoduo.com/goods/evaluation/index',
    visibleText: '安全验证 请拖动滑块完成验证',
    hasCloseControl: true,
  });

  assert.equal(state.kind, 'closeable-verification');
  assert.equal(state.waiting, false);
});

test('classifies login verification overlays with close controls as waiting for user action', () => {
  const state = classifyPddPageState({
    url: 'https://mms.pinduoduo.com/login/',
    visibleText: '手机号登录 安全验证 请拖动滑块完成验证',
    hasCloseControl: true,
  });

  assert.equal(state.kind, 'login');
  assert.equal(state.waiting, true);
});

test('classifies non-dismissible verification as waiting for user action', () => {
  const state = classifyPddPageState({
    url: 'https://mms.pinduoduo.com/goods/evaluation/index',
    visibleText: '安全验证 请拖动滑块完成验证',
    hasCloseControl: false,
  });

  assert.equal(state.kind, 'verification');
  assert.equal(state.waiting, true);
});

test('marks security verification text as unsafe for automatic close', () => {
  assert.equal(isSecurityVerificationText('安全验证 请拖动滑块完成验证'), true);
  assert.equal(isSecurityVerificationText('验证码输入错误，请重新验证'), true);
  assert.equal(isSecurityVerificationText('活动提醒 稍后再说'), false);
});
