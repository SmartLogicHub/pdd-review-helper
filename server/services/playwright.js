import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeSentiment, detectLocalRiskSentiment } from './reply-strategy.js';
import { getPddPageState, SECURITY_VERIFICATION_TEXT_PATTERN } from './pdd-page-state.js';
import { updateAccountShopName } from '../data/store.js';
import {
  buildGoodReviewListRequest,
  classifyReviewStatus,
  classifyReplySubmitMessage,
  createReplyRunReport,
  normalizePddReviewListResponse,
  recordReplyRunOutcome,
  nextReplyPageAction,
  replyRunProgressFields,
  reviewDaysFilterLabel,
  reviewKey,
  reviewPageCountForRows,
  sameReviewIdentity,
  shouldAutoReplyReview,
  shouldContinueReplyRun,
  effectiveFlagReason,
  updateReplyRunLiveState,
} from './review-normalizer.js';
import {
  createE2EDryRunReport,
  recordE2EDryRunPage,
  summarizeE2EPageReviews,
  validateGoodReviewPageRequest,
} from './e2e-dry-run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.APP_DIR || join(__dirname, '..', '..');
const RUNTIME_DIR = process.env.PDD_HELPER_DATA_DIR
  || (process.env.APPDATA ? join(process.env.APPDATA, 'pdd-review-helper') : join(APP_DIR, 'runtime-data'));
const BROWSER_DATA = join(RUNTIME_DIR, 'browser-data');
const BROWSER_ACCOUNT_DATA = join(RUNTIME_DIR, 'browser-data-accounts');
const SCREENSHOT_DIR = join(RUNTIME_DIR, 'screenshots');
const REVIEWS_URL = 'https://mms.pinduoduo.com/goods/evaluation/index';
const REVIEW_LIST_API = '/saturn/reviews/list';
const DEFAULT_PAGE_SIZE = 10;
const ORDER_SEARCH_INPUT_XPATH = '/html/body/div[1]/div/div/div/main/div[3]/div/div/div/div/div[3]/div[2]/div/form/div/div/div[1]/div/div[2]/div/div/div/div/div/input';

let browserContext = null;
let browserAccountId = 'default';

function normalizeAccountId(accountId = 'default') {
  const id = String(accountId || 'default').trim();
  return /^[a-zA-Z0-9_-]{1,48}$/.test(id) ? id : 'default';
}

function browserDataDirForAccount(accountId = 'default') {
  const id = normalizeAccountId(accountId);
  if (id === 'default') return BROWSER_DATA;
  return join(BROWSER_ACCOUNT_DATA, id);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 600, max = 1600) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return delay(ms);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeVisibleText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function compactVisibleText(text = '') {
  return String(text || '').replace(/\s+/g, '');
}

function extractShopNameFromText(text = '') {
  const source = normalizeVisibleText(text);
  if (!source || /^(账号\d*|默认账号|评价管理|商家后台)$/i.test(source)) return '';
  const uiTextPattern = /(快速发布|发布同款|安装教程|查看教程|常用功能|后台首页|规则中心|客户端|消息|客服平台|防控中心|评价管理|商品管理|发货管理|订单管理|打单工具|物流工具|推广报表|商品数据)/;
  const patterns = [
    /([A-Za-z0-9\u4e00-\u9fa5（）()·\-\s]{2,48}?(?:官方旗舰店|旗舰店|专卖店|专营店|企业店|个人店|官方店))/,
    /([A-Za-z0-9\u4e00-\u9fa5（）()·\-\s]{2,36}?店)(?:\s|$)/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    const candidate = normalizeVisibleText(match[1])
      .replace(/^(?:(?:拼多多|商家后台|后台首页|常用功能)\s*)+/g, '')
      .replace(/\s*(消息|规则中心|客户端|跨境|社区团购).*$/g, '')
      .trim();
    if (
      candidate
      && !/^(账号\d*|默认账号|评价管理|商家后台|拼多多)$/.test(candidate)
      && !uiTextPattern.test(candidate)
      && candidate.length >= 3
    ) {
      return candidate;
    }
  }
  return '';
}

function isReplyActionText(text = '') {
  return compactVisibleText(text) === '回复/互动';
}

function orderSearchInputLocator() {
  return `xpath=${ORDER_SEARCH_INPUT_XPATH}`;
}

function buildReviewActionHints(review = {}) {
  const hints = [
    review.orderNo,
    review.orderSn,
    review.reviewId,
    review.id,
  ];
  const contentHint = normalizeVisibleText(review.content || review.comment || review.appendContent || '').slice(0, 13);
  if (contentHint) hints.push(contentHint);
  return [...new Set(hints.map(normalizeVisibleText).filter(Boolean))];
}

function describeTextareaSnapshots(snapshots = []) {
  const summary = {
    total: snapshots.length,
    hidden: 0,
    feedback: 0,
    visibleReply: 0,
  };

  for (const snapshot of snapshots) {
    const visible = Number(snapshot.width) > 30
      && Number(snapshot.height) > 10
      && snapshot.display !== 'none'
      && snapshot.visibility !== 'hidden'
      && snapshot.opacity !== '0';
    if (!visible) {
      summary.hidden += 1;
    } else if (snapshot.withinFeedback) {
      summary.feedback += 1;
    } else {
      summary.visibleReply += 1;
    }
  }

  return summary;
}

function isDisabledPaginationSnapshot(snapshot = {}) {
  const className = String(snapshot.className || '').toLowerCase();
  return Boolean(snapshot.disabled)
    || String(snapshot.ariaDisabled || '').toLowerCase() === 'true'
    || className.includes('disabled');
}

function hasPaginationScopeMetadata(snapshots = []) {
  return snapshots.some(snapshot => (
    snapshot.inPaginationRoot !== undefined
      || snapshot.inDropdown !== undefined
      || snapshot.inPageSizeControl !== undefined
      || snapshot.source
  ));
}

function isAllowedPaginationSnapshot(snapshot = {}, scoped = false) {
  if (snapshot.inDropdown || snapshot.inPageSizeControl) return false;
  if (snapshot.source && snapshot.source !== 'pagination') return false;
  if (scoped && !snapshot.inPaginationRoot && snapshot.source !== 'pagination') return false;
  return true;
}

function isNextPaginationSnapshot(snapshot = {}) {
  const text = normalizeVisibleText(snapshot.text);
  const ariaLabel = normalizeVisibleText(snapshot.ariaLabel).toLowerCase();
  const className = String(snapshot.className || '').toLowerCase();
  return text === '>'
    || text === '›'
    || text === '»'
    || text === '下一页'
    || ariaLabel.includes('next')
    || ariaLabel.includes('下一页')
    || className.includes('next');
}

function pickPaginationControlSnapshot(snapshots = [], targetPageNo) {
  const scoped = hasPaginationScopeMetadata(snapshots);
  const candidates = snapshots.filter(snapshot => (
    isAllowedPaginationSnapshot(snapshot, scoped)
      && !isDisabledPaginationSnapshot(snapshot)
  ));
  const targetText = targetPageNo ? String(targetPageNo) : '';
  if (targetText) {
    const target = candidates.find(snapshot => normalizeVisibleText(snapshot.text) === targetText);
    if (target) return { index: target.index, strategy: 'page-number' };
  }

  const next = candidates.find(snapshot => isNextPaginationSnapshot(snapshot));
  if (next) return { index: next.index, strategy: 'next-arrow' };

  return null;
}

const NETWORK_SAFE_BODY_KEYS = new Set([
  'pageNo',
  'pageSize',
  'replyStatus',
  'descScore',
  'reviewId',
  'reviewIds',
  'orderSn',
  'orderSnList',
  'mallId',
]);

function summarizePostData(postData = '') {
  if (!postData || typeof postData !== 'string') return { bodyKeys: [], bodySample: {} };
  try {
    const body = JSON.parse(postData);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { bodyKeys: [], bodySample: {} };
    const bodyKeys = Object.keys(body).sort();
    const bodySample = {};
    for (const key of bodyKeys) {
      if (NETWORK_SAFE_BODY_KEYS.has(key)) bodySample[key] = body[key];
    }
    return { bodyKeys, bodySample };
  } catch {
    return { bodyKeys: ['<non-json>'], bodySample: {} };
  }
}

function sanitizeNetworkSnapshot({
  url = '',
  method = '',
  status = null,
  postData = '',
} = {}) {
  let host = '';
  let path = String(url || '');
  try {
    const parsed = new URL(url);
    host = parsed.host;
    path = parsed.pathname;
  } catch {
    host = '';
  }

  const { bodyKeys, bodySample } = summarizePostData(postData);
  return {
    method,
    status,
    host,
    path,
    bodyKeys,
    bodySample,
  };
}

function isReplyRelatedNetworkUrl(url = '') {
  return /saturn|review|reply|interact|comment|evaluation|mallEvaluation/i.test(String(url || ''));
}

function createReplyNetworkProbe(page) {
  const events = [];
  const pushEvent = (event) => {
    if (!event || !isReplyRelatedNetworkUrl(`${event.host}${event.path}`)) return;
    events.push(event);
    if (events.length > 40) events.shift();
  };

  const onResponse = async (response) => {
    try {
      const request = response.request();
      pushEvent(sanitizeNetworkSnapshot({
        url: response.url(),
        method: request.method(),
        status: response.status(),
        postData: request.postData() || '',
      }));
    } catch {
      // Ignore late network bookkeeping errors; the page action itself decides success.
    }
  };

  const onRequestFailed = (request) => {
    try {
      pushEvent(sanitizeNetworkSnapshot({
        url: request.url(),
        method: request.method(),
        status: 'failed',
        postData: request.postData() || '',
      }));
    } catch {
      // Ignore diagnostic-only failures.
    }
  };

  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return {
    async stop() {
      await delay(400);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      return [...events];
    },
  };
}

function isStopped(stopSignal) {
  if (!stopSignal) return false;
  if (typeof stopSignal === 'function') return stopSignal();
  if (stopSignal.aborted) return true;
  if (typeof stopSignal.isStopped === 'function') return stopSignal.isStopped();
  return false;
}

function emitProgress(onProgress, payload) {
  onProgress?.({
    at: new Date().toISOString(),
    ...payload,
  });
}

