const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 200;

function compactSentiment(result = {}) {
  return {
    label: result.label || '',
    flagged: Boolean(result.flagged),
    uncertain: Boolean(result.uncertain),
    neutral: Boolean(result.neutral),
    reason: result.reason || '',
    riskWords: result.riskWords || result.risk_words || [],
    safePositiveWords: result.safePositiveWords || result.safe_positive_words || [],
  };
}

/**
 * 情感判断缓存：同一条评价在「内容 + 星级 + 商品/店铺 + 提示词全文 + 模型参数」都没变时，
 * 直接复用上次的结论，不再调用 AI。
 *
 * - 指纹包含提示词全文：改了提示词会自动重判，不会沿用过时结论。
 * - AI 调用失败的结果不缓存，下次运行照常重试。
 * - 懒加载：没用到就不读文件；flush 时顺带清理超过 maxAgeDays 的旧记录。
 */
export function createSentimentCache({
  load,
  save,
  fingerprint,
  now = () => Date.now(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
} = {}) {
  let entries = null;
  let dirty = false;
  const stats = { hits: 0, misses: 0, stored: 0 };

  function ensureLoaded() {
    if (entries) return entries;
    try {
      const loaded = typeof load === 'function' ? load() : null;
      entries = loaded && typeof loaded === 'object' ? loaded : {};
    } catch {
      entries = {};
    }
    return entries;
  }

  return {
    fingerprint(...args) {
      try {
        return typeof fingerprint === 'function' ? String(fingerprint(...args) || '') : '';
      } catch {
        return '';
      }
    },

    get(key, fp) {
      if (!key || !fp) return null;
      const entry = ensureLoaded()[key];
      if (entry?.fp === fp && entry.result) {
        stats.hits += 1;
        return entry.result;
      }
      stats.misses += 1;
      return null;
    },

    set(key, fp, result) {
      if (!key || !fp || !result || result.analysisFailed) return;
      ensureLoaded()[key] = { fp, at: now(), result: compactSentiment(result) };
      stats.stored += 1;
      dirty = true;
    },

    flush() {
      if (!dirty || !entries) return;
      const cutoff = now() - maxAgeDays * DAY_MS;
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || Number(entry.at || 0) < cutoff) delete entries[key];
      }
      try {
        if (typeof save === 'function') save(entries);
        dirty = false;
      } catch {
        // 写缓存失败不影响回复流程，下次运行最多多调几次 AI
      }
    },

    stats() {
      return { ...stats };
    },
  };
}
