import {
  getAccountsState,
  getCurrentAccount,
  getReviews,
  saveReviews,
} from '../data/store.js';
import { classifyReviewStatus } from './review-normalizer.js';
import {
  DEFAULT_SENTIMENT_PROMPT,
  normalizeSentimentResult,
  parseSentimentResponse,
  repairSentimentPrompt,
  renderSentimentPrompt,
  sentimentContextFromInput,
  statusFromSentimentResult,
  validateSentimentPrompt,
} from './sentiment-core.js';

export {
  DEFAULT_SENTIMENT_PROMPT,
  normalizeSentimentResult,
  parseSentimentResponse,
  repairSentimentPrompt,
  renderSentimentPrompt,
  sentimentContextFromInput,
  statusFromSentimentResult,
  validateSentimentPrompt,
};

function canReanalyzeReview(review = {}) {
  const status = classifyReviewStatus(review);
  return !['replied', 'blocked'].includes(status);
}

function resultPatch(result = {}) {
  const label = result.label || 'uncertain_skip';
  const reason = result.reason || '';
  const base = {
    sentimentLabel: label,
    riskWords: result.riskWords || result.risk_words || [],
    safePositiveWords: result.safePositiveWords || result.safe_positive_words || [],
  };
  if (label === 'risk_manual_review') {
    return {
      ...base,
      flagged: true,
      flagReason: reason || '当前商品存在负面体验',
      uncertainSkip: false,
      uncertainReason: '',
      neutralReply: false,
      neutralReason: '',
      riskSyncStatus: 'pending',
      flaggedAt: new Date().toISOString(),
    };
  }
  if (label === 'neutral_auto_reply') {
    return {
      ...base,
      flagged: false,
      flagReason: '',
      uncertainSkip: false,
      uncertainReason: '',
      neutralReply: true,
      neutralReason: reason || '中性评价，使用保守回复',
      neutralAt: new Date().toISOString(),
    };
  }
  if (label === 'uncertain_skip') {
    return {
      ...base,
      flagged: false,
      flagReason: '',
      uncertainSkip: true,
      uncertainReason: reason || '评价无法安全判断，跳过自动回复',
      neutralReply: false,
      neutralReason: '',
      uncertainAt: new Date().toISOString(),
    };
  }
  return {
    ...base,
    flagged: false,
    flagReason: '',
    uncertainSkip: false,
    uncertainReason: '',
    neutralReply: false,
    neutralReason: '',
  };
}

function classifyAfterPatch(review = {}, patch = {}) {
  return classifyReviewStatus({ ...review, ...patch });
}

function emptyReanalysisSummary({ apply = false, scope = 'current' } = {}) {
  return {
    apply: Boolean(apply),
    scope,
    scanned: 0,
    skipped: 0,
    changed: 0,
    failed: 0,
    accounts: [],
    transitions: {},
    changes: [],
  };
}

function addTransition(summary, fromStatus, toStatus) {
  const key = `${fromStatus}->${toStatus}`;
  summary.transitions[key] = Number(summary.transitions[key] || 0) + 1;
}

export async function reanalyzeStoredReviews({
  accountId = '',
  scope = accountId ? 'account' : 'current',
  apply = false,
  analyzer,
} = {}) {
  if (typeof analyzer !== 'function') {
    throw new Error('缺少情感分析函数');
  }

  const state = getAccountsState();
  const current = getCurrentAccount();
  const requestedAccount = accountId
    ? (state.accounts.find(account => account.id === accountId) || { id: accountId, name: accountId, shopName: '' })
    : current;
  const accounts = scope === 'all'
    ? state.accounts
    : [requestedAccount];
  const summary = emptyReanalysisSummary({ apply, scope });

  for (const account of accounts) {
    const reviews = getReviews(account.id);
    const accountSummary = {
      accountId: account.id,
      accountName: account.name,
      shopName: account.shopName || '',
      scanned: 0,
      skipped: 0,
      changed: 0,
      failed: 0,
    };

    for (const review of reviews) {
      const beforeStatus = classifyReviewStatus(review);
      if (!canReanalyzeReview(review)) {
        summary.skipped += 1;
        accountSummary.skipped += 1;
        continue;
      }

      summary.scanned += 1;
      accountSummary.scanned += 1;
      try {
        const result = normalizeSentimentResult(await analyzer(review, account));
        const patch = resultPatch(result);
        const afterStatus = classifyAfterPatch(review, patch);
        if (beforeStatus !== afterStatus) {
          summary.changed += 1;
          accountSummary.changed += 1;
          addTransition(summary, beforeStatus, afterStatus);
          summary.changes.push({
            accountId: account.id,
            reviewId: review.reviewId || review.id || '',
            orderNo: review.orderNo || review.orderSn || '',
            from: beforeStatus,
            to: afterStatus,
            reason: patch.flagReason || patch.neutralReason || patch.uncertainReason || result.reason || '',
          });
        }
        if (apply) Object.assign(review, patch);
      } catch (err) {
        summary.failed += 1;
        accountSummary.failed += 1;
        summary.changes.push({
          accountId: account.id,
          reviewId: review.reviewId || review.id || '',
          orderNo: review.orderNo || review.orderSn || '',
          from: beforeStatus,
          to: beforeStatus,
          error: err.message || String(err),
        });
      }
    }

    if (apply) saveReviews(reviews, account.id);
    summary.accounts.push(accountSummary);
  }

  return summary;
}