async function waitForPageGate(page, {
  onProgress,
  stopSignal,
  stage = '页面检查',
  timeout = 10 * 60 * 1000,
} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getPddPageState(page);
    if (state.kind === 'closeable-verification') {
      emitProgress(onProgress, {
        status: 'popup-closed',
        stage,
        reason: state.message,
      });
      await dismissAllPopups(page, { allowSecurityClose: true });
      await randomDelay(500, 900);
      continue;
    }

    if (state.kind === 'ready') {
      if (page.url().includes('/goods/evaluation/index')) {
        await dismissAllPopups(page);
        const afterDismiss = await getPddPageState(page);
        if (afterDismiss.waiting) {
          emitProgress(onProgress, {
            status: 'waiting',
            stage,
            reason: afterDismiss.message,
          });
          await randomDelay(1500, 2500);
          continue;
        }
      }
      return state;
    }

    if (!state.waiting) continue;

    emitProgress(onProgress, {
      status: 'waiting',
      stage,
      reason: state.message,
    });

    const startedAt = Date.now();
    while (!isStopped(stopSignal) && Date.now() - startedAt < timeout) {
      await randomDelay(1500, 2500);
      const nextState = await getPddPageState(page);
      if (nextState.kind === 'closeable-verification') {
        emitProgress(onProgress, {
          status: 'popup-closed',
          stage,
          reason: nextState.message,
        });
        await dismissAllPopups(page, { allowSecurityClose: true });
        continue;
      }
      if (nextState.kind === 'ready') {
        emitProgress(onProgress, {
          status: 'resumed',
          stage,
          reason: '验证/登录状态已解除，继续执行',
        });
        if (page.url().includes('/goods/evaluation/index')) {
          await dismissAllPopups(page);
        }
        return nextState;
      }
    }

    if (isStopped(stopSignal)) throw new Error('任务已停止');
    throw new Error(`${state.message}（等待超时）`);
  }

  return getPddPageState(page);
}

async function hideKnownFloatingBlockers(page) {
  await page.evaluate(() => {
    const selectors = [
      '#umd_kits_home_entry',
      '[class*="ActivityBottomEntrance"]',
      '[class*="activityBottomEntrance"]',
      '[class*="ImportantList"]',
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(node => {
        node.setAttribute('data-pdd-helper-hidden', '1');
        node.style.display = 'none';
        node.style.pointerEvents = 'none';
      });
    }
  }).catch(() => {});
}

async function dismissAllPopups(page, { allowSecurityClose = false } = {}) {
  const closeSelectors = [
    '[data-testid="beast-core-modal-icon-close"]',
    '[class*="beast-core-modal-icon-close"]',
    '[class*="modal"] [class*="close"]',
    '[class*="dialog"] [class*="close"]',
    '[aria-label*="关闭"]',
    '[aria-label*="close" i]',
    '[role="button"]:has-text("关闭")',
    '[role="button"]:has-text("×")',
    '.ant-modal-close',
    'button:has-text("知道了")',
    'button:has-text("关闭")',
    'button:has-text("稍后再说")',
    'span:has-text("×")',
  ];

  for (const selector of closeSelectors) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
      const isSecurityControl = await loc.evaluate((node, securityPattern) => {
        const container = node.closest([
          '[role="dialog"]',
          '[class*="modal"]',
          '[class*="Modal"]',
          '[class*="dialog"]',
          '[class*="Dialog"]',
          '[class*="verify"]',
          '[class*="Verify"]',
          '[class*="captcha"]',
          '[class*="Captcha"]',
          '[class*="slider"]',
          '[class*="Slider"]',
        ].join(',')) || node;
        const text = container.innerText || container.textContent || '';
        return new RegExp(securityPattern, 'i').test(text);
      }, SECURITY_VERIFICATION_TEXT_PATTERN).catch(() => false);
      if (isSecurityControl && !allowSecurityClose) continue;
      await loc.click({ timeout: 1500 }).catch(() => {});
      await randomDelay(200, 500);
    }
  }

  await hideKnownFloatingBlockers(page);
}

async function safeClick(page, locator, label, { forceLast = false } = {}) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
  await randomDelay(250, 600);
  await hideKnownFloatingBlockers(page);

  try {
    await target.click({ timeout: 5000 });
  } catch (err) {
    if (!forceLast) throw new Error(`${label} 点击失败: ${err.message}`);
    await hideKnownFloatingBlockers(page);
    await target.click({ force: true, timeout: 5000 });
  }
}

async function waitForPageStable(page, timeout = 12000) {
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  await randomDelay(800, 1400);
}

function requestMatchesGoodReviewFilter(response) {
  if (!response.url().includes(REVIEW_LIST_API) || response.status() !== 200) return false;
  if (response.request().method() !== 'POST') return false;
  try {
    const body = JSON.parse(response.request().postData() || '{}');
    return body.replyStatus === '2'
      && Array.isArray(body.descScore)
      && body.descScore.includes('4')
      && body.descScore.includes('5');
  } catch {
    return false;
  }
}

function requestMatchesGoodReviewOrderSearch(orderNo) {
  const targetOrderNo = normalizeVisibleText(orderNo);
  return (response) => {
    if (!requestMatchesGoodReviewFilter(response)) return false;
    try {
      const body = JSON.parse(response.request().postData() || '{}');
      return normalizeVisibleText(body.orderSn || body.orderNo || '') === targetOrderNo;
    } catch {
      return false;
    }
  };
}

function readReviewListRequestBody(response) {
  try {
    return JSON.parse(response.request().postData() || '{}');
  } catch {
    return null;
  }
}

async function parseReviewListResponse(response) {
  const payload = await response.json();
  return {
    ...normalizePddReviewListResponse(payload),
    requestBody: readReviewListRequestBody(response),
  };
}

function reviewListPopupCleanupStage(stage = '读取评价列表') {
  return `${stage}后弹窗检查`;
}

async function cleanupAfterReviewListResponse(page, {
  onProgress,
  stopSignal,
  stage,
} = {}) {
  await randomDelay(300, 800);
  await waitForPageGate(page, {
    onProgress,
    stopSignal,
    stage: reviewListPopupCleanupStage(stage),
  });
  await dismissAllPopups(page);
}

async function waitForGoodReviewList(page, action, {
  timeout = 30000,
  onProgress,
  stopSignal,
  responseMatcher = requestMatchesGoodReviewFilter,
  expectedPageNo,
  expectedPageSize,
  stage = '读取评价列表',
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitForPageGate(page, { onProgress, stopSignal, stage });
    const responsePromise = page.waitForResponse(responseMatcher, { timeout });

    try {
      await action();
      const response = await responsePromise;
      const parsed = await parseReviewListResponse(response);
      if (expectedPageNo !== undefined || expectedPageSize !== undefined) {
        const actualPageNo = Number(parsed.requestBody?.pageNo || 0);
        const actualPageSize = Number(parsed.requestBody?.pageSize || 0);
        if (
          (expectedPageNo !== undefined && actualPageNo !== Number(expectedPageNo))
          || (expectedPageSize !== undefined && actualPageSize !== Number(expectedPageSize))
        ) {
          const diagnostics = await readPaginationDiagnostics(page, { targetPageNo: expectedPageNo });
          throw attachPaginationDiagnostics(
            new Error(`pagination request mismatch: expected pageNo=${expectedPageNo || '*'} pageSize=${expectedPageSize || '*'}, got pageNo=${actualPageNo || 'unknown'} pageSize=${actualPageSize || 'unknown'}`),
            diagnostics
          );
        }
      }
      await cleanupAfterReviewListResponse(page, { onProgress, stopSignal, stage });
      return parsed;
    } catch (err) {
      lastError = err;
      await Promise.race([responsePromise.catch(() => {}), delay(800)]);
      await waitForPageGate(page, { onProgress, stopSignal, stage }).catch(gateErr => {
        lastError = gateErr;
      });
      const paginationDiagnostics = err.paginationDiagnostics || await readPaginationDiagnostics(page, { targetPageNo: expectedPageNo }).catch(() => null);
      emitProgress(onProgress, {
        status: 'retry',
        paginationDiagnostics,
        stage,
        reason: `评价列表请求未稳定返回，第 ${attempt} 次重试`,
      });
      await randomDelay(900, 1600);
    }
  }

  const paginationDiagnostics = lastError?.paginationDiagnostics || await readPaginationDiagnostics(page, { targetPageNo: expectedPageNo }).catch(() => null);
  throw attachPaginationDiagnostics(
    new Error(`等待评价列表接口超时: ${lastError?.message || '未知错误'}`),
    paginationDiagnostics
  );
}

async function ensureReviewPage(page, options = {}) {
  if (!page.url().includes('/goods/evaluation/index')) {
    await page.goto(REVIEWS_URL, { timeout: 60000, waitUntil: 'domcontentloaded' });
  }
  await waitForPageStable(page, 15000);
  await waitForPageGate(page, { ...options, stage: '进入评价管理' });
  await page.waitForSelector('text=评价管理', { timeout: 20000 }).catch(() => {});
  await dismissAllPopups(page);
  await waitForPageGate(page, { ...options, stage: '评价管理页检查' });
}

async function detectShopNameFromPage(page) {
  const candidates = await page.evaluate(() => {
    const pickText = node => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      '[class*="header"]',
      '[class*="Header"]',
      '[class*="user"]',
      '[class*="User"]',
      '[class*="mall"]',
      '[class*="Mall"]',
      '[class*="shop"]',
      '[class*="Shop"]',
      '[class*="store"]',
      '[class*="Store"]',
    ];
    const values = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(node => {
        const text = pickText(node);
        if (text) values.push(text);
      });
    }
    const bodyText = pickText(document.body).split(/\n| {2,}/).slice(0, 120).join(' ');
    if (bodyText) values.push(bodyText);
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          const value = storage.getItem(key);
          if (value && /店|shop|mall/i.test(value)) values.push(value.slice(0, 2000));
        }
      } catch {
        // Ignore storage access restrictions.
      }
    }
    return [...new Set(values)];
  }).catch(() => []);

  for (const candidate of candidates) {
    const shopName = extractShopNameFromText(candidate);
    if (shopName) return shopName;
  }
  return '';
}

