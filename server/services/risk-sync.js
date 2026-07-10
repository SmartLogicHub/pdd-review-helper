import { markExternalRiskSync as defaultMarkExternalRiskSync } from '../data/store.js';

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis/bitable/v1';
const DEFAULT_TIMEOUT_MS = 12000;

function nowIso() {
  return new Date().toISOString();
}

function nowTimestampMs() {
  return Date.now();
}

function compactText(value = '', limit = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function requireConfig(settings = {}, keys = []) {
  const missing = keys.filter(key => !String(settings[key] || '').trim());
  if (missing.length) {
    throw new Error(`外部同步配置缺失: ${missing.join(', ')}`);
  }
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.msg || payload?.message || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFieldValue(value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) return value.map(normalizeFieldValue).join(',');
    return value.text || value.name || value.value || JSON.stringify(value);
  }
  return String(value ?? '');
}

export function buildRiskCaseKey(account = {}, review = {}) {
  const id = review.reviewId || review.id || review.orderNo || review.orderSn || '';
  return `${account.id || 'default'}:${id || 'unknown'}`;
}

const PLATFORM_SKIP_REASON_PATTERN = /(平台|用户|买家).{0,12}(不允许|不可|不能|不支持).{0,12}(回复|互动|评论)|不可回复|不可评论|不支持回复|不允许回复\/互动/;

function cleanRiskReasonText(value = '') {
  const text = compactText(value, 600)
    .replace(/风险词[:：]\s*/g, '')
    .replace(/[；;，,、\s]*(平台|用户|买家).{0,12}(不允许|不可|不能|不支持).{0,12}(回复|互动|评论)[；;，,、\s]*/g, '')
    .replace(/[；;，,、\s]*(不可回复|不可评论|不支持回复|不允许回复\/互动)[；;，,、\s]*/g, '')
    .replace(/^[；;，,、\s]+|[；;，,、\s]+$/g, '');
  return PLATFORM_SKIP_REASON_PATTERN.test(text) ? '' : text;
}

function buildRiskReason(review = {}, reason = '') {
  const riskWords = Array.isArray(review.riskWords)
    ? review.riskWords.map(word => String(word || '').trim()).filter(Boolean)
    : [];
  if (riskWords.length) return compactText(riskWords.join('、'), 600);
  const cleanedReason = [reason, review.flagReason]
    .map(item => cleanRiskReasonText(item))
    .find(Boolean);
  return cleanedReason || '疑似差评，需要人工处理';
}

export function buildFeishuRiskFields({ account = {}, review = {}, reason = '' } = {}) {
  return {
    店铺名称: account.shopName,
    订单编号: review.orderNo || review.orderSn || '',
    星级: Number(review.stars || review.descScore || 0) || '',
    评价内容: compactText(review.content || review.comment || review.appendContent || '', 1200),
    标记原因: buildRiskReason(review, reason),
    处理状态: '未处理',
    发现时间: nowTimestampMs(),
  };
}

export function formatWecomRiskMessage({
  account = {},
  review = {},
  reason = '',
  feishuUrl = '',
  pendingCount,
} = {}) {
  const riskReason = buildRiskReason(review, reason);
  const pendingText = Number.isFinite(Number(pendingCount))
    ? `${Number(pendingCount)} 条`
    : '未知';
  return [
    '拼多多疑似差评待处理提醒',
    `店铺名称：${account.shopName}`,
    `未处理疑似差评：${pendingText}`,
    `订单编号：${review.orderNo || review.orderSn || '-'}`,
    `星级：${Number(review.stars || review.descScore || 0) || '-'}`,
    `评价内容：${compactText(review.content || review.comment || '', 180) || '-'}`,
    `标记原因：${compactText(riskReason, 180) || '-'}`,
    feishuUrl ? `飞书台账：${feishuUrl}` : '',
  ].filter(Boolean).join('\n');
}

export function formatWecomRiskSummaryMessage({
  account = {},
  discoveredRiskCount,
  newRiskCount = 0,
  failedCount = 0,
  pendingCount,
  feishuUrl = '',
} = {}) {
  const hasPendingCount = Number.isFinite(Number(pendingCount));
  const pendingNumber = hasPendingCount ? Number(pendingCount) : null;
  const pendingLine = hasPendingCount
    ? (pendingNumber > 0
      ? `未处理疑似差评：${pendingNumber} 条，请及时处理。`
      : '飞书台账暂无未处理疑似差评，本次疑似差评已全部处理完成。')
    : '飞书未处理疑似差评：未知（飞书汇总查询失败，请打开台账确认）。';
  const hasDiscoveredCount = Number.isFinite(Number(discoveredRiskCount));
  return [
    '拼多多疑似差评待处理汇总',
    `店铺名称：${account.shopName || account.name || '-'}`,
    hasDiscoveredCount ? `本次发现疑似差评：${Number(discoveredRiskCount || 0)} 条` : '',
    `本次新增疑似差评：${Number(newRiskCount || 0)} 条`,
    pendingLine,
    Number(failedCount || 0) > 0 ? `飞书写入失败：${Number(failedCount)} 条` : '',
    feishuUrl ? `飞书台账：${feishuUrl}` : '',
  ].filter(Boolean).join('\n');
}

