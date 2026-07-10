import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { randomUUID } from 'crypto';
import { DEFAULT_SETTINGS, mergeSettings, publicSettings } from './settings-utils.js';
import { DEFAULT_SENTIMENT_PROMPT } from '../services/sentiment-core.js';
import {
  effectiveFlagReason,
  mergeReviewRecords,
  mergeReviewRecordsWithStats,
  reviewKey,
  summarizeReviewRecords,
} from '../services/review-normalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.APP_DIR || join(__dirname, '..', '..');
const SOURCE_ROOT = process.env.APP_DIR ? APP_DIR : join(__dirname, '..', '..');
const DATA_DIR = resolveDataDir();
const REVIEWS_FILE = join(DATA_DIR, 'reviews.json');
const REVIEWS_DIR = join(DATA_DIR, 'reviews');
const ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const TEMPLATES_FILE = join(DATA_DIR, '好评例子.txt');
const NEUTRAL_TEMPLATES_FILE = join(DATA_DIR, '中性回复模板.txt');
const SENTIMENT_PROMPT_FILE = join(DATA_DIR, '情感分析提示词.txt');
const LEGACY_DATA_DIRS = [
  __dirname,
  join(APP_DIR, 'data'),
  join(SOURCE_ROOT, 'server', 'data'),
  join(SOURCE_ROOT, 'data'),
];
const LEGACY_TEMPLATE_FILES = [
  join(APP_DIR, '好评例子.txt'),
  join(SOURCE_ROOT, '好评例子.txt'),
  join(__dirname, '..', '..', '好评例子.txt'),
];
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_ACCOUNT_NAME = '默认账号';

const DEFAULT_TEMPLATES = [
  '感谢亲的好评！漫步者专注音质27年，HECATE系列专为电竞和音乐爱好者打造，希望能陪伴您每一次精彩时刻！',
  '谢谢亲的支持！HECATE耳机在低频表现和佩戴舒适度上做了大量优化，您用得开心就是我们最大的动力~',
  '感谢您的5星好评！漫步者作为国产音频品牌，一直坚持自主研发，您的认可是我们前进的动力！',
  '谢谢亲的肯定！如果在使用过程中有任何疑问，随时联系我们的客服，7x24小时为您服务~',
  '感谢好评！HECATE致力于为玩家提供极致的游戏音频体验，祝您游戏愉快，天天吃鸡！',
  '感谢支持！漫步者HECATE支持APP自定义调音，您可以根据喜好调节EQ，发现更多声音的乐趣~',
  '谢谢亲！这款耳机的50mm大单元和高解析音频认证，就是为了让您感受身临其境的声音体验！',
];

const DEFAULT_NEUTRAL_TEMPLATES = [
  '感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们，我们会及时为您处理。',
  '感谢您的反馈，产品使用过程中如有疑问或需要帮助，可以随时联系我们，祝您生活愉快。',
  '感谢您的支持，后续如有任何使用问题都可以联系店铺客服，我们会尽快协助处理。',
];