export async function detectShopNameForAccount(account = {}, options = {}) {
  const accountId = normalizeAccountId(account.id || options.accountId);
  const ctx = await initBrowser({ accountId });
  const page = ctx.pages().find(item => item.url().includes('mms.pinduoduo.com'))
    || ctx.pages()[0]
    || await ctx.newPage();
  if (!page.url().includes('mms.pinduoduo.com')) {
    await page.goto(REVIEWS_URL, { timeout: 60000, waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await waitForPageStable(page, 15000);
  await waitForPageGate(page, {
    onProgress: options.onProgress,
    stopSignal: options.stopSignal,
    stage: '识别真实店铺名',
    timeout: options.timeout || 45000,
  });
  const shopName = await detectShopNameFromPage(page);
  if (!shopName) {
    updateAccountShopName(accountId, '', { error: '未从拼多多商家后台识别到真实店铺名称' });
    throw new Error('未识别到真实店铺名称，请确认该账号已登录拼多多商家后台');
  }
  return updateAccountShopName(accountId, shopName, { source: 'pdd-page' });
}

async function clickFilterIfNeeded(page, text, options = {}) {
  await waitForPageGate(page, { ...options, stage: `筛选 ${text}` });
  const button = page
    .locator('[class*="evaluation_search_btn"]')
    .filter({ hasText: new RegExp(`^${escapeRegExp(text)}$`) })
    .first();

  await button.waitFor({ state: 'visible', timeout: 15000 });
  const className = await button.getAttribute('class').catch(() => '');
  if (className.includes('checked')) return;
  await safeClick(page, button, `筛选「${text}」`, { forceLast: true });
  await randomDelay(350, 800);
}

async function applyGoodReviewFilters(page, options = {}) {
  await clickFilterIfNeeded(page, reviewDaysFilterLabel(options.reviewDays), options);
  await clickFilterIfNeeded(page, '4星', options);
  await clickFilterIfNeeded(page, '5星', options);
  await clickFilterIfNeeded(page, '未回复', options);

  return waitForGoodReviewList(page, async () => {
    await waitForPageGate(page, { ...options, stage: '点击查询前检查' });
    await safeClick(page, page.locator('button:has-text("查询")'), '查询按钮', { forceLast: true });
  }, { ...options, stage: '应用评价筛选', expectedPageNo: 1 });
}

async function selectedFilters(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[class*="evaluation_search_btn_checked"]'))
    .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function readPaginationControlSnapshots(page) {
  return page.evaluate(() => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 3
        && rect.height > 3
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const rootSelectors = [
      '[class*="PGT"]',
      '[class*="pagination"]',
      '[class*="Pagination"]',
      '[class*="pager"]',
      '[class*="Pager"]',
    ].join(',');
    const roots = Array.from(document.querySelectorAll(rootSelectors))
      .filter(isVisible)
      .filter(node => /[0-9>›»下一页]/.test(normalize(node.innerText || node.textContent)));
    const scopes = roots.length ? roots : [document.body];
    const seen = new Set();
    const controls = [];

    for (const scope of scopes) {
      const nodes = [scope, ...scope.querySelectorAll('button, a, li, span, div, [role="button"]')];
      for (const node of nodes) {
        if (seen.has(node) || !isVisible(node)) continue;
        const text = normalize(node.innerText || node.textContent);
        const className = String(node.className || '');
        const ariaLabel = String(node.getAttribute?.('aria-label') || '');
        const looksLikeControl = /^[0-9]+$/.test(text)
          || ['>', '›', '»', '下一页'].includes(text)
          || /next|PGT_next|pagination|pager/i.test(`${className} ${ariaLabel}`);
        if (!looksLikeControl) continue;
        seen.add(node);
        controls.push({
          index: controls.length,
          text,
          className,
          ariaLabel,
          ariaDisabled: node.getAttribute?.('aria-disabled') || '',
          disabled: Boolean(node.disabled),
          tagName: node.tagName,
        });
      }
    }

    return controls;
  }).catch(() => []);
}

async function markPaginationControl(page, index) {
  const token = `pdd-page-control-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await page.evaluate(({ index: targetIndex, token: marker }) => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 3
        && rect.height > 3
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const rootSelectors = [
      '[class*="PGT"]',
      '[class*="pagination"]',
      '[class*="Pagination"]',
      '[class*="pager"]',
      '[class*="Pager"]',
    ].join(',');
    const roots = Array.from(document.querySelectorAll(rootSelectors))
      .filter(isVisible)
      .filter(node => /[0-9>›»下一页]/.test(normalize(node.innerText || node.textContent)));
    const scopes = roots.length ? roots : [document.body];
    const seen = new Set();
    const controls = [];

    for (const scope of scopes) {
      const nodes = [scope, ...scope.querySelectorAll('button, a, li, span, div, [role="button"]')];
      for (const node of nodes) {
        if (seen.has(node) || !isVisible(node)) continue;
        const text = normalize(node.innerText || node.textContent);
        const className = String(node.className || '');
        const ariaLabel = String(node.getAttribute?.('aria-label') || '');
        const looksLikeControl = /^[0-9]+$/.test(text)
          || ['>', '›', '»', '下一页'].includes(text)
          || /next|PGT_next|pagination|pager/i.test(`${className} ${ariaLabel}`);
        if (!looksLikeControl) continue;
        seen.add(node);
        controls.push(node);
      }
    }

    document.querySelectorAll('[data-pdd-helper-pagination]').forEach(node => {
      node.removeAttribute('data-pdd-helper-pagination');
    });

    const node = controls[targetIndex];
    if (!node) return { found: false };
    const clickable = node.closest('button, a, li, [role="button"]') || node;
    clickable.setAttribute('data-pdd-helper-pagination', marker);
    return {
      found: true,
      text: normalize(clickable.innerText || clickable.textContent),
      tagName: clickable.tagName,
      className: String(clickable.className || ''),
    };
  }, { index, token });

  if (!result.found) return null;
  return {
    locator: page.locator(`[data-pdd-helper-pagination="${token}"]`).first(),
    meta: result,
  };
}

async function readSafePaginationControlSnapshots(page) {
  return page.evaluate(() => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 3
        && rect.height > 3
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const dropdownSelectors = [
      '[role="listbox"]',
      '[role="menu"]',
      '[class*="dropdown"]',
      '[class*="Dropdown"]',
      '[class*="popover"]',
      '[class*="Popover"]',
      '[class*="select-dropdown"]',
      '[class*="SelectDropdown"]',
    ].join(',');
    const selectSelectors = [
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
      '[class*="select"]',
      '[class*="Select"]',
    ].join(',');
    const isDropdownNode = node => Boolean(node?.closest?.(dropdownSelectors));
    const isPageSizeControl = (node) => {
      const text = normalize(node?.innerText || node?.textContent);
      if (!/^[0-9]+$/.test(text)) return false;
      if (isDropdownNode(node)) return true;
      const selectNode = node.closest?.(selectSelectors);
      if (!selectNode) return false;
      const context = normalize(selectNode.parentElement?.innerText || selectNode.innerText || '');
      return /[\u6bcf\u9875\u6761]/.test(context);
    };
    const isNextText = (text = '') => {
      const value = normalize(text);
      return ['>', '\u203a', '\u00bb', '\u4e0b\u4e00\u9875'].includes(value);
    };
    const hasPaginationClass = (node) => {
      const parts = [];
      let cursor = node;
      for (let depth = 0; cursor && depth < 5; depth += 1) {
        parts.push(String(cursor.className || ''));
        cursor = cursor.parentElement;
      }
      return /PGT|pagination|pager/i.test(parts.join(' '));
    };
    const looksLikeControl = (node) => {
      const text = normalize(node.innerText || node.textContent);
      const className = String(node.className || '');
      const ariaLabel = String(node.getAttribute?.('aria-label') || '');
      const scopedAsPagination = hasPaginationClass(node);
      return (/^[0-9]+$/.test(text) && scopedAsPagination)
        || (isNextText(text) && scopedAsPagination)
        || /next|PGT_next|pagination|pager/i.test(`${className} ${ariaLabel}`);
    };
    const clickableFor = node => node.closest?.('button, a, li, [role="button"]') || node;
    const countControls = (root) => {
      const nodes = Array.from(root.querySelectorAll('button, a, li, span, div, [role="button"]'));
      let numbers = 0;
      let next = 0;
      for (const node of nodes) {
        if (!isVisible(node) || isDropdownNode(node) || isPageSizeControl(node)) continue;
        const text = normalize(node.innerText || node.textContent);
        const className = String(node.className || '');
        const ariaLabel = String(node.getAttribute?.('aria-label') || '');
        if (/^[0-9]+$/.test(text)) numbers += 1;
        if (isNextText(text) || /next|PGT_next/i.test(`${className} ${ariaLabel}`)) next += 1;
      }
      return { numbers, next };
    };
    const rootSelectors = [
      '[class*="PGT"]',
      '[class*="pagination"]',
      '[class*="Pagination"]',
      '[class*="pager"]',
      '[class*="Pager"]',
    ].join(',');
    const rootCandidates = [
      ...Array.from(document.querySelectorAll(rootSelectors)),
      ...Array.from(document.querySelectorAll('nav, ul, ol, div')),
    ];
    const scoredRoots = [];
    const rootSeen = new Set();
    for (const root of rootCandidates) {
      if (rootSeen.has(root) || root === document.body || !isVisible(root) || isDropdownNode(root)) continue;
      rootSeen.add(root);
      const text = normalize(root.innerText || root.textContent);
      const { numbers, next } = countControls(root);
      const hasPaginationWords = /pagination|pager|PGT/i.test(String(root.className || ''))
        || /[\u5171\u6bcf\u9875\u6761]/.test(text);
      const score = numbers * 2 + next * 4 + (hasPaginationWords ? 3 : 0);
      if (numbers >= 2 && (next > 0 || hasPaginationWords)) {
        const rect = root.getBoundingClientRect();
        scoredRoots.push({ root, score, y: rect.y, height: rect.height });
      }
    }
    const scopes = scoredRoots
      .sort((a, b) => b.score - a.score || b.y - a.y || a.height - b.height)
      .slice(0, 4)
      .map(item => item.root);
    const seen = new Set();
    const controls = [];

    document.querySelectorAll('[data-pdd-helper-pagination-index]').forEach(node => {
      node.removeAttribute('data-pdd-helper-pagination-index');
    });

    for (const scope of scopes) {
      const nodes = [scope, ...scope.querySelectorAll('button, a, li, span, div, [role="button"]')];
      for (const node of nodes) {
        if (!isVisible(node) || isDropdownNode(node) || isPageSizeControl(node) || !looksLikeControl(node)) continue;
        const clickable = clickableFor(node);
        if (seen.has(clickable) || !isVisible(clickable) || isDropdownNode(clickable) || isPageSizeControl(clickable)) continue;
        seen.add(clickable);
        const rect = clickable.getBoundingClientRect();
        const className = String(clickable.className || '');
        const active = String(clickable.getAttribute?.('aria-current') || '').toLowerCase() === 'page'
          || /active|current|checked|selected/i.test(className);
        clickable.setAttribute('data-pdd-helper-pagination-index', String(controls.length));
        controls.push({
          index: controls.length,
          text: normalize(clickable.innerText || clickable.textContent),
          className,
          ariaLabel: String(clickable.getAttribute?.('aria-label') || ''),
          ariaDisabled: clickable.getAttribute?.('aria-disabled') || '',
          disabled: Boolean(clickable.disabled),
          tagName: clickable.tagName,
          source: 'pagination',
          inPaginationRoot: true,
          inDropdown: false,
          inPageSizeControl: false,
          active,
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    }

    return controls;
  }).catch(() => []);
}

async function markSafePaginationControl(page, index) {
  const token = `pdd-page-control-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await page.evaluate(({ index: targetIndex, token: marker }) => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const node = document.querySelector(`[data-pdd-helper-pagination-index="${targetIndex}"]`);
    if (!node || !node.getBoundingClientRect) return { found: false };
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (rect.width <= 3 || rect.height <= 3 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return { found: false };
    }
    document.querySelectorAll('[data-pdd-helper-pagination]').forEach(item => {
      item.removeAttribute('data-pdd-helper-pagination');
    });
    node.setAttribute('data-pdd-helper-pagination', marker);
    return {
      found: true,
      text: normalize(node.innerText || node.textContent),
      tagName: node.tagName,
      className: String(node.className || ''),
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }, { index, token });

  if (!result.found) return null;
  return {
    locator: page.locator(`[data-pdd-helper-pagination="${token}"]`).first(),
    meta: result,
  };
}

async function readOpenPaginationDropdowns(page) {
  return page.evaluate(() => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      '[role="listbox"]',
      '[class*="dropdown"]',
      '[class*="Dropdown"]',
      '[class*="select-dropdown"]',
      '[class*="SelectDropdown"]',
    ].join(',');
    return Array.from(document.querySelectorAll(selectors))
      .map(node => {
        if (!node.getBoundingClientRect) return null;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (rect.width <= 3 || rect.height <= 3 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
        return {
          text: normalize(node.innerText || node.textContent).slice(0, 80),
          className: String(node.className || '').slice(0, 120),
          box: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter(Boolean)
      .slice(0, 8);
  }).catch(() => []);
}

async function readPaginationDiagnostics(page, {
  targetPageNo,
  snapshots,
  pick,
  clicked,
} = {}) {
  const controls = snapshots || await readSafePaginationControlSnapshots(page);
  const active = controls.find(item => item.active);
  return {
    targetPageNo: targetPageNo ? Number(targetPageNo) : undefined,
    activePageNo: active && /^[0-9]+$/.test(normalizeVisibleText(active.text)) ? Number(normalizeVisibleText(active.text)) : undefined,
    selected: pick || null,
    clicked: clicked || null,
    openDropdowns: await readOpenPaginationDropdowns(page),
    controls: controls.slice(0, 30).map(item => ({
      index: item.index,
      text: item.text,
      className: String(item.className || '').slice(0, 120),
      ariaLabel: item.ariaLabel,
      disabled: item.disabled,
      active: item.active,
      source: item.source,
      box: item.box,
    })),
  };
}

function attachPaginationDiagnostics(error, diagnostics) {
  if (diagnostics) error.paginationDiagnostics = diagnostics;
  return error;
}

async function clickNextPage(page, targetPageNo) {
  await page.keyboard.press('Escape').catch(() => {});
  await randomDelay(120, 260);
  await dismissAllPopups(page);
  const snapshots = await readSafePaginationControlSnapshots(page);
  const pick = pickPaginationControlSnapshot(snapshots, targetPageNo);
  if (!pick) {
    const seen = snapshots.map(item => `${item.index}:${item.text || item.ariaLabel || item.className}`).slice(0, 12).join(' | ');
    throw new Error(`未找到可用分页控件（目标页 ${targetPageNo || '下一页'}；已识别：${seen || '无'}）`);
  }

  const marked = await markSafePaginationControl(page, pick.index);
  if (!marked) {
    throw new Error(`分页控件已变化，无法点击目标页 ${targetPageNo || '下一页'}`);
  }

  await safeClick(page, marked.locator, `翻到第 ${targetPageNo || '下一'} 页`, { forceLast: true });
  return true;
}

async function collectFilteredReviews(page, options = {}) {
  await ensureReviewPage(page, options);
  const firstPage = await applyGoodReviewFilters(page, options);
  const filters = await selectedFilters(page);
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const totalRows = firstPage.totalRows;
  const totalPages = reviewPageCountForRows({
    totalRows,
    displayRows: firstPage.displayRows,
    pageSize,
    maxPages: options.maxPages,
  });
  const reviews = [...firstPage.pageReviews];

  for (let pageNo = 2; pageNo <= totalPages; pageNo++) {
    if (isStopped(options.stopSignal)) break;
    const pageData = await waitForGoodReviewList(page, async () => {
      const moved = await clickNextPage(page, pageNo);
      if (!moved) throw new Error(`无法翻到第 ${pageNo} 页`);
    }, { ...options, stage: `翻到第 ${pageNo} 页`, expectedPageNo: pageNo, expectedPageSize: pageSize });
    reviews.push(...pageData.pageReviews);
    await randomDelay(900, 1800);
  }

  return { reviews, totalRows, displayRows: firstPage.displayRows, filters };
}

async function markOrderSearchInput(page) {
  const token = `pdd-order-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const exactInput = page.locator(orderSearchInputLocator()).first();
  if (await exactInput.isVisible({ timeout: 1200 }).catch(() => false)) {
    await exactInput.evaluate((node, marker) => {
      document.querySelectorAll('[data-pdd-helper-order-input]').forEach(item => {
        item.removeAttribute('data-pdd-helper-order-input');
      });
      document.querySelectorAll('[data-pdd-helper-order-form]').forEach(item => {
        item.removeAttribute('data-pdd-helper-order-form');
      });
      node.setAttribute('data-pdd-helper-order-input', marker);
      const form = node.closest('form');
      if (form) form.setAttribute('data-pdd-helper-order-form', marker);
    }, token);
    return {
      locator: page.locator(`[data-pdd-helper-order-input="${token}"]`).first(),
      token,
      strategy: 'verified-xpath',
    };
  }

  const result = await page.evaluate(({ token: marker }) => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 20
        && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const scoreInput = (input) => {
      const parentText = normalize(input.closest('label, div, form, section')?.innerText || '');
      const text = [
        input.placeholder,
        input.name,
        input.id,
        input.getAttribute('aria-label'),
        input.className,
        parentText.slice(0, 120),
      ].map(normalize).join(' ');
      let score = 0;
      if (/订单编号|订单号|订单|orderSn|order/i.test(text)) score += 10;
      if (/搜索|查询|请输入|输入/.test(text)) score += 2;
      if (/评价|商品|买家|昵称|内容/.test(text)) score -= 3;
      return score;
    };

    document.querySelectorAll('[data-pdd-helper-order-input]').forEach(node => {
      node.removeAttribute('data-pdd-helper-order-input');
    });
    document.querySelectorAll('[data-pdd-helper-order-form]').forEach(node => {
      node.removeAttribute('data-pdd-helper-order-form');
    });

    const candidates = Array.from(document.querySelectorAll('input'))
      .filter(input => isVisible(input) && !input.disabled && input.type !== 'hidden')
      .map(input => ({ input, score: scoreInput(input) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const picked = candidates[0]?.input;
    if (!picked) return { found: false, count: candidates.length };
    picked.setAttribute('data-pdd-helper-order-input', marker);
    const form = picked.closest('form');
    if (form) form.setAttribute('data-pdd-helper-order-form', marker);
    return {
      found: true,
      count: candidates.length,
      placeholder: picked.placeholder || '',
      name: picked.name || '',
    };
  }, { token });

  if (!result.found) return null;
  return {
    locator: page.locator(`[data-pdd-helper-order-input="${token}"]`).first(),
    token,
    strategy: 'heuristic',
    meta: result,
  };
}

async function fillOrderSearchInput(page, orderNo) {
  const input = await markOrderSearchInput(page);
  if (!input) return null;
  await input.locator.fill(String(orderNo || ''));
  return input;
}

async function findOrderSearchQueryButton(page, token) {
  const formScoped = token
    ? page.locator(`[data-pdd-helper-order-form="${token}"] button`).filter({ hasText: '查询' }).first()
    : null;
  if (formScoped && await formScoped.isVisible({ timeout: 600 }).catch(() => false)) {
    return { locator: formScoped, strategy: 'same-form' };
  }

  const nearbyToken = `pdd-order-query-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await page.evaluate(({ inputToken, buttonToken }) => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 5
        && rect.height > 5
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const input = document.querySelector(`[data-pdd-helper-order-input="${inputToken}"]`);
    const inputRect = input?.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(node => isVisible(node) && normalize(node.innerText || node.textContent) === '查询');

    document.querySelectorAll('[data-pdd-helper-order-query]').forEach(node => {
      node.removeAttribute('data-pdd-helper-order-query');
    });

    if (!inputRect) return { found: false, count: buttons.length };
    const candidates = buttons
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const sameRow = Math.abs((rect.top + rect.bottom) / 2 - (inputRect.top + inputRect.bottom) / 2) < 80;
        const distance = Math.abs(rect.left - inputRect.right) + Math.abs(rect.top - inputRect.top);
        return { button, sameRow, distance };
      })
      .filter(item => item.sameRow)
      .sort((a, b) => a.distance - b.distance);

    const picked = candidates[0]?.button || buttons[0];
    if (!picked) return { found: false, count: buttons.length };
    picked.setAttribute('data-pdd-helper-order-query', buttonToken);
    return { found: true, count: buttons.length, sameRow: Boolean(candidates[0]) };
  }, { inputToken: token, buttonToken: nearbyToken });

  if (result.found) {
    return {
      locator: page.locator(`[data-pdd-helper-order-query="${nearbyToken}"]`).first(),
      strategy: result.sameRow ? 'same-row' : 'fallback-visible-query',
      meta: result,
    };
  }

  return {
    locator: page.locator('button:has-text("查询")').first(),
    strategy: 'global-fallback',
    meta: result,
  };
}

function findMatchingReview(pageReviews = [], targetReview = {}) {
  return pageReviews.find(review => sameReviewIdentity(review, targetReview)) || null;
}

function mergeLiveReview(targetReview = {}, liveReview = {}) {
  return {
    ...targetReview,
    ...liveReview,
    id: liveReview.id || targetReview.id,
    reviewId: liveReview.reviewId || targetReview.reviewId || targetReview.id,
    orderNo: liveReview.orderNo || targetReview.orderNo || targetReview.orderSn || '',
    flagged: Boolean(targetReview.flagged || liveReview.flagged),
    flagReason: targetReview.flagReason || liveReview.flagReason || '',
    uncertainSkip: Boolean(targetReview.uncertainSkip || liveReview.uncertainSkip),
    uncertainReason: targetReview.uncertainReason || liveReview.uncertainReason || '',
    neutralReply: Boolean(targetReview.neutralReply || liveReview.neutralReply),
    neutralReason: targetReview.neutralReason || liveReview.neutralReason || '',
    sentimentLabel: targetReview.sentimentLabel || liveReview.sentimentLabel || '',
    riskWords: targetReview.riskWords || liveReview.riskWords || [],
    safePositiveWords: targetReview.safePositiveWords || liveReview.safePositiveWords || [],
    replyBlocked: Boolean(targetReview.replyBlocked || liveReview.replyBlocked),
    skipReason: targetReview.skipReason || liveReview.skipReason || '',
  };
}

async function locateReviewByOrderNo(page, review, options = {}) {
  const orderNo = normalizeVisibleText(review.orderNo || review.orderSn);
  if (!orderNo) return null;

  await ensureReviewPage(page, options);
  await applyGoodReviewFilters(page, options);

  const orderInput = await fillOrderSearchInput(page, orderNo);
  if (!orderInput) {
    throw new Error('未找到订单编号输入框，无法按订单编号搜索评价');
  }
  emitProgress(options.onProgress, {
    status: 'single-reply-order-input',
    stage: '订单编号输入',
    orderSn: orderNo,
    inputStrategy: orderInput.strategy,
    inputMeta: orderInput.meta,
  });
  const queryButton = await findOrderSearchQueryButton(page, orderInput.token);

  const pageData = await waitForGoodReviewList(page, async () => {
    await waitForPageGate(page, { ...options, stage: '按订单编号搜索评价' });
    emitProgress(options.onProgress, {
      status: 'single-reply-order-query',
      stage: '点击订单编号查询',
      orderSn: orderNo,
      inputStrategy: orderInput.strategy,
      queryStrategy: queryButton.strategy,
      queryMeta: queryButton.meta,
    });
    await safeClick(page, queryButton.locator, '订单编号查询按钮', { forceLast: true });
  }, {
    ...options,
    stage: '按订单编号搜索评价',
    responseMatcher: requestMatchesGoodReviewOrderSearch(orderNo),
    expectedPageNo: 1,
  });

  const matched = findMatchingReview(pageData.pageReviews, review)
    || pageData.pageReviews.find(item => normalizeVisibleText(item.orderNo || item.orderSn) === orderNo)
    || (pageData.pageReviews.length === 1 ? pageData.pageReviews[0] : null);

  return {
    strategy: 'order-search',
    pageData,
    preferSingleVisibleResult: pageData.pageReviews.length === 1,
    review: matched ? mergeLiveReview(review, matched) : null,
  };
}

async function locateReviewByFilteredPages(page, review, options = {}) {
  await fillOrderSearchInput(page, '').catch(() => false);
  const firstPage = await applyGoodReviewFilters(page, options);
  const pageSize = Number(options.pageSize || firstPage.requestBody?.pageSize || DEFAULT_PAGE_SIZE);
  const totalPages = reviewPageCountForRows({
    totalRows: firstPage.totalRows,
    displayRows: firstPage.displayRows,
    pageSize,
    maxPages: options.maxPages,
  });
  let pageData = firstPage;

  for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
    const matched = findMatchingReview(pageData.pageReviews, review);
    if (matched) {
      return {
        strategy: pageNo === 1 ? 'filtered-first-page' : 'filtered-pagination',
        pageNo,
        pageCount: totalPages,
        pageData,
        review: mergeLiveReview(review, matched),
      };
    }
    if (pageNo >= totalPages) break;
    pageData = await waitForGoodReviewList(page, async () => {
      const moved = await clickNextPage(page, pageNo + 1);
      if (!moved) throw new Error(`无法翻到第 ${pageNo + 1} 页`);
    }, { ...options, stage: `定位单条评价第 ${pageNo + 1} 页`, expectedPageNo: pageNo + 1, expectedPageSize: pageSize });
  }

  return {
    strategy: 'filtered-pagination',
    pageNo: totalPages,
    pageCount: totalPages,
    pageData,
    review: null,
  };
}

async function analyzeAndMark(review) {
  if (review.stars < 4) return review;
  const sentiment = await analyzeSentiment(review.content, review.stars, {
    productName: review.productName || '',
    userName: review.userName || '',
    shopName: review.shopName || '',
  });
  return {
    ...review,
    flagged: Boolean(sentiment.flagged),
    flagReason: sentiment.reason || '',
    uncertainSkip: Boolean(sentiment.uncertain),
    uncertainReason: sentiment.uncertain ? (sentiment.reason || '评价无法判断，已跳过自动回复') : '',
    neutralReply: Boolean(sentiment.neutral),
    neutralReason: sentiment.neutral ? (sentiment.reason || '中性评价，使用保守回复') : '',
    sentimentLabel: sentiment.label || '',
    riskWords: sentiment.riskWords || sentiment.risk_words || [],
    safePositiveWords: sentiment.safePositiveWords || sentiment.safe_positive_words || [],
  };
}

function markLocalRiskOnly(review) {
  if (review.stars < 4) return review;
  const sentiment = detectLocalRiskSentiment(review.content);
  if (!sentiment.flagged && !sentiment.uncertain) {
    return {
      ...review,
      flagged: false,
      flagReason: '',
      uncertainSkip: false,
      uncertainReason: '',
      neutralReply: Boolean(sentiment.neutral),
      neutralReason: sentiment.neutral ? (sentiment.reason || '中性评价，使用保守回复') : '',
      sentimentLabel: sentiment.label || 'positive_auto_reply',
      riskWords: [],
      safePositiveWords: sentiment.safePositiveWords || sentiment.safe_positive_words || [],
    };
  }
  return {
    ...review,
    flagged: Boolean(sentiment.flagged),
    flagReason: sentiment.reason || '',
    uncertainSkip: Boolean(sentiment.uncertain),
    uncertainReason: sentiment.uncertain ? (sentiment.reason || '评价无法判断，已跳过自动回复') : '',
    neutralReply: false,
    neutralReason: '',
    sentimentLabel: sentiment.label || '',
    riskWords: sentiment.riskWords || sentiment.risk_words || [],
    safePositiveWords: sentiment.safePositiveWords || sentiment.safe_positive_words || [],
  };
}

async function findReviewAction(page, review, { preferSingleVisibleResult = false } = {}) {
  const hints = buildReviewActionHints(review);
  const token = `pdd-reply-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await page.evaluate(({ hints: searchHints, token: marker, preferSingle }) => {
    const normalize = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();
    const compact = (text = '') => String(text || '').replace(/\s+/g, '');
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 3
        && rect.height > 3
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const textMatchesReplyAction = (node) => compact(node.innerText || node.textContent) === '回复/互动';
    const actionNodes = Array.from(document.querySelectorAll('a, button, span, [role="button"]'))
      .filter(node => isVisible(node) && textMatchesReplyAction(node))
      .map(node => node.closest('a, button, [role="button"]') || node)
      .filter(isVisible);
    const actions = [...new Set(actionNodes)];

    document.querySelectorAll('[data-pdd-helper-reply-action]').forEach(node => {
      node.removeAttribute('data-pdd-helper-reply-action');
    });

    const pickForHint = (hint) => {
      const needle = normalize(hint);
      if (!needle) return null;
      let best = null;
      for (const action of actions) {
        let node = action;
        while (node && node !== document.body) {
          const text = normalize(node.innerText || node.textContent);
          if (text.includes(needle)) {
            const rect = node.getBoundingClientRect();
            const area = Math.max(1, rect.width) * Math.max(1, rect.height);
            if (!best || area < best.area) {
              best = { action, area, hint: needle, containerText: text.slice(0, 160) };
            }
            break;
          }
          node = node.parentElement;
        }
      }
      return best;
    };

    const pickSingleResultAction = () => {
      if (!preferSingle || actions.length === 0) return null;
      const pageText = normalize(document.body.innerText || document.body.textContent);
      const singleResult = /共查询到\s*1\s*条数据/.test(pageText) || /共有\s*1\s*条/.test(pageText);
      if (!singleResult) return null;

      let best = null;
      for (const action of actions) {
        let node = action;
        while (node && node !== document.body) {
          const text = normalize(node.innerText || node.textContent);
          const hasOrderHint = searchHints.some(hint => hint && text.includes(normalize(hint)));
          const hasReviewShape = /用户评价分|订单编号|评价标签/.test(text);
          if (hasOrderHint || hasReviewShape) {
            const rect = node.getBoundingClientRect();
            const area = Math.max(1, rect.width) * Math.max(1, rect.height);
            if (!best || area < best.area) {
              best = { action, area, hint: hasOrderHint ? 'single-result-hint' : 'single-result-row' };
            }
            break;
          }
          node = node.parentElement;
        }
      }
      return best || (actions.length === 1 ? { action: actions[0], area: 1, hint: 'single-visible-action' } : null);
    };

    for (const hint of searchHints) {
      const matched = pickForHint(hint);
      if (matched) {
        matched.action.setAttribute('data-pdd-helper-reply-action', marker);
        return {
          found: true,
          hint: matched.hint,
          actionText: normalize(matched.action.innerText || matched.action.textContent),
          tagName: matched.action.tagName,
          actionCount: actions.length,
        };
      }
    }

    const singleResultMatch = pickSingleResultAction();
    if (singleResultMatch) {
      singleResultMatch.action.setAttribute('data-pdd-helper-reply-action', marker);
      return {
        found: true,
        hint: singleResultMatch.hint,
        actionText: normalize(singleResultMatch.action.innerText || singleResultMatch.action.textContent),
        tagName: singleResultMatch.action.tagName,
        actionCount: actions.length,
        strategy: 'single-result',
      };
    }

    if (actions.length === 1) {
      actions[0].setAttribute('data-pdd-helper-reply-action', marker);
      return {
        found: true,
        hint: '',
        actionText: normalize(actions[0].innerText || actions[0].textContent),
          tagName: actions[0].tagName,
          actionCount: actions.length,
          strategy: 'single-action',
        };
      }

    return {
      found: false,
      actionCount: actions.length,
      hints: searchHints,
    };
  }, { hints, token, preferSingle: preferSingleVisibleResult });

  if (!result.found) {
    const identity = hints[0] || review.reviewId || review.orderNo || '未知评价';
    throw new Error(`未找到评价 ${identity} 所在行的回复/互动入口（页面可见入口 ${result.actionCount || 0} 个）`);
  }

  return {
    locator: page.locator(`[data-pdd-helper-reply-action="${token}"]`).first(),
    meta: result,
  };
}

async function readTextareaSnapshots(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('textarea')).map((node) => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return {
      width: rect.width,
      height: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      withinFeedback: Boolean(node.closest('[class*="feedback"], [class*="Feedback"]')),
    };
  })).catch(() => []);
}

async function waitForVisibleReplyTextarea(page, timeout = 12000) {
  const startedAt = Date.now();
  let lastSummary = describeTextareaSnapshots([]);

  while (Date.now() - startedAt < timeout) {
    lastSummary = describeTextareaSnapshots(await readTextareaSnapshots(page));
    if (lastSummary.visibleReply > 0) return lastSummary;
    await delay(250);
  }

  throw new Error(`未出现可见的回复输入框（textarea 总数 ${lastSummary.total}，隐藏 ${lastSummary.hidden}，反馈框 ${lastSummary.feedback}）`);
}

async function waitForNoVisibleReplyTextarea(page, timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const summary = describeTextareaSnapshots(await readTextareaSnapshots(page));
    if (summary.visibleReply === 0) return true;
    await delay(200);
  }
  return false;
}

async function openReplyDialogForReview(page, review, options = {}) {
  await waitForPageGate(page, { ...options, stage: '点击回复前检查' });
  await dismissAllPopups(page);
  const { locator: action, meta } = await findReviewAction(page, review, {
    preferSingleVisibleResult: Boolean(options.preferSingleVisibleResult),
  });
  emitProgress(options.onProgress, {
    status: 'reply-action-click',
    stage: '点击回复入口',
    reviewId: review.reviewId,
    orderSn: review.orderNo,
    actionHint: meta.hint,
    actionTag: meta.tagName,
    actionCount: meta.actionCount,
    actionStrategy: meta.strategy,
  });
  await safeClick(page, action, `评价 ${review.reviewId || review.orderNo} 的回复入口`, { forceLast: true });
  try {
    await waitForVisibleReplyTextarea(page, 12000);
  } catch (err) {
    await waitForPageGate(page, { ...options, stage: '回复弹窗检查' });
    await dismissAllPopups(page);
    const retry = await findReviewAction(page, review, {
      preferSingleVisibleResult: Boolean(options.preferSingleVisibleResult),
    });
    await safeClick(page, retry.locator, `评价 ${review.reviewId || review.orderNo} 的回复入口重试`, { forceLast: true });
    await waitForVisibleReplyTextarea(page, 8000);
  }
  await randomDelay(700, 1300);
}

async function setVisibleTextareaValue(page, value) {
  const filled = await page.evaluate((replyText) => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 30 && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };

    const candidates = Array.from(document.querySelectorAll('textarea'))
      .filter(isVisible)
      .filter(node => !node.closest('[class*="feedback"], [class*="Feedback"]'));
    const textarea = candidates.at(-1);
    if (!textarea) return false;

    textarea.removeAttribute('disabled');
    textarea.disabled = false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, replyText);
    else textarea.value = replyText;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.focus();
    return true;
  }, value);

  if (!filled) throw new Error('未找到可填写的回复输入框');
}

async function fillVisibleReplyTextarea(page, value) {
  const token = `pdd-reply-textarea-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const target = await page.evaluate((marker) => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 30 && rect.height > 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };

    const candidates = Array.from(document.querySelectorAll('textarea'))
      .filter(isVisible)
      .filter(node => !node.closest('[class*="feedback"], [class*="Feedback"]'));
    const textarea = candidates.at(-1);
    if (!textarea) {
      return {
        found: false,
        summary: {
          total: document.querySelectorAll('textarea').length,
          visibleReply: 0,
        },
      };
    }

    textarea.removeAttribute('disabled');
    textarea.disabled = false;
    textarea.setAttribute('data-pdd-helper-reply-textarea', marker);
    return {
      found: true,
      summary: {
        total: document.querySelectorAll('textarea').length,
        visibleReply: candidates.length,
      },
    };
  }, token);

  if (!target.found) {
    throw new Error(`未找到可填写的回复输入框（textarea 总数 ${target.summary?.total || 0}，可见回复框 ${target.summary?.visibleReply || 0}）`);
  }

  const locator = page.locator(`[data-pdd-helper-reply-textarea="${token}"]`).first();
  await locator.fill(value, { timeout: 10000 }).catch(async () => {
    await locator.evaluate((textarea, replyText) => {
      textarea.removeAttribute('disabled');
      textarea.disabled = false;
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(textarea, replyText);
      else textarea.value = replyText;
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  });

  const state = await locator.evaluate((textarea) => ({
    value: textarea.value || '',
    textContent: textarea.textContent || '',
    innerText: textarea.innerText || '',
  }));

  if (state.value !== value) {
    await locator.evaluate((textarea, replyText) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(textarea, replyText);
      else textarea.value = replyText;
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.focus();
    }, value);
  }

  const verified = await locator.evaluate((textarea) => textarea.value || '');
  if (verified !== value) {
    throw new Error(`回复输入框写入校验失败（期望 ${value.length} 字，实际 ${verified.length} 字）`);
  }

  return {
    chars: value.length,
    valueLength: verified.length,
    visibleReplyInputs: target.summary.visibleReply,
    textareaTotal: target.summary.total,
  };
}