export async function notifyWecomRiskSummary({
  account = {},
  settings = {},
  discoveredRiskCount = 0,
  newRiskCount = 0,
  failedCount = 0,
  feishuClient = createFeishuClient(settings),
  wecomClient = createWecomClient(settings),
  feishuBotClient = createFeishuBotClient(settings),
} = {}) {
  const totalChanged = Number(discoveredRiskCount || 0) + Number(newRiskCount || 0) + Number(failedCount || 0);
  const wecomEnabled = Boolean(settings.wecomEnabled);
  const feishuBotEnabled = Boolean(settings.feishuBotEnabled);
  if (!wecomEnabled && !feishuBotEnabled) return { ok: true, status: 'disabled' };
  if (totalChanged <= 0) return { ok: true, status: 'no-risk' };

  try {
    const pendingCount = typeof feishuClient.countPendingRecords === 'function'
      ? await feishuClient.countPendingRecords().catch(() => null)
      : null;
    const message = formatWecomRiskSummaryMessage({
      account,
      discoveredRiskCount,
      newRiskCount,
      failedCount,
      pendingCount,
      feishuUrl: settings.feishuBitableUrl,
    });
    const results = [];
    const errors = [];
    if (wecomEnabled) {
      try {
        await wecomClient.sendText(message, ['@all']);
        results.push('wecom');
      } catch (err) {
        errors.push(`企业微信: ${err.message || String(err)}`);
      }
    }
    if (feishuBotEnabled) {
      try {
        await feishuBotClient.sendText(message);
        results.push('feishu-bot');
      } catch (err) {
        errors.push(`飞书群: ${err.message || String(err)}`);
      }
    }
    if (!results.length && errors.length) throw new Error(errors.join('; '));
    const notifiedAt = nowIso();
    return {
      ok: errors.length === 0,
      status: errors.length ? 'partial' : 'notified',
      pendingCount,
      wecomNotifiedAt: results.includes('wecom') ? notifiedAt : '',
      feishuBotNotifiedAt: results.includes('feishu-bot') ? notifiedAt : '',
      channels: results,
      error: errors.join('; '),
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      error: err.message || String(err),
    };
  }
}

export function createFeishuClient(settings = {}, fetchImpl = fetch) {
  let cachedToken = null;
  let cachedTokenExpireAt = 0;

  async function getTenantAccessToken() {
    if (cachedToken && Date.now() < cachedTokenExpireAt) return cachedToken;
    requireConfig(settings, ['feishuAppId', 'feishuAppSecret']);
    const payload = await fetchJson(FEISHU_TOKEN_URL, {
      fetchImpl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: settings.feishuAppId,
        app_secret: settings.feishuAppSecret,
      }),
    });
    const token = payload.tenant_access_token;
    if (!token) throw new Error(payload.msg || '飞书 tenant_access_token 获取失败');
    cachedToken = token;
    cachedTokenExpireAt = Date.now() + Math.max(Number(payload.expire || 3600) - 120, 60) * 1000;
    return cachedToken;
  }

  async function createRecord(fields) {
    requireConfig(settings, ['feishuAppToken', 'feishuTableId']);
    const token = await getTenantAccessToken();
    const url = `${FEISHU_API_BASE}/apps/${encodeURIComponent(settings.feishuAppToken)}/tables/${encodeURIComponent(settings.feishuTableId)}/records`;
    const payload = await fetchJson(url, {
      fetchImpl,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ fields }),
    });
    const recordId = payload?.data?.record?.record_id || payload?.data?.record_id || '';
    if (!recordId) throw new Error(payload.msg || '飞书记录创建失败');
    return { recordId, raw: payload };
  }

  async function countPendingRecords() {
    requireConfig(settings, ['feishuAppToken', 'feishuTableId']);
    const token = await getTenantAccessToken();
    let pageToken = '';
    let total = 0;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ page_size: '500' });
      if (pageToken) params.set('page_token', pageToken);
      const url = `${FEISHU_API_BASE}/apps/${encodeURIComponent(settings.feishuAppToken)}/tables/${encodeURIComponent(settings.feishuTableId)}/records?${params}`;
      const payload = await fetchJson(url, {
        fetchImpl,
        headers: { Authorization: `Bearer ${token}` },
      });
      const items = payload?.data?.items || [];
      total += items.filter(item => normalizeFieldValue(item?.fields?.处理状态) === '未处理').length;
      if (!payload?.data?.has_more) break;
      pageToken = payload?.data?.page_token || '';
      if (!pageToken) break;
    }
    return total;
  }

  return { createRecord, countPendingRecords };
}