function resolveDataDir() {
  const base = process.env.APPDATA
    || process.env.LOCALAPPDATA
    || (process.platform === 'win32'
      ? join(os.homedir(), 'AppData', 'Roaming')
      : join(os.homedir(), '.local', 'share'));
  const candidates = [
    process.env.PDD_HELPER_DATA_DIR,
    join(base, 'pdd-review-helper'),
    join(APP_DIR, 'runtime-data'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (err) {
      console.warn(`[store] 数据目录不可用，尝试下一个: ${dir} (${err.message})`);
    }
  }

  return APP_DIR;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureReviewsDir() {
  ensureDataDir();
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
}

function normalizeAccountId(accountId = '') {
  const id = String(accountId || '').trim();
  return /^[a-zA-Z0-9_-]{1,48}$/.test(id) ? id : DEFAULT_ACCOUNT_ID;
}

function currentIso() {
  return new Date().toISOString();
}

function defaultAccount() {
  return {
    id: DEFAULT_ACCOUNT_ID,
    name: DEFAULT_ACCOUNT_NAME,
    createdAt: currentIso(),
    updatedAt: currentIso(),
  };
}

function normalizeAccount(account = {}) {
  const id = normalizeAccountId(account.id);
  const name = typeof account.name === 'string' && account.name.trim()
    ? account.name.trim()
    : (id === DEFAULT_ACCOUNT_ID ? DEFAULT_ACCOUNT_NAME : `账号 ${id.slice(-4)}`);
  const shopName = typeof account.shopName === 'string' ? account.shopName.trim() : '';
  return {
    id,
    name,
    shopName,
    shopNameStatus: account.shopNameStatus || (shopName ? 'detected' : 'unknown'),
    shopNameSource: account.shopNameSource || '',
    shopNameDetectedAt: account.shopNameDetectedAt || '',
    shopNameError: account.shopNameError || '',
    createdAt: account.createdAt || currentIso(),
    updatedAt: account.updatedAt || account.createdAt || currentIso(),
    openedAt: account.openedAt || '',
  };
}

function normalizeAccountsState(raw = {}) {
  const defaultItem = defaultAccount();
  const seen = new Set();
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
    .map(normalizeAccount)
    .filter(account => {
      if (seen.has(account.id)) return false;
      seen.add(account.id);
      return true;
    });
  if (!seen.has(DEFAULT_ACCOUNT_ID)) {
    accounts.unshift(defaultItem);
  }
  const currentAccountId = accounts.some(account => account.id === raw.currentAccountId)
    ? raw.currentAccountId
    : DEFAULT_ACCOUNT_ID;
  return { currentAccountId, accounts };
}

function saveAccountsState(state) {
  ensureDataDir();
  const normalized = normalizeAccountsState(state);
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

function reviewFileForAccount(accountId) {
  return join(REVIEWS_DIR, `${normalizeAccountId(accountId)}.json`);
}

function cleanStoredReview(review = {}) {
  if (!review || typeof review !== 'object' || !review.flagged) return review;
  const flagReason = effectiveFlagReason(review, review.flagReason);
  return flagReason === review.flagReason ? review : { ...review, flagReason };
}

function legacyFile(name) {
  return LEGACY_DATA_DIRS
    .map(dir => join(dir, name))
    .find(file => file !== join(DATA_DIR, name) && fs.existsSync(file));
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[store] 读取 ${file} 失败:`, err.message);
    return fallback;
  }
}

function migrateFileIfNeeded(target, legacyCandidates, defaultContent) {
  ensureDataDir();
  if (fs.existsSync(target)) return;
  const source = legacyCandidates.find(file => file !== target && fs.existsSync(file));
  if (source) {
    fs.copyFileSync(source, target);
    return;
  }
  fs.writeFileSync(target, defaultContent, 'utf-8');
}

// ====== 评价数据操作 ======

export function getAccountsState() {
  migrateFileIfNeeded(
    ACCOUNTS_FILE,
    LEGACY_DATA_DIRS.map(dir => join(dir, 'accounts.json')),
    JSON.stringify({ currentAccountId: DEFAULT_ACCOUNT_ID, accounts: [defaultAccount()] }, null, 2)
  );
  const state = normalizeAccountsState(readJsonFile(ACCOUNTS_FILE, {}));
  saveAccountsState(state);
  return state;
}

export function getCurrentAccount() {
  const state = getAccountsState();
  return state.accounts.find(account => account.id === state.currentAccountId) || state.accounts[0] || defaultAccount();
}

export function createAccount({ name = '' } = {}) {
  const state = getAccountsState();
  const account = normalizeAccount({
    id: `acct_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: name || `账号 ${state.accounts.length + 1}`,
  });
  state.accounts.push(account);
  saveAccountsState(state);
  return account;
}

export function updateAccount(accountId, updates = {}) {
  const state = getAccountsState();
  const id = normalizeAccountId(accountId);
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new Error('账号不存在');
  if (typeof updates.name === 'string' && updates.name.trim()) {
    account.name = updates.name.trim();
    account.updatedAt = currentIso();
  }
  saveAccountsState(state);
  return account;
}

export function updateAccountShopName(accountId, shopName, { source = 'dom', error = '' } = {}) {
  const state = getAccountsState();
  const id = normalizeAccountId(accountId);
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new Error('账号不存在');
  const normalizedShopName = typeof shopName === 'string' ? shopName.trim() : '';
  account.shopName = normalizedShopName;
  account.shopNameStatus = normalizedShopName ? 'detected' : 'failed';
  account.shopNameSource = normalizedShopName ? source : '';
  account.shopNameDetectedAt = normalizedShopName ? currentIso() : '';
  account.shopNameError = normalizedShopName ? '' : (error || '未识别到真实店铺名称');
  account.updatedAt = currentIso();
  saveAccountsState(state);
  return account;
}

export function switchAccount(accountId) {
  const state = getAccountsState();
  const id = normalizeAccountId(accountId);
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new Error('账号不存在');
  state.currentAccountId = id;
  saveAccountsState(state);
  return account;
}

export function markAccountOpened(accountId) {
  const state = getAccountsState();
  const id = normalizeAccountId(accountId);
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new Error('账号不存在');
  account.openedAt = currentIso();
  account.updatedAt = account.openedAt;
  saveAccountsState(state);
  return account;
}

export function deleteAccount(accountId) {
  const state = getAccountsState();
  const id = normalizeAccountId(accountId);
  if (id === state.currentAccountId) throw new Error('不能删除当前账号，请先切换到其他账号');
  if (id === DEFAULT_ACCOUNT_ID) throw new Error('不能删除默认账号');
  const nextAccounts = state.accounts.filter(account => account.id !== id);
  if (nextAccounts.length === state.accounts.length) throw new Error('账号不存在');
  state.accounts = nextAccounts;
  saveAccountsState(state);
  const reviewFile = reviewFileForAccount(id);
  if (fs.existsSync(reviewFile)) fs.unlinkSync(reviewFile);
  return getAccountsState();
}

export function getReviews(accountId = getCurrentAccount().id) {
  ensureReviewsDir();
  const normalizedAccountId = normalizeAccountId(accountId);
  const file = reviewFileForAccount(normalizedAccountId);
  if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
    migrateFileIfNeeded(file, [
      REVIEWS_FILE,
      ...LEGACY_DATA_DIRS.map(dir => join(dir, 'reviews.json')),
    ], '[]');
  } else {
    migrateFileIfNeeded(file, [], '[]');
  }
  const reviews = readJsonFile(file, []);
  return Array.isArray(reviews) ? reviews.map(cleanStoredReview) : [];
}