async function collectReplySubmitMessages(page) {
  return page.evaluate(() => {
    const pattern = /(不可评论|不支持回复|暂不支持回复|不能回复|无法回复|评价已关闭|评论已关闭|已设置为不可评论|回复成功|提交成功|操作成功)/;
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };

    return [...new Set(Array.from(document.querySelectorAll('body *'))
      .filter(isVisible)
      .map(node => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(text => text && text.length <= 160 && pattern.test(text)))];
  }).catch(() => []);
}

async function waitForReplySubmitFeedback(page, timeout = 3600) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const messages = await collectReplySubmitMessages(page);
    for (const message of messages) {
      const classified = classifyReplySubmitMessage(message);
      if (classified) return classified;
    }
    await delay(250);
  }
  return null;
}

async function submitVisibleReplyDialog(page) {
  const modal = page.locator('[class*="modal"], [class*="dialog"], [class*="drawer"]').filter({
    has: page.locator('textarea'),
  }).last();
  const button = modal.locator('button').filter({ hasText: /^(回复|提交|确认)$/ }).last();
  await safeClick(page, button, '回复提交按钮', { forceLast: true });
  const feedback = await waitForReplySubmitFeedback(page);
  await randomDelay(600, 1000);
  return feedback;
}

async function closeReplyDialog(page) {
  const clickedClose = await page.evaluate(() => {
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 3
        && rect.height > 3
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const textarea = Array.from(document.querySelectorAll('textarea')).find(node => {
      if (!isVisible(node)) return false;
      return !node.closest('[class*="feedback"], [class*="Feedback"]');
    });
    if (!textarea) return false;

    const container = textarea.closest([
      '[role="dialog"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="dialog"]',
      '[class*="Dialog"]',
      '[class*="drawer"]',
      '[class*="Drawer"]',
    ].join(','));
    if (!container) return false;

    const closeControl = Array.from(container.querySelectorAll([
      '[data-testid="beast-core-modal-icon-close"]',
      '[class*="beast-core-modal-icon-close"]',
      '[class*="close"]',
      '[class*="Close"]',
      '[aria-label*="关闭"]',
      '[aria-label*="close" i]',
      'button',
      '[role="button"]',
      'span',
    ].join(','))).find(node => {
      if (!isVisible(node)) return false;
      const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = String(node.getAttribute('aria-label') || '');
      return /关闭|取消|×|close/i.test(`${text} ${aria}`)
        || /close/i.test(String(node.className || ''));
    });

    if (!closeControl) return false;
    closeControl.click();
    return true;
  }).catch(() => false);

  if (!clickedClose) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await randomDelay(300, 700);
  if (!(await waitForNoVisibleReplyTextarea(page, 4000))) {
    await page.keyboard.press('Escape').catch(() => {});
    await waitForNoVisibleReplyTextarea(page, 2500);
  }
  await dismissAllPopups(page);
}