export function createWecomClient(settings = {}, fetchImpl = fetch) {
  async function sendText(content, mentionedList = ['@all']) {
    requireConfig(settings, ['wecomWebhookUrl']);
    const payload = await fetchJson(settings.wecomWebhookUrl, {
      fetchImpl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        msgtype: 'text',
        text: {
          content,
          mentioned_list: mentionedList,
        },
      }),
    });
    if (payload.errcode !== undefined && Number(payload.errcode) !== 0) {
      throw new Error(payload.errmsg || '企业微信通知失败');
    }
    return { ok: true, raw: payload };
  }

  return { sendText };
}

export function createFeishuBotClient(settings = {}, fetchImpl = fetch) {
  async function sendText(content) {
    requireConfig(settings, ['feishuBotWebhookUrl']);
    const payload = await fetchJson(settings.feishuBotWebhookUrl, {
      fetchImpl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        msg_type: 'text',
        content: {
          text: content,
        },
      }),
    });
    const code = payload.code ?? payload.StatusCode;
    if (code !== undefined && Number(code) !== 0) {
      throw new Error(payload.msg || payload.StatusMessage || '飞书群机器人通知失败');
    }
    return { ok: true, raw: payload };
  }

  return { sendText };
}

export async function syncFlaggedReview({
  account = {},
  review = {},
  reason = '',
  settings = {},
  feishuClient = createFeishuClient(settings),
  wecomClient = createWecomClient(settings),
  markExternalRiskSync = defaultMarkExternalRiskSync,
  notifyWecom = false,
} = {}) {
  const riskCaseKey = buildRiskCaseKey(account, review);
  const accountId = account.id || 'default';

  if (review.feishuRecordId && review.riskSyncStatus === 'synced') {
    return { ok: true, status: 'already-synced', feishuRecordId: review.feishuRecordId, riskCaseKey };
  }

  if (!String(account.shopName || '').trim()) {
    markExternalRiskSync(review, {
      status: 'failed',
      riskCaseKey,
      error: '缺少真实店铺名称，未同步飞书',
    }, accountId);
    return { ok: false, status: 'missing-shop-name', riskCaseKey, error: '缺少真实店铺名称' };
  }

  if (!settings.feishuEnabled && !settings.wecomEnabled && !settings.feishuBotEnabled) {
    markExternalRiskSync(review, {
      status: 'skipped',
      riskCaseKey,
      error: '外部同步未开启',
    }, accountId);
    return { ok: true, status: 'disabled', riskCaseKey };
  }

  try {
    let feishuRecordId = review.feishuRecordId || '';
    let feishuSyncError = '';
    if (settings.feishuEnabled && !feishuRecordId) {
      try {
        const created = await feishuClient.createRecord(buildFeishuRiskFields({ account, review, reason }));
        feishuRecordId = created.recordId;
      } catch (err) {
        feishuSyncError = err.message || String(err);
      }
    }

    let pendingCount = null;
    if (notifyWecom && (settings.feishuEnabled || settings.wecomEnabled || settings.feishuBotEnabled) && typeof feishuClient.countPendingRecords === 'function') {
      pendingCount = await feishuClient.countPendingRecords().catch(() => null);
    }

    let wecomNotifiedAt = '';
    let wecomNotifyError = '';
    if (settings.wecomEnabled && notifyWecom) {
      try {
        await wecomClient.sendText(formatWecomRiskMessage({
          account,
          review,
          reason,
          feishuUrl: settings.feishuBitableUrl,
          pendingCount,
        }), ['@all']);
        wecomNotifiedAt = nowIso();
      } catch (err) {
        wecomNotifyError = err.message || String(err);
      }
    }

    const feishuOk = !settings.feishuEnabled || Boolean(feishuRecordId);
    const wecomOk = !settings.wecomEnabled || !notifyWecom || Boolean(wecomNotifiedAt);
    const hasAnyExternalSuccess = Boolean(feishuRecordId || wecomNotifiedAt);
    const status = feishuOk && wecomOk
      ? (hasAnyExternalSuccess ? 'synced' : 'summary-pending')
      : (hasAnyExternalSuccess ? 'partial' : 'failed');
    const error = [feishuSyncError, wecomNotifyError].filter(Boolean).join('; ');
    markExternalRiskSync(review, {
      status,
      riskCaseKey,
      feishuRecordId,
      feishuSyncedAt: feishuRecordId ? nowIso() : '',
      wecomNotifiedAt,
      wecomNotifyError,
      wecomNotificationDeferred: Boolean(settings.wecomEnabled && !notifyWecom),
      error,
    }, accountId);

    return {
      ok: status !== 'failed',
      status,
      riskCaseKey,
      feishuRecordId,
      pendingCount,
      wecomNotifiedAt,
      wecomNotifyError,
      wecomNotificationDeferred: Boolean(settings.wecomEnabled && !notifyWecom),
      error,
    };
  } catch (err) {
    markExternalRiskSync(review, {
      status: 'failed',
      riskCaseKey,
      error: err.message || String(err),
    }, accountId);
    return {
      ok: false,
      status: 'failed',
      riskCaseKey,
      error: err.message || String(err),
    };
  }
}