export function saveReviews(reviews, accountId = getCurrentAccount().id) {
  try {
    ensureReviewsDir();
    fs.writeFileSync(reviewFileForAccount(accountId), JSON.stringify(reviews, null, 2), 'utf-8');
  } catch(e) {
    console.error(`[store] 保存评价失败:`, e.message);
  }
}

export function addReviews(newReviews, accountId = getCurrentAccount().id) {
  const existing = getReviews(accountId);
  const merged = mergeReviewRecords(existing, newReviews);
  saveReviews(merged, accountId);
  return merged;
}

export function addReviewsWithStats(newReviews, accountId = getCurrentAccount().id) {
  const existing = getReviews(accountId);
  const result = mergeReviewRecordsWithStats(existing, newReviews);
  saveReviews(result.reviews, accountId);
  return result;
}

function findReviewForUpdate(reviews, reviewId) {
  const id = typeof reviewId === 'object' && reviewId
    ? String(reviewId.reviewId || reviewId.id || reviewId.orderNo || reviewId.orderSn || '')
    : String(reviewId || '');
  const orderNo = typeof reviewId === 'object' && reviewId
    ? String(reviewId.orderNo || reviewId.orderSn || '')
    : '';
  const key = typeof reviewId === 'object' && reviewId ? reviewKey(reviewId) : id;
  const found = reviews.find(r => (
    String(r.id || '') === id
    || String(r.reviewId || '') === id
    || String(r.orderNo || '') === id
    || (orderNo && String(r.orderNo || '') === orderNo)
      || (key && reviewKey(r) === key)
    ));
  return found;
}

function makeLocalReview(review = {}) {
  const id = String(review.reviewId || review.id || review.orderNo || review.orderSn || '');
  return {
    ...review,
    id: review.id || id,
    reviewId: review.reviewId || id,
    orderNo: review.orderNo || review.orderSn || '',
    fetchedAt: review.fetchedAt || new Date().toISOString(),
  };
}