async function submitReplyForReview(page, review, replyText, {
  dryRun = false,
  onProgress,
  stopSignal,
  preferSingleVisibleResult = false,
  captureFillScreenshot = false,
  captureNetwork = false,
} = {}) {
  const networkProbe = captureNetwork ? createReplyNetworkProbe(page) : null;
  try {
    await openReplyDialogForReview(page, review, { onProgress, stopSignal, preferSingleVisibleResult });
    const fillResult = await fillVisibleReplyTextarea(page, replyText);
    emitProgress(onProgress, {
      status: 'reply-filled',
      stage: '回复内容写入校验',
      reviewId: review.reviewId,
      orderSn: review.orderNo,
      fillResult,
    });

    if (dryRun) {
      await randomDelay(1800, 2600);
      const filledScreenshot = captureFillScreenshot
        ? await captureStageScreenshot(page, review, 'filled').catch(() => '')
        : '';
      await closeReplyDialog(page);
      const networkRequests = networkProbe ? await networkProbe.stop() : [];
      return {
        submitted: false,
        dryRun: true,
        fillResult,
        filledScreenshot,
        networkRequests,
      };
    }

    const submitFeedback = await submitVisibleReplyDialog(page);
    const networkRequests = networkProbe ? await networkProbe.stop() : [];
    if (submitFeedback?.status === 'skip') {
      return {
        submitted: false,
        dryRun: false,
        blocked: true,
        reason: submitFeedback.reason,
        message: submitFeedback.message,
        fillResult,
        networkRequests,
      };
    }
    return {
      submitted: true,
      dryRun: false,
      fillResult,
      submitFeedback,
      networkRequests,
    };
  } catch (err) {
    if (networkProbe) err.networkRequests = await networkProbe.stop().catch(() => []);
    throw err;
  }
}

