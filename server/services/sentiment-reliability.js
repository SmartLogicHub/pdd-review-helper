const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

const FORMAT_CORRECTION = `

上一次输出格式不合格，请修正：只返回一个完整、可解析的严格 JSON 对象，不要输出 Markdown、代码块或解释，且必须包含 label、can_auto_reply、is_real_negative、reason、risk_words、safe_positive_words。`;

export class SentimentReliabilityError extends Error {
  constructor({ kind, message, retryable = false, attempts = 1, cause } = {}) {
    super(message || 'AI情感分析失败');
    this.name = 'SentimentReliabilityError';
    this.kind = kind || 'unknown';
    this.retryable = Boolean(retryable);
    this.attempts = Number(attempts || 1);
    if (cause) this.cause = cause;
  }
}

export function sanitizeSentimentError(error) {
  const message = String(error?.message || error || 'AI情感分析失败')
    .replace(/Bearer\s+[^\s,;]+/gi, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return message.slice(0, 180) || 'AI情感分析失败';
}

export function classifySentimentError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const safeDetail = sanitizeSentimentError(error);
  const lower = safeDetail.toLowerCase();

  if (error?.kind === 'invalid_json' || error?.kind === 'invalid_schema') {
    return {
      kind: error.kind,
      retryable: true,
      publicMessage: error.kind === 'invalid_schema'
        ? 'AI判断结果字段不完整或标签非法'
        : 'AI判断结果不是有效JSON',
    };
  }
  if (status === 401 || /authentication|invalid api key|incorrect api key|unauthorized/.test(lower)) {
    return { kind: 'authentication', retryable: false, publicMessage: 'DeepSeek API Key 无效或未授权' };
  }
  if (status === 402 || /insufficient balance|insufficient quota|余额不足|账户余额/.test(lower)) {
    return { kind: 'billing', retryable: false, publicMessage: 'DeepSeek 账户余额不足' };
  }
  if (status === 403) {
    return { kind: 'permission', retryable: false, publicMessage: 'DeepSeek API 无访问权限' };
  }
  if (status === 429 || /rate.?limit|too many requests|请求太频繁/.test(lower)) {
    return { kind: 'rate_limited', retryable: true, publicMessage: 'DeepSeek 请求过于频繁' };
  }
  if (status === 408 || RETRYABLE_NETWORK_CODES.has(code) || /timed?\s*out|timeout|fetch failed|network/.test(lower)) {
    return { kind: 'network', retryable: true, publicMessage: 'DeepSeek 网络请求超时或中断' };
  }
  if (status >= 500 && status <= 599) {
    return { kind: 'server', retryable: true, publicMessage: `DeepSeek 服务暂时异常 (${status})` };
  }
  return { kind: 'unknown', retryable: false, publicMessage: safeDetail };
}

function defaultSleep(delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

export async function requestSentimentWithRetry({
  request,
  parse,
  prompt,
  sleep = defaultSleep,
  maxAttempts = 3,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('缺少情感分析请求函数');
  if (typeof parse !== 'function') throw new TypeError('缺少情感分析解析函数');

  const limit = Math.max(1, Number(maxAttempts || 1));
  let correction = '';

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    try {
      const text = await request(`${String(prompt || '')}${correction}`, { attempt });
      const result = parse(text);
      return { result, attempts: attempt };
    } catch (error) {
      const classified = classifySentimentError(error);
      const finalAttempt = attempt >= limit || !classified.retryable;
      if (finalAttempt) {
        throw new SentimentReliabilityError({
          ...classified,
          message: classified.publicMessage,
          attempts: attempt,
          cause: error,
        });
      }
      if (classified.kind === 'invalid_json' || classified.kind === 'invalid_schema') {
        correction = FORMAT_CORRECTION;
      }
      await sleep(1000 * (2 ** (attempt - 1)));
    }
  }

  throw new SentimentReliabilityError({ kind: 'unknown', message: 'AI情感分析失败', attempts: limit });
}