export function markReplied(reviewId, accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  let found = findReviewForUpdate(reviews, reviewId);
  if (!found && typeof reviewId === 'object' && reviewId) {
    found = makeLocalReview(reviewId);
    reviews.unshift(found);
  }
  if (found) {
    found.replied = true;
    found.replyBlocked = false;
    found.repliedAt = new Date().toISOString();
    found.replyCount = Math.max(Number(found.replyCount || 0), 1);
    saveReviews(reviews, accountId);
  }
  return found;
}

export function markReplyBlocked(reviewId, reason = '平台提示不可回复', accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  let found = findReviewForUpdate(reviews, reviewId);
  if (!found && typeof reviewId === 'object' && reviewId) {
    found = makeLocalReview(reviewId);
    reviews.unshift(found);
  }
  if (found) {
    found.replied = false;
    found.replyBlocked = true;
    found.canReview = false;
    found.skipReason = reason;
    found.neutralReply = false;
    found.neutralReason = '';
    found.blockedAt = new Date().toISOString();
    saveReviews(reviews, accountId);
  }
  return found;
}

export function markReviewFlagged(reviewId, reason = '当前商品存在负面体验', accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  let found = findReviewForUpdate(reviews, reviewId);
  if (!found && typeof reviewId === 'object' && reviewId) {
    found = makeLocalReview(reviewId);
    reviews.unshift(found);
  }
  if (found) {
    const incomingReview = typeof reviewId === 'object' && reviewId ? reviewId : {};
    const riskReason = effectiveFlagReason({ ...found, ...incomingReview }, reason);
    found.replied = false;
    found.flagged = true;
    found.flagReason = riskReason;
    if (Array.isArray(incomingReview.riskWords) && incomingReview.riskWords.length) {
      found.riskWords = incomingReview.riskWords;
    }
    if (Array.isArray(incomingReview.safePositiveWords) && incomingReview.safePositiveWords.length) {
      found.safePositiveWords = incomingReview.safePositiveWords;
    }
    found.uncertainSkip = false;
    found.uncertainReason = '';
    found.neutralReply = false;
    found.neutralReason = '';
    found.sentimentLabel = 'risk_manual_review';
    found.flaggedAt = new Date().toISOString();
    found.riskSyncStatus = found.riskSyncStatus || 'pending';
    saveReviews(reviews, accountId);
  }
  return found;
}

export function markExternalRiskSync(reviewId, patch = {}, accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  let found = findReviewForUpdate(reviews, reviewId);
  if (!found && typeof reviewId === 'object' && reviewId) {
    found = makeLocalReview(reviewId);
    reviews.unshift(found);
  }
  if (found) {
    found.riskSyncStatus = patch.status || patch.riskSyncStatus || found.riskSyncStatus || 'pending';
    found.riskCaseKey = patch.riskCaseKey ?? found.riskCaseKey ?? '';
    found.riskSyncError = patch.error ?? patch.riskSyncError ?? '';
    found.riskSyncAt = patch.riskSyncAt || new Date().toISOString();
    found.feishuRecordId = patch.feishuRecordId ?? found.feishuRecordId ?? '';
    found.feishuSyncedAt = patch.feishuSyncedAt ?? found.feishuSyncedAt ?? '';
    found.wecomNotifiedAt = patch.wecomNotifiedAt ?? found.wecomNotifiedAt ?? '';
    found.wecomNotifyError = patch.wecomNotifyError ?? found.wecomNotifyError ?? '';
    saveReviews(reviews, accountId);
  }
  return found;
}

export function markReviewUncertain(reviewId, reason = '评价信息不足，跳过自动回复', accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  let found = findReviewForUpdate(reviews, reviewId);
  if (!found && typeof reviewId === 'object' && reviewId) {
    found = makeLocalReview(reviewId);
    reviews.unshift(found);
  }
  if (found) {
    found.replied = false;
    found.flagged = false;
    found.flagReason = '';
    found.uncertainSkip = true;
    found.uncertainReason = reason;
    found.neutralReply = false;
    found.neutralReason = '';
    found.sentimentLabel = 'uncertain_skip';
    found.uncertainAt = new Date().toISOString();
    saveReviews(reviews, accountId);
  }
  return found;
}