async function captureFailureScreenshot(page, review) {
  return captureStageScreenshot(page, review, 'failure');
}

async function captureStageScreenshot(page, review, stage) {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const safeId = String(review.reviewId || review.orderNo || Date.now()).replace(/[^\w.-]+/g, '_').slice(0, 80);
  const safeStage = String(stage || 'stage').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const file = join(SCREENSHOT_DIR, `${safeStage}-${safeId}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function formatBrowserLaunchError(err) {
  const details = [
    err?.message || '',
    ...(Array.isArray(err?.log) ? err.log : []),
  ].join('\n');

  if (/user-data-dir|profile|Target page, context or browser has been closed|另一个|already.*open|already.*running/i.test(details)) {
    const wrapped = new Error('无法启动浏览器：持久登录目录可能正被旧的助手浏览器窗口占用。请关闭旧的助手浏览器窗口后再重试；如果仍失败，请在任务管理器结束残留的 msedge.exe。');
    wrapped.cause = err;
    return wrapped;
  }

  return err instanceof Error ? err : new Error(String(err));
}

function isBrowserContextUsable(ctx) {
  if (!ctx) return false;
  try {
    ctx.pages();
    return true;
  } catch {
    return false;
  }
}

export async function initBrowser(options = {}) {
  const accountId = normalizeAccountId(options.accountId);
  if (browserAccountId !== accountId) {
    await closeBrowser();
  }
  if (isBrowserContextUsable(browserContext)) return browserContext;
  browserContext = null;
  try {
    const ctx = await chromium.launchPersistentContext(browserDataDirForAccount(accountId), {
      channel: 'msedge',
      headless: false,
      viewport: { width: 1400, height: 900 },
    });
    browserContext = ctx;
    browserAccountId = accountId;
    ctx.once?.('close', () => {
      if (browserContext === ctx) browserContext = null;
    });
  } catch (err) {
    throw formatBrowserLaunchError(err);
  }
  return browserContext;
}

export async function closeBrowser() {
  const ctx = browserContext;
  browserContext = null;
  if (ctx) await ctx.close();
}

export async function fetchReviews(options = {}) {
  const ctx = await initBrowser(options);
  const page = ctx.pages()[0] || await ctx.newPage();
  const { reviews, totalRows, displayRows, filters } = await collectFilteredReviews(page, options);
  const analyzed = [];

  for (const review of reviews) {
    if (isStopped(options.stopSignal)) break;
    analyzed.push(options.analyzeOnFetch ? await analyzeAndMark(review) : markLocalRiskOnly(review));
  }

  return analyzed.map(review => ({
    ...review,
    totalRows,
    displayRows,
    filters,
  }));
}

export async function submitReply(replyText) {
  const ctx = await initBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();
  await fillVisibleReplyTextarea(page, replyText);
  const submitFeedback = await submitVisibleReplyDialog(page);
  if (submitFeedback?.status === 'skip') {
    throw new Error(submitFeedback.reason);
  }
  return true;
}

export async function submitReplyForStoredReview(review, replyText, options = {}) {
  const ctx = await initBrowser(options);
  const pages = ctx.pages();
  const page = pages.find(item => item.url().includes('/goods/evaluation/index'))
    || pages[0]
    || await ctx.newPage();

  const byOrder = await locateReviewByOrderNo(page, review, options).catch(err => {
    emitProgress(options.onProgress, {
      status: 'single-reply-locate-retry',
      stage: '订单编号搜索失败，回退分页定位',
      reviewId: review.reviewId || review.id,
      orderSn: review.orderNo || review.orderSn,
      reason: err.message,
    });
    return null;
  });
  const located = byOrder?.review ? byOrder : await locateReviewByFilteredPages(page, review, options);

  if (!located?.review) {
    throw new Error('当前拼多多未回复列表中找不到这条评价，可能已经回复、不可回复，或已不在近90天 4/5 星未回复筛选范围；请先点击“抓取最新评价”刷新状态。');
  }

  const liveReview = located.review;
  const decision = shouldAutoReplyReview(liveReview);
  if (!decision.ok) {
    return {
      submitted: false,
      skipped: true,
      blocked: classifyReviewStatus(liveReview) === 'blocked',
      reviewStatus: classifyReviewStatus(liveReview),
      reason: decision.reason,
      review: liveReview,
      strategy: located.strategy,
    };
  }

  const result = await submitReplyForReview(page, liveReview, replyText, {
    ...options,
    dryRun: false,
    preferSingleVisibleResult: Boolean(located.preferSingleVisibleResult),
  });
  return {
    ...result,
    review: liveReview,
    strategy: located.strategy,
  };
}

export async function replyAll(genReply, onProgress, options = {}) {
  const ctx = await initBrowser(options);
  const page = ctx.pages()[0] || await ctx.newPage();
  const requestedMaxCount = Number(options.maxCount || 0);
  const dryRun = Boolean(options.dryRun);

  const firstPage = await (async () => {
    await ensureReviewPage(page, { onProgress, stopSignal: options.stopSignal, reviewDays: options.reviewDays });
    return applyGoodReviewFilters(page, { onProgress, stopSignal: options.stopSignal, reviewDays: options.reviewDays });
  })();

  const totalTarget = requestedMaxCount > 0
    ? Math.min(firstPage.totalRows, requestedMaxCount)
    : firstPage.totalRows;
  const report = createReplyRunReport({
    target: totalTarget,
    totalRows: firstPage.totalRows,
    displayRows: firstPage.displayRows,
    limit: requestedMaxCount,
    requestBody: firstPage.requestBody,
    dryRun,
  });
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  let totalPages = reviewPageCountForRows({
    totalRows: firstPage.totalRows,
    displayRows: firstPage.displayRows,
    pageSize,
    maxPages: options.maxPages,
  });
  let pageReviews = firstPage.pageReviews;
  let currentPageNo = 1;
  const skippedKeys = new Set();
  updateReplyRunLiveState(report, {
    totalRows: firstPage.totalRows,
    displayRows: firstPage.displayRows,
    pageNo: currentPageNo,
    pageCount: totalPages,
  });

  emitProgress(onProgress, {
    status: 'report',
    ...replyRunProgressFields(report),
    requestBody: firstPage.requestBody,
    dryRun,
  });

  while (shouldContinueReplyRun(report, totalTarget) && !isStopped(options.stopSignal)) {
    let pageHadSuccess = false;
    let pageHadNewSkip = false;
    let pageSuccessCount = 0;
    const pageSuccessLimit = Math.max(1, Number(options.pageSuccessLimit || 1));

    for (const rawReview of pageReviews) {
      if (!shouldContinueReplyRun(report, totalTarget) || isStopped(options.stopSignal)) break;

      const review = await analyzeAndMark(rawReview);
      const key = reviewKey(review);
      if (key && skippedKeys.has(key)) continue;
      const decision = shouldAutoReplyReview(review);
      if (!decision.ok) {
        if (key) skippedKeys.add(key);
        pageHadNewSkip = true;
        if (review.replyBlocked || review.canReview !== true || review.canInteract === false || /不可回复|不可评论|不允许回复|不允许回复\/互动/.test(decision.reason)) {
          options.onReplyBlocked?.(review, decision.reason);
        }
        let riskSync = null;
        if (review.flagged) {
          try {
            riskSync = await options.onReviewFlagged?.(review, effectiveFlagReason(review, decision.reason));
          } catch (err) {
            riskSync = { ok: false, status: 'failed', error: err.message || String(err) };
          }
        } else if (review.uncertainSkip) {
          options.onReviewUncertain?.(review, decision.reason);
        }
        const record = recordReplyRunOutcome(report, {
          review,
          status: 'skip',
          reason: decision.reason,
        });
        emitProgress(onProgress, {
          ...record,
          ...replyRunProgressFields(report),
          status: 'skip',
          reviewContent: review.content,
          reply: decision.reason,
          riskSync,
        });
        continue;
      }

      try {
        if (review.neutralReply || review.sentimentLabel === 'neutral_auto_reply') {
          options.onReviewNeutral?.(review, review.neutralReason || '中性评价，使用保守回复');
        }
        const { reply, method } = await genReply(review, {
          neutral: review.neutralReply || review.sentimentLabel === 'neutral_auto_reply',
        });
        const submitResult = await submitReplyForReview(page, review, reply, {
          dryRun,
          onProgress,
          stopSignal: options.stopSignal,
        });
        if (submitResult.blocked) {
          if (key) skippedKeys.add(key);
          pageHadNewSkip = true;
          options.onReplyBlocked?.(review, submitResult.reason);
          const record = recordReplyRunOutcome(report, {
            review: {
              ...review,
              replyBlocked: true,
              skipReason: submitResult.reason,
            },
            status: 'skip',
            reason: submitResult.reason,
            reply,
            method,
          });
          emitProgress(onProgress, {
            ...record,
            ...replyRunProgressFields(report),
            status: 'skip',
            reviewContent: review.content,
            reply: submitResult.reason,
            method,
          });
          await closeReplyDialog(page);
          continue;
        }
        const status = dryRun ? 'dry-run' : 'ok';
        const record = recordReplyRunOutcome(report, {
          review,
          status,
          reason: dryRun ? 'dry-run 已填入并关闭，未提交' : '提交成功',
          reply,
          method,
        });
        if (!dryRun) {
          options.onReplySuccess?.(review, record);
        }
        emitProgress(onProgress, {
          ...record,
          ...replyRunProgressFields(report),
          status,
          reviewContent: review.content,
          reply,
          method,
        });
        pageHadSuccess = true;
        pageSuccessCount += 1;
        await randomDelay(1600, 3200);
        if (!dryRun && pageSuccessCount >= pageSuccessLimit) break;
      } catch (err) {
        const screenshot = await captureFailureScreenshot(page, review).catch(() => '');
        const record = recordReplyRunOutcome(report, {
          review,
          status: 'fail',
          reason: err.message,
          screenshot,
        });
        emitProgress(onProgress, {
          ...record,
          ...replyRunProgressFields(report),
          status: 'fail',
          reviewContent: review.content,
          reply: err.message,
          screenshot,
          firstFailure: report.firstFailure,
        });
        await closeReplyDialog(page);
      }
    }

    if (!shouldContinueReplyRun(report, totalTarget) || isStopped(options.stopSignal)) break;

    let action = nextReplyPageAction({
      dryRun,
      pageHadSuccess,
      pageNo: currentPageNo,
      pageCount: totalPages,
      refreshAfterSuccess: options.pageTraversal !== 'sequential',
    });

    if (!dryRun && !pageHadSuccess && !pageHadNewSkip && pageReviews.length === 0) {
      action = 'done';
    }
    if (!dryRun && !pageHadSuccess && pageHadNewSkip && currentPageNo >= totalPages) {
      action = 'done';
    }
    if (action === 'done') break;

    const nextPageNo = action === 'refresh-first' ? 1 : currentPageNo + 1;
    const stage = action === 'refresh-first' ? '刷新未回复列表' : `翻到第 ${nextPageNo} 页`;
    let pageData;
    try {
      pageData = await waitForGoodReviewList(page, async () => {
        if (action === 'refresh-first') {
          await waitForPageGate(page, { onProgress, stopSignal: options.stopSignal, stage });
          await safeClick(page, page.locator('button:has-text("查询")'), '查询按钮', { forceLast: true });
        } else {
          const moved = await clickNextPage(page, nextPageNo);
          if (!moved) throw new Error(`无法翻到第 ${nextPageNo} 页`);
        }
      }, {
        onProgress,
        stopSignal: options.stopSignal,
        stage,
        timeout: 60000,
        expectedPageNo: nextPageNo,
        expectedPageSize: pageSize,
      });
    } catch (err) {
      const record = recordReplyRunOutcome(report, {
        review: { reviewId: `page-${nextPageNo}`, orderNo: '' },
        status: 'fail',
        reason: `${stage}失败：${err.message}`,
      });
      emitProgress(onProgress, {
        ...record,
        ...replyRunProgressFields(report),
        status: 'fail',
        stage,
        paginationDiagnostics: err.paginationDiagnostics || null,
        firstFailure: report.firstFailure,
      });
      break;
    }
    currentPageNo = nextPageNo;
    totalPages = reviewPageCountForRows({
      totalRows: pageData.totalRows,
      displayRows: pageData.displayRows,
      pageSize,
      maxPages: options.maxPages,
    });
    pageReviews = pageData.pageReviews;
    updateReplyRunLiveState(report, {
      totalRows: pageData.totalRows,
      displayRows: pageData.displayRows,
      pageNo: currentPageNo,
      pageCount: totalPages,
    });
    emitProgress(onProgress, {
      status: 'report',
      stage,
      ...replyRunProgressFields(report),
      dryRun,
    });
    await randomDelay(1000, 2000);
  }

  report.stopped = isStopped(options.stopSignal);
  return report;
}

export async function e2eDryRunAllPages(genReply, onProgress, options = {}) {
  const ctx = await initBrowser(options);
  const page = ctx.pages()[0] || await ctx.newPage();
  const safetyMax = Number(options.safetyMax || 0);

  await ensureReviewPage(page, { onProgress, stopSignal: options.stopSignal, reviewDays: options.reviewDays });
  const firstPage = await applyGoodReviewFilters(page, { onProgress, stopSignal: options.stopSignal, reviewDays: options.reviewDays });
  const pageSize = Number(options.pageSize || firstPage.requestBody?.pageSize || DEFAULT_PAGE_SIZE);

  const totalPages = reviewPageCountForRows({
    totalRows: firstPage.totalRows,
    displayRows: firstPage.displayRows,
    pageSize,
    maxPages: options.maxPages,
  });
  const report = createE2EDryRunReport({
    totalRows: firstPage.totalRows,
    displayRows: firstPage.displayRows,
    pageSize,
    safetyMax,
  });

  emitProgress(onProgress, {
    status: 'e2e-start',
    mode: 'e2e-dry-run',
    dryRun: true,
    page: 1,
    pageCount: totalPages,
    totalRows: firstPage.totalRows,
    visibleRows: firstPage.displayRows,
    requestBody: firstPage.requestBody,
  });

  let pageReviews = firstPage.pageReviews;
  let currentPageData = firstPage;

  for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
    if (isStopped(options.stopSignal)) break;

    const pageSummary = {
      scanned: 0,
      skipped: 0,
      skippedAlreadyReplied: 0,
      replyable: 0,
      dialogOpened: false,
      failed: 0,
      aiFailed: 0,
      pageFailed: 0,
      failures: [],
      sample: null,
    };

    const requestCheck = validateGoodReviewPageRequest(currentPageData.requestBody, {
      expectedPageNo: pageNo,
      expectedPageSize: pageSize,
    });
    if (!requestCheck.ok) {
      pageSummary.failed += 1;
      pageSummary.pageFailed += 1;
      pageSummary.failures.push({
        stage: '验证评价列表请求体',
        reason: requestCheck.reason,
      });
    }

    const structuralSummary = summarizeE2EPageReviews(pageReviews);
    pageSummary.scanned = structuralSummary.scanned;
    pageSummary.skipped = structuralSummary.skipped;
    pageSummary.skippedAlreadyReplied = structuralSummary.skippedAlreadyReplied;
    pageSummary.replyable = structuralSummary.replyable;

    for (const { review, decision } of structuralSummary.decisions) {
      if (!decision.ok) {
        emitProgress(onProgress, {
          status: 'e2e-skip',
          mode: 'e2e-dry-run',
          page: pageNo,
          pageCount: totalPages,
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          reason: decision.reason,
          scanned: report.scanned + pageSummary.scanned,
        });
      }
    }

    const review = structuralSummary.candidate;
    if (review && !isStopped(options.stopSignal)) {
      let replyResult;
      try {
        replyResult = await genReply(review, {
          neutral: review.neutralReply || review.sentimentLabel === 'neutral_auto_reply',
        });
      } catch (err) {
        pageSummary.failed += 1;
        pageSummary.aiFailed += 1;
        pageSummary.failures.push({
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          stage: '生成 DeepSeek 回复',
          reason: err.message,
        });
        emitProgress(onProgress, {
          status: 'e2e-ai-fail',
          mode: 'e2e-dry-run',
          page: pageNo,
          pageCount: totalPages,
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          reason: err.message,
        });
        continue;
      }

      try {
        const submitResult = await submitReplyForReview(page, review, replyResult.reply, {
          dryRun: true,
          onProgress,
          stopSignal: options.stopSignal,
          captureFillScreenshot: true,
          captureNetwork: true,
        });
        pageSummary.dialogOpened = true;
        pageSummary.sample = {
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          fillResult: submitResult.fillResult,
          filledScreenshot: submitResult.filledScreenshot,
          networkRequests: submitResult.networkRequests,
        };
        emitProgress(onProgress, {
          status: 'e2e-dialog-ok',
          mode: 'e2e-dry-run',
          page: pageNo,
          pageCount: totalPages,
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          reviewContent: review.content,
          reply: replyResult.reply,
          method: replyResult.method,
          fillResult: submitResult.fillResult,
          filledScreenshot: submitResult.filledScreenshot,
          networkRequests: submitResult.networkRequests,
        });
      } catch (err) {
        const screenshot = await captureFailureScreenshot(page, review).catch(() => '');
        pageSummary.failed += 1;
        pageSummary.pageFailed += 1;
        pageSummary.failures.push({
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          stage: '打开/填写/关闭回复弹窗',
          reason: err.message,
          screenshot,
          networkRequests: err.networkRequests || [],
        });
        emitProgress(onProgress, {
          status: 'e2e-page-fail',
          mode: 'e2e-dry-run',
          page: pageNo,
          pageCount: totalPages,
          reviewId: review.reviewId,
          orderSn: review.orderNo,
          reason: err.message,
          screenshot,
          networkRequests: err.networkRequests || [],
        });
        await closeReplyDialog(page);
      }
    }

    const pageRecord = recordE2EDryRunPage(report, {
      pageNo,
      pageCount: totalPages,
      requestBody: currentPageData.requestBody,
      ...pageSummary,
      lastPageReached: pageNo >= totalPages,
    });

    emitProgress(onProgress, {
      status: 'e2e-page-done',
      mode: 'e2e-dry-run',
      dryRun: true,
      page: pageNo,
      pageCount: totalPages,
      lastPageReached: report.lastPageReached,
      ...pageRecord,
      scanned: report.scanned,
      skipped: report.skipped,
      skippedAlreadyReplied: report.skippedAlreadyReplied,
      replyable: report.replyable,
      dialogOpened: report.dialogOpened,
      failed: report.failed,
      aiFailed: report.aiFailed,
      pageFailed: report.pageFailed,
      firstFailure: report.firstFailure,
    });

    if (pageNo >= totalPages || isStopped(options.stopSignal)) break;

    try {
      currentPageData = await waitForGoodReviewList(page, async () => {
        const moved = await clickNextPage(page, pageNo + 1);
        if (!moved) throw new Error(`无法翻到第 ${pageNo + 1} 页`);
      }, {
        onProgress,
        stopSignal: options.stopSignal,
        expectedPageNo: pageNo + 1,
        expectedPageSize: pageSize,
        stage: `E2E 翻到第 ${pageNo + 1} 页`,
      });
    } catch (err) {
      const screenshot = await captureStageScreenshot(page, { reviewId: `page-${pageNo + 1}` }, 'page-fail').catch(() => '');
      const failure = {
        stage: '翻页/读取评价列表',
        reason: err.message,
        screenshot,
        paginationDiagnostics: err.paginationDiagnostics || null,
      };
      const pageRecord = recordE2EDryRunPage(report, {
        pageNo: pageNo + 1,
        pageCount: totalPages,
        scanned: 0,
        failed: 1,
        pageFailed: 1,
        failures: [failure],
        lastPageReached: false,
      });
      emitProgress(onProgress, {
        status: 'e2e-page-fail',
        mode: 'e2e-dry-run',
        dryRun: true,
        page: pageNo + 1,
        pageCount: totalPages,
        ...pageRecord,
        scanned: report.scanned,
        skipped: report.skipped,
        skippedAlreadyReplied: report.skippedAlreadyReplied,
        replyable: report.replyable,
        dialogOpened: report.dialogOpened,
        failed: report.failed,
        aiFailed: report.aiFailed,
        pageFailed: report.pageFailed,
        paginationDiagnostics: err.paginationDiagnostics || null,
        firstFailure: report.firstFailure,
      });
      break;
    }
    pageReviews = currentPageData.pageReviews;
    await randomDelay(1000, 2000);
  }

  report.stopped = isStopped(options.stopSignal);
  return report;
}

export const __testing = {
  ORDER_SEARCH_INPUT_XPATH,
  buildReviewActionHints,
  describeTextareaSnapshots,
  orderSearchInputLocator,
  pickPaginationControlSnapshot,
  sanitizeNetworkSnapshot,
  buildGoodReviewListRequest,
  formatBrowserLaunchError,
  extractShopNameFromText,
  isBrowserContextUsable,
  isReplyActionText,
  requestMatchesGoodReviewFilter,
  requestMatchesGoodReviewOrderSearch,
  reviewListPopupCleanupStage,
};
