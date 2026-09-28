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
      const error = new Error(payload?.msg || payload?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export const RISK_TABLE_NAME = '拼多多疑似差评';
export const RISK_TABLE_REQUIRED_FIELDS = ['店铺名称', '订单编号', '星级', '评价内容', '标记原因', '处理状态', '发现时间'];
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000;

// 飞书的业务错误大多是 HTTP 200 + code≠0。不检查 code，「表不存在」之类的失败会被当成「查到 0 条」。
const FEISHU_ERROR_HINTS = [
  [/TableIdNotFound/i, `飞书数据表不存在，请在系统设置里重新复制「${RISK_TABLE_NAME}」表的链接`],
  [/FieldNameNotFound|FieldIdNotFound/i, `飞书表缺少所需字段，当前配置的表可能不是「${RISK_TABLE_NAME}」表`],
  [/BaseTokenNotFound|WrongBaseToken|AppTokenNotFound|NOTEXIST/i, '飞书多维表格链接无效，请重新复制表格链接'],
  [/Forbidden|RolePermNotAllow|NoPermission|permission/i, '飞书应用没有这张多维表格的编辑权限，请在多维表格里把应用添加为协作者并授予「可编辑」'],
  [/app ?secret|app_secret|invalid app|app not exist/i, '飞书 App ID 或 App Secret 无效'],
];

function feishuError(payload = {}) {
  const code = payload.code;
  const msg = String(payload.msg || payload.message || '').trim() || '未知错误';
  const hint = FEISHU_ERROR_HINTS.find(([pattern]) => pattern.test(msg))?.[1];
  const error = new Error(hint ? `${hint}（${msg}，code ${code}）` : `飞书接口错误：${msg}（code ${code}）`);
  error.feishuCode = Number(code);
  error.feishuMsg = msg;
  return error;
}

async function feishuJson(url, options = {}) {
  let payload;
  try {
    payload = await fetchJson(url, options);
  } catch (err) {
    if (err.payload?.code !== undefined) throw feishuError(err.payload);
    throw err;
  }
  if (payload?.code !== undefined && Number(payload.code) !== 0) throw feishuError(payload);
  return payload;
}

// token 和表结构校验结果按 fetch 实现共享：生产环境里所有客户端共用一份，测试里每个 mock fetch 各自隔离。
const sharedFeishuCaches = new WeakMap();

function feishuCachesFor(fetchImpl) {
  let caches = sharedFeishuCaches.get(fetchImpl);
  if (!caches) {
    caches = { tokens: new Map(), schemas: new Map() };
    sharedFeishuCaches.set(fetchImpl, caches);
  }
  return caches;
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
  failureReason = '',
  pendingCount,
  feishuUrl = '',
} = {}) {
  const failed = Number(failedCount || 0);
  const hasPendingCount = Number.isFinite(Number(pendingCount));
  const pendingNumber = hasPendingCount ? Number(pendingCount) : null;
  let pendingLine = '飞书未处理疑似差评：未知（飞书汇总查询失败，请打开台账确认）。';
  if (hasPendingCount && pendingNumber > 0) {
    pendingLine = `未处理疑似差评：${pendingNumber} 条，请及时处理。`;
  } else if (hasPendingCount && failed > 0) {
    // 有写入失败时不能说「已全部处理完成」：失败的那些根本没进台账
    pendingLine = '飞书台账暂无未处理疑似差评，但本次有疑似差评未能写入台账，请检查飞书配置。';
  } else if (hasPendingCount) {
    pendingLine = '飞书台账暂无未处理疑似差评，本次疑似差评已全部处理完成。';
  }
  const hasDiscoveredCount = Number.isFinite(Number(discoveredRiskCount));
  return [
    '拼多多疑似差评待处理汇总',
    `店铺名称：${account.shopName || account.name || '-'}`,
    hasDiscoveredCount ? `本次发现疑似差评：${Number(discoveredRiskCount || 0)} 条` : '',
    `本次新增疑似差评：${Number(newRiskCount || 0)} 条`,
    pendingLine,
    failed > 0 ? `飞书写入失败：${failed} 条` : '',
    failed > 0 && failureReason ? `失败原因：${compactText(failureReason, 160)}` : '',
    feishuUrl ? `飞书台账：${feishuUrl}` : '',
  ].filter(Boolean).join('\n');
}

