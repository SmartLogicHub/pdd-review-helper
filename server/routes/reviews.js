import { Router } from 'express';
import { fetchReviews, submitReplyForStoredReview } from '../services/playwright.js';
import { getReply } from '../services/reply-strategy.js';
import { getAccountsState, getReviews, addReviewsWithStats, markReplied, markReplyBlocked, getStats, clearReplied, clearAll, getSettings } from '../data/store.js';
import { automationManager } from '../services/automation.js';
import { syncFlaggedReview } from '../services/risk-sync.js';
import { sendAutomationError } from '../services/automation-api-response.js';
import {
  classifyReviewStatus,
  filterReviewRecordsByStatus,
  normalizeReviewStatusFilter,
  sameReviewIdentity,
} from '../services/review-normalizer.js';

const router = Router();
const DEFAULT_FETCH_MAX_PAGES = 3;

function findReviewByRequestId(reviews = [], id = '') {
  const identity = { id, reviewId: id, orderNo: id, orderSn: id };
  return reviews.find(review => sameReviewIdentity(review, identity));
}

export function normalizeFetchMaxPages(value, fallback = DEFAULT_FETCH_MAX_PAGES) {
  if (value === undefined || value === null || value === '') return fallback;
  const pages = Number(value);
  return Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : fallback;
}

router.get('/stats', (req, res) => {
  res.json(getStats(req.query.accountId));
});

router.get('/', (req, res) => {
  const reviews = getReviews(req.query.accountId);
  const { replied, flagged, status = 'all', page = 1, size = 20 } = req.query;
  const normalizedStatus = normalizeReviewStatusFilter({ status, replied, flagged });
  const filtered = filterReviewRecordsByStatus(reviews, normalizedStatus);

  const start = (page - 1) * size;
  const paged = filtered.slice(start, start + Number(size));
  res.json({ total: filtered.length, list: paged });
});

router.post('/fetch', async (req, res) => {
  try {
    const activeJob = automationManager.getActiveJob();
    if (activeJob) {
      return sendAutomationError(res, new Error('自动化任务仍在运行或停止中，请等待结束后再抓取最新评论'), {
        suggestion: '请等待当前自动化任务结束，或先停止当前任务后再抓取最新评论。',
      });
    }
    const settings = getSettings();
    const accountId = req.body?.accountId || req.query.accountId;
    const maxPages = req.body?.maxPages ?? req.query.maxPages;
    const dryRun = Boolean(req.body?.dryRun || req.query.dryRun === 'true');
    if (dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        message: 'dryRun：将抓取当前账号最新评论，但不会打开浏览器或写入本地评价池',
        accountId: accountId || null,
        reviewDays: settings.reviewDays,
        maxPages: normalizeFetchMaxPages(maxPages),
      });
    }
    const newReviews = await fetchReviews({
      accountId,
      reviewDays: settings.reviewDays,
      maxPages: normalizeFetchMaxPages(maxPages),
      analyzeOnFetch: false,
    });
    const result = addReviewsWithStats(newReviews, accountId);
    res.json({
      success: true,
      fetchedCount: result.fetchedCount,
      newCount: result.newCount,
      total: result.total,
      replied: result.replied,
      unreplied: result.unreplied,
      pending: result.pending,
      neutral: result.neutral,
      actionable: result.actionable,
      flagged: result.flagged,
      blocked: result.blocked,
      uncertain: result.uncertain,
    });
  } catch (err) {
    sendAutomationError(res, err);
  }
});

router.post('/:id/generate', async (req, res) => {
  try {
    const reviews = getReviews(req.query.accountId);
    const review = findReviewByRequestId(reviews, req.params.id);
    if (!review) return res.status(404).json({ error: '评价不存在' });

    const currentStatus = classifyReviewStatus(review);
    const result = await getReply(review, { neutral: currentStatus === 'neutral' });
    res.json({ reply: result.reply, method: result.method });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/sync-risk', async (req, res) => {
  try {
    const accountId = req.body?.accountId || req.query.accountId;
    const settings = getSettings();
    const state = getAccountsState();
    const account = state.accounts.find(item => item.id === (accountId || state.currentAccountId));
    const reviews = getReviews(account?.id);
    const review = findReviewByRequestId(reviews, req.params.id);
    if (!account) return res.status(404).json({ error: '账号不存在' });
    if (!review) return res.status(404).json({ error: '评价不存在' });
    if (!review.flagged) return res.status(409).json({ error: '当前评价不是疑似差评，不需要同步' });
    const result = await syncFlaggedReview({
      account,
      review,
      reason: review.flagReason,
      settings,
    });
    if (!result.ok) return res.status(409).json({ error: result.error || '同步失败', result });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply) return res.status(400).json({ error: '回复内容不能为空' });

    const accountId = req.body?.accountId || req.query.accountId;
    const settings = getSettings();
    const reviews = getReviews(accountId);
    const review = findReviewByRequestId(reviews, req.params.id);
    if (!review) return res.status(404).json({ error: '评价不存在' });

    const currentStatus = classifyReviewStatus(review);
    if (!['pending', 'neutral'].includes(currentStatus)) {
      return res.status(409).json({
        error: '当前评价已经不是可回复状态，已停止提交',
        skipped: true,
        reviewStatus: currentStatus,
        blocked: currentStatus === 'blocked',
      });
    }

    const result = await submitReplyForStoredReview(review, reply, { accountId, reviewDays: settings.reviewDays });
    if (result?.blocked) {
      markReplyBlocked(result.review || review, result.reason, accountId);
      return res.status(409).json({
        error: result.reason,
        blocked: true,
        skipped: true,
        reviewStatus: 'blocked',
      });
    }
    if (result?.skipped) {
      if (result.reviewStatus === 'replied') {
        markReplied(result.review || review, accountId);
      } else if (result.reviewStatus === 'blocked') {
        markReplyBlocked(result.review || review, result.reason, accountId);
      }
      return res.status(409).json({
        error: result.reason,
        skipped: true,
        blocked: result.reviewStatus === 'blocked',
        reviewStatus: result.reviewStatus,
      });
    }

    markReplied(result.review || review, accountId);
    res.json({ success: true, strategy: result.strategy });
  } catch (err) {
    if (/不可回复|不可评论|不支持回复|暂不支持回复/.test(err.message || '')) {
      markReplyBlocked(req.params.id, err.message, req.body?.accountId || req.query.accountId);
      return res.status(409).json({ error: err.message, blocked: true });
    }
    res.status(500).json({ error: err.message });
  }
});

router.post('/reply-all', async (req, res) => {
  res.status(410).json({ error: '旧批量回复接口已停用，请使用 /api/automation/reply-good-reviews' });
});

router.delete('/replied', (req, res) => {
  const remaining = clearReplied(req.query.accountId);
  res.json({ success: true, remaining });
});

router.delete('/', (req, res) => {
  clearAll(req.query.accountId);
  res.json({ success: true, remaining: 0 });
});

export default router;