export function markReviewNeutral(reviewId, reason = '中性评价，使用保守回复', accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  let found = findReviewForUpdate(reviews, reviewId);
  if (!found && typeof reviewId === 'object' && reviewId) {
    found = makeLocalReview(reviewId);
    reviews.unshift(found);
  }
  if (found) {
    found.replied = false;
    found.flagged = false;
    found.flagReason = '';
    found.uncertainSkip = false;
    found.uncertainReason = '';
    found.neutralReply = true;
    found.neutralReason = reason;
    found.sentimentLabel = 'neutral_auto_reply';
    found.neutralAt = new Date().toISOString();
    saveReviews(reviews, accountId);
  }
  return found;
}

// ====== 设置数据操作 ======

export function getSettings() {
  migrateFileIfNeeded(
    SETTINGS_FILE,
    LEGACY_DATA_DIRS.map(dir => join(dir, 'settings.json')),
    JSON.stringify(DEFAULT_SETTINGS, null, 2)
  );
  return mergeSettings(DEFAULT_SETTINGS, readJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS));
}

export function getPublicSettings() {
  return publicSettings(getSettings());
}

export function saveSettings(settings = {}) {
  ensureDataDir();
  const merged = mergeSettings(getSettings(), settings);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

// ====== 模板操作 ======

export function getTemplates() {
  migrateFileIfNeeded(TEMPLATES_FILE, LEGACY_TEMPLATE_FILES, DEFAULT_TEMPLATES.join('\n'));
  return fs.readFileSync(TEMPLATES_FILE, 'utf-8');
}

export function saveTemplates(content) {
  ensureDataDir();
  fs.writeFileSync(TEMPLATES_FILE, content, 'utf-8');
}

export function getNeutralTemplates() {
  migrateFileIfNeeded(NEUTRAL_TEMPLATES_FILE, [], DEFAULT_NEUTRAL_TEMPLATES.join('\n'));
  return fs.readFileSync(NEUTRAL_TEMPLATES_FILE, 'utf-8');
}

export function saveNeutralTemplates(content) {
  ensureDataDir();
  fs.writeFileSync(NEUTRAL_TEMPLATES_FILE, content, 'utf-8');
}

export function getSentimentPrompt() {
  try {
    migrateFileIfNeeded(SENTIMENT_PROMPT_FILE, [], DEFAULT_SENTIMENT_PROMPT);
    return fs.readFileSync(SENTIMENT_PROMPT_FILE, 'utf-8');
  } catch (err) {
    console.warn(`[store] 情感分析提示词不可写或不可读，使用默认模板: ${err.message}`);
    return DEFAULT_SENTIMENT_PROMPT;
  }
}

export function saveSentimentPrompt(content) {
  const prompt = String(content || '').trim();
  if (!prompt) return resetSentimentPrompt();
  ensureDataDir();
  fs.writeFileSync(SENTIMENT_PROMPT_FILE, prompt, 'utf-8');
  return prompt;
}

export function resetSentimentPrompt() {
  ensureDataDir();
  fs.writeFileSync(SENTIMENT_PROMPT_FILE, DEFAULT_SENTIMENT_PROMPT, 'utf-8');
  return DEFAULT_SENTIMENT_PROMPT;
}

// ====== 清除已回复 ======

export function clearReplied(accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId).filter(r => !r.replied);
  saveReviews(reviews, accountId);
  return reviews.length;
}

export function clearAll(accountId = getCurrentAccount().id) {
  saveReviews([], accountId);
  return 0;
}

// ====== 统计 ======

export function getStats(accountId = getCurrentAccount().id) {
  const reviews = getReviews(accountId);
  return summarizeReviewRecords(reviews);
}

function emptyStats() {
  return {
    total: 0,
    replied: 0,
    unreplied: 0,
    pending: 0,
    neutral: 0,
    actionable: 0,
    flagged: 0,
    blocked: 0,
    uncertain: 0,
  };
}

function addStats(target, source = {}) {
  for (const key of Object.keys(emptyStats())) {
    target[key] += Number(source[key] || 0);
  }
  return target;
}

export function getAccountsSummary() {
  const state = getAccountsState();
  const totals = emptyStats();
  const accounts = state.accounts.map(account => {
    const stats = getStats(account.id);
    addStats(totals, stats);
    return {
      ...account,
      isCurrent: account.id === state.currentAccountId,
      stats,
    };
  });
  return {
    currentAccountId: state.currentAccountId,
    accounts,
    totals,
  };
}

export const __testing = {
  findReviewForUpdate,
  makeLocalReview,
};