export async function notifyWecomRiskSummary({
  account = {},
  settings = {},
  discoveredRiskCount = 0,
  newRiskCount = 0,
  failedCount = 0,
  failureReason = '',
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
      failureReason,
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
  const caches = feishuCachesFor(fetchImpl);

  async function getTenantAccessToken() {
    requireConfig(settings, ['feishuAppId', 'feishuAppSecret']);
    const cacheKey = `${settings.feishuAppId}\n${settings.feishuAppSecret}`;
    const cached = caches.tokens.get(cacheKey);
    if (cached && Date.now() < cached.expireAt) return cached.token;
    const payload = await feishuJson(FEISHU_TOKEN_URL, {
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
    caches.tokens.set(cacheKey, {
      token,
      expireAt: Date.now() + Math.max(Number(payload.expire || 3600) - 120, 60) * 1000,
    });
    return token;
  }

  function tableUrl(suffix = '') {
    requireConfig(settings, ['feishuAppToken', 'feishuTableId']);
    return `${FEISHU_API_BASE}/apps/${encodeURIComponent(settings.feishuAppToken)}/tables/${encodeURIComponent(settings.feishuTableId)}${suffix}`;
  }

  async function listFieldNames() {
    const token = await getTenantAccessToken();
    const names = [];
    let pageToken = '';
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({ page_size: '100' });
      if (pageToken) params.set('page_token', pageToken);
      const payload = await feishuJson(tableUrl(`/fields?${params}`), {
        fetchImpl,
        headers: { Authorization: `Bearer ${token}` },
      });
      for (const item of payload?.data?.items || []) {
        if (item?.field_name) names.push(item.field_name);
      }
      if (!payload?.data?.has_more) break;
      pageToken = payload?.data?.page_token || '';
      if (!pageToken) break;
    }
    return names;
  }

  // 校验表里有没有写入所需的字段。结果缓存 10 分钟：选错表时第一条就失败并说明原因，不再逐条白跑。
  async function validateRiskTable({ force = false } = {}) {
    const cacheKey = `${settings.feishuAppToken}:${settings.feishuTableId}`;
    const cached = caches.schemas.get(cacheKey);
    if (!force && cached && Date.now() - cached.checkedAt < SCHEMA_CACHE_TTL_MS) return cached.result;
    let result;
    try {
      const fieldNames = await listFieldNames();
      const missingFields = RISK_TABLE_REQUIRED_FIELDS.filter(name => !fieldNames.includes(name));
      result = missingFields.length
        ? {
          ok: false,
          fieldNames,
          missingFields,
          error: `飞书表缺少字段：${missingFields.join('、')}。当前配置的表可能不是「${RISK_TABLE_NAME}」表，请在系统设置里重新复制正确表格的链接`,
        }
        : { ok: true, fieldNames, missingFields: [] };
    } catch (err) {
      // 只缓存飞书明确返回的业务错误（表不存在、无权限等）；网络抖动不缓存，下次重试
      if (err.feishuCode === undefined) throw err;
      result = { ok: false, fieldNames: [], missingFields: [], error: err.message };
    }
    caches.schemas.set(cacheKey, { checkedAt: Date.now(), result });
    return result;
  }

  async function ensureRiskTable() {
    const result = await validateRiskTable();
    if (!result.ok) throw new Error(result.error);
  }

  async function createRecord(fields) {
    await ensureRiskTable();
    const token = await getTenantAccessToken();
    const payload = await feishuJson(tableUrl('/records'), {
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
    await ensureRiskTable();
    const token = await getTenantAccessToken();
    let pageToken = '';
    let total = 0;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ page_size: '500' });
      if (pageToken) params.set('page_token', pageToken);
      const payload = await feishuJson(tableUrl(`/records?${params}`), {
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

  return { createRecord, countPendingRecords, validateRiskTable };
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
