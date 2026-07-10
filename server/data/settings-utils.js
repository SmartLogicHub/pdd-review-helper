export const DEFAULT_SETTINGS = {
  deepseekApiKey: '',
  storeName: 'HECATE官方旗舰店',
  autoReplyEnabled: false,
  aiReplyEnabled: false,
  aiSentimentEnabled: true,
  reviewDays: 90,
  feishuEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBitableUrl: '',
  feishuAppToken: '',
  feishuTableId: '',
  feishuViewId: '',
  wecomEnabled: false,
  wecomWebhookUrl: '',
  feishuBotEnabled: false,
  feishuBotWebhookUrl: '',
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const REVIEW_DAY_OPTIONS = new Set([30, 90, 180]);

export function maskApiKey(apiKey = '') {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}${'*'.repeat(Math.max(apiKey.length - 8, 4))}${apiKey.slice(-4)}`;
}

export function maskSecret(value = '') {
  const secret = String(value || '');
  if (!secret) return '';
  if (secret.length <= 12) return '*'.repeat(secret.length);
  return `${secret.slice(0, 6)}${'*'.repeat(Math.max(secret.length - 12, 6))}${secret.slice(-6)}`;
}

export function isValidDeepSeekApiKey(value = '') {
  const key = String(value || '').trim();
  if (!key) return true;
  return /^sk-[A-Za-z0-9_-]{8,}$/.test(key);
}

function normalizeDeepSeekApiKey(value = '') {
  const key = String(value || '').trim();
  if (!key) return '';
  return isValidDeepSeekApiKey(key) ? key : '';
}

export function parseFeishuBitableUrl(value = '') {
  if (!value || typeof value !== 'string') return {};
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const baseIndex = segments.findIndex(segment => segment === 'base');
    const appToken = baseIndex >= 0 ? segments[baseIndex + 1] : '';
    return {
      appToken: appToken || '',
      tableId: url.searchParams.get('table') || '',
      viewId: url.searchParams.get('view') || '',
    };
  } catch {
    return {};
  }
}

export function mergeSettings(current = {}, updates = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...current,
    deepseekApiKey: normalizeDeepSeekApiKey(current.deepseekApiKey),
  };
  for (const key of SETTING_KEYS) {
    if (Object.hasOwn(updates, key)) {
      if (key === 'deepseekApiKey' && isMaskedApiKey(updates[key])) {
        continue;
      }
      if (key === 'deepseekApiKey' && !isValidDeepSeekApiKey(updates[key])) {
        continue;
      }
      if ((key === 'feishuAppSecret' || key === 'wecomWebhookUrl' || key === 'feishuBotWebhookUrl') && isMaskedApiKey(updates[key])) {
        continue;
      }
      merged[key] = updates[key];
    }
  }
  if (Object.hasOwn(updates, 'feishuBitableUrl')) {
    const parsed = parseFeishuBitableUrl(updates.feishuBitableUrl);
    if (parsed.appToken) merged.feishuAppToken = parsed.appToken;
    if (parsed.tableId) merged.feishuTableId = parsed.tableId;
    if (parsed.viewId) merged.feishuViewId = parsed.viewId;
  }
  merged.autoReplyEnabled = Boolean(merged.autoReplyEnabled);
  merged.aiReplyEnabled = Boolean(merged.aiReplyEnabled);
  merged.aiSentimentEnabled = merged.aiSentimentEnabled !== false;
  merged.feishuEnabled = Boolean(merged.feishuEnabled);
  merged.wecomEnabled = Boolean(merged.wecomEnabled);
  merged.feishuBotEnabled = Boolean(merged.feishuBotEnabled);
  merged.storeName = typeof merged.storeName === 'string' ? merged.storeName : DEFAULT_SETTINGS.storeName;
  merged.deepseekApiKey = normalizeDeepSeekApiKey(merged.deepseekApiKey);
  merged.feishuAppId = typeof merged.feishuAppId === 'string' ? merged.feishuAppId.trim() : '';
  merged.feishuAppSecret = typeof merged.feishuAppSecret === 'string' ? merged.feishuAppSecret.trim() : '';
  merged.feishuBitableUrl = typeof merged.feishuBitableUrl === 'string' ? merged.feishuBitableUrl.trim() : '';
  merged.feishuAppToken = typeof merged.feishuAppToken === 'string' ? merged.feishuAppToken.trim() : '';
  merged.feishuTableId = typeof merged.feishuTableId === 'string' ? merged.feishuTableId.trim() : '';
  merged.feishuViewId = typeof merged.feishuViewId === 'string' ? merged.feishuViewId.trim() : '';
  merged.wecomWebhookUrl = typeof merged.wecomWebhookUrl === 'string' ? merged.wecomWebhookUrl.trim() : '';
  merged.feishuBotWebhookUrl = typeof merged.feishuBotWebhookUrl === 'string' ? merged.feishuBotWebhookUrl.trim() : '';
  merged.reviewDays = normalizeReviewDays(merged.reviewDays);
  return merged;
}

export function normalizeReviewDays(value) {
  const days = Number(value);
  return REVIEW_DAY_OPTIONS.has(days) ? days : DEFAULT_SETTINGS.reviewDays;
}

export function isMaskedApiKey(value) {
  return typeof value === 'string' && value.includes('*');
}

export function publicSettings(settings = {}) {
  const merged = mergeSettings(DEFAULT_SETTINGS, settings);
  return {
    ...merged,
    deepseekApiKey: maskApiKey(merged.deepseekApiKey),
    feishuAppSecret: maskSecret(merged.feishuAppSecret),
    wecomWebhookUrl: maskSecret(merged.wecomWebhookUrl),
    feishuBotWebhookUrl: maskSecret(merged.feishuBotWebhookUrl),
    hasDeepseekApiKey: Boolean(merged.deepseekApiKey),
    hasFeishuAppSecret: Boolean(merged.feishuAppSecret),
    hasWecomWebhookUrl: Boolean(merged.wecomWebhookUrl),
    hasFeishuBotWebhookUrl: Boolean(merged.feishuBotWebhookUrl),
  };
}
