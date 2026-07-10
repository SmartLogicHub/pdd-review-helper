import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import {
  getAccountsState,
  getCurrentAccount,
  getSettings,
  markReplied,
  markReplyBlocked,
  markReviewFlagged,
  markReviewNeutral,
  markReviewUncertain,
} from '../data/store.js';
import { getReply } from './reply-strategy.js';
import { detectShopNameForAccount, e2eDryRunAllPages, replyAll } from './playwright.js';
import { notifyWecomRiskSummary, syncFlaggedReview } from './risk-sync.js';
import { effectiveFlagReason } from './review-normalizer.js';

export function createAutomationManager({
  runner = replyAll,
  e2eRunner = e2eDryRunAllPages,
  getSettings: readSettings = getSettings,
  getCurrentAccount: readCurrentAccount = getCurrentAccount,
  listAccounts: readAccounts = getAccountsState,
  genReply = getReply,
  markReplySuccess = markReplied,
  markReplyBlocked: markBlocked = markReplyBlocked,
  markReviewFlagged: markFlagged = markReviewFlagged,
  markReviewNeutral: markNeutral = markReviewNeutral,
  markReviewUncertain: markUncertain = markReviewUncertain,
  detectShopName = async account => account,
  syncRiskReview = syncFlaggedReview,
  notifyRiskSummary = notifyWecomRiskSummary,
} = {}) {
  const jobs = new Map();
  const emitter = new EventEmitter();

  function isActive(job) {
    return job?.status === 'running' || job?.status === 'stopping';
  }

  function findActiveJob() {
    for (const job of jobs.values()) {
      if (isActive(job)) return job;
    }
    return null;
  }

  function ensureNoActiveJob() {
    if (findActiveJob()) {
      throw new Error('已有自动化任务正在运行或停止，请等待结束后再操作');
    }
  }

  function emit(job, type, payload = {}) {
    const event = {
      type,
      jobId: job.id,
      at: new Date().toISOString(),
      ...payload,
    };
    job.events.push(event);
    emitter.emit(job.id, event);
    return event;
  }

  function resolveAccount(accountId) {
    try {
      if (accountId) {
        const state = readAccounts();
        const found = state.accounts.find(account => account.id === accountId);
        if (found) return found;
      }
      return readCurrentAccount();
    } catch {
      return { id: accountId || 'default', name: '默认账号' };
    }
  }

  function externalRiskSyncEnabled(settings = {}) {
    return Boolean(settings.feishuEnabled || settings.wecomEnabled || settings.feishuBotEnabled);
  }

  async function ensureShopName(account, { required = false, job = null } = {}) {
    if (account?.shopName) return account;
    if (!required) return account;
    emit(job, 'progress', {
      status: 'detect-shop-name',
      accountId: account.id,
      accountName: account.name,
      stage: '识别真实店铺名',
    });
    const detected = await detectShopName(account);
    return detected?.shopName ? detected : account;
  }

  function createRiskSummary() {
    return {
      discoveredRiskCount: 0,
      newRiskCount: 0,
      failedCount: 0,
      syncResults: [],
      notifyResult: null,
    };
  }

  async function flushRiskSummary(settings, account, riskSummary, job) {
    if (!riskSummary || (!settings.wecomEnabled && !settings.feishuBotEnabled)) return null;
    if (riskSummary.discoveredRiskCount + riskSummary.newRiskCount + riskSummary.failedCount <= 0) return null;
    const result = await notifyRiskSummary({
      account,
      settings,
      discoveredRiskCount: riskSummary.discoveredRiskCount,
      newRiskCount: riskSummary.newRiskCount,
      failedCount: riskSummary.failedCount,
    });
    riskSummary.notifyResult = result;
    emit(job, 'progress', {
      status: 'risk-summary',
      accountId: account.id,
      accountName: account.name,
      shopName: account.shopName || '',
      discoveredRiskCount: riskSummary.discoveredRiskCount,
      newRiskCount: riskSummary.newRiskCount,
      failedCount: riskSummary.failedCount,
      notifyResult: result,
    });
    return result;
  }

  function optionsForAccount(settings, account, options = {}, riskSummary = null) {
    return {
      ...options,
      reviewDays: settings.reviewDays || 90,
      accountId: account.id,
      accountName: account.name,
      shopName: account.shopName || '',
      onReplySuccess: review => markReplySuccess(review, account.id),
      onReplyBlocked: (review, reason) => markBlocked(review, reason, account.id),
      onReviewFlagged: async (review, reason) => {
        const riskReason = effectiveFlagReason(review, reason);
        const flaggedReview = markFlagged(review, riskReason, account.id) || { ...review, flagReason: riskReason };
        if (!externalRiskSyncEnabled(settings)) return { ok: true, status: 'external-sync-disabled' };
        const result = await syncRiskReview({
          account,
          review: flaggedReview,
          reason: riskReason,
          settings,
          notifyWecom: false,
        });
        if (riskSummary) {
          riskSummary.discoveredRiskCount += 1;
          riskSummary.syncResults.push(result);
          if (!result?.ok) riskSummary.failedCount += 1;
          else if (!['already-synced', 'disabled'].includes(result.status)) riskSummary.newRiskCount += 1;
        }
        return result;
      },
      onReviewNeutral: (review, reason) => markNeutral(review, reason, account.id),
      onReviewUncertain: (review, reason) => markUncertain(review, reason, account.id),
    };
  }

  function startReplyGoodReviews(options = {}) {
    const settings = readSettings();
    if (!settings.autoReplyEnabled && !options.dryRun) {
      throw new Error('请先在系统设置中开启自动回复');
    }
    ensureNoActiveJob();
    const account = resolveAccount(options.accountId);

    const job = {
      id: randomUUID(),
      type: 'reply-good-reviews',
      status: 'running',
      createdAt: new Date().toISOString(),
      events: [],
      result: null,
      error: '',
      stopRequested: false,
      promise: null,
    };
    jobs.set(job.id, job);

    job.promise = (async () => {
      try {
        let accountForRun = account;
        if (externalRiskSyncEnabled(settings)) {
          accountForRun = await ensureShopName(account, {
            required: true,
            job,
          });
        }
        const riskSummary = createRiskSummary();
        let result;
        try {
          result = await runner(
            genReply,
            progress => emit(job, 'progress', progress),
            {
              ...optionsForAccount(settings, accountForRun, options, riskSummary),
              stopSignal: {
                isStopped: () => job.stopRequested,
              },
            }
          );
        } finally {
          await flushRiskSummary(settings, accountForRun, riskSummary, job);
        }
        job.result = result;
        job.status = result?.stopped ? 'stopped' : 'done';
        emit(job, job.status, result || {});
      } catch (err) {
        job.error = err.message || String(err);
        job.status = 'error';
        emit(job, 'error', { error: job.error });
      }
      return job;
    })();

    emit(job, 'started', {
      maxCount: options.maxCount ?? 0,
      dryRun: Boolean(options.dryRun),
      reviewDays: settings.reviewDays || 90,
      accountId: account.id,
      accountName: account.name,
      shopName: account.shopName || '',
    });

    return publicJob(job);
  }

  function startE2EDryRun(options = {}) {
    const settings = readSettings();
    const account = resolveAccount(options.accountId);
    return startJob({
      type: 'e2e-dry-run',
      runner: e2eRunner,
      options: {
        ...options,
        dryRun: true,
        safetyMax: options.safetyMax ?? 0,
        reviewDays: settings.reviewDays || 90,
        accountId: account.id,
        accountName: account.name,
      },
      startedPayload: {
        dryRun: true,
        safetyMax: options.safetyMax ?? 0,
        reviewDays: settings.reviewDays || 90,
        accountId: account.id,
        accountName: account.name,
      },
    });
  }

  function startReplyAllAccounts(options = {}) {
    const settings = readSettings();
    if (!settings.autoReplyEnabled && !options.dryRun) {
      throw new Error('请先在系统设置中开启自动回复');
    }
    ensureNoActiveJob();
    const state = readAccounts();
    const accounts = state.accounts || [];
    const job = {
      id: randomUUID(),
      type: 'reply-all-accounts',
      status: 'running',
      createdAt: new Date().toISOString(),
      events: [],
      result: null,
      error: '',
      stopRequested: false,
      promise: null,
    };
    jobs.set(job.id, job);

    job.promise = (async () => {
      const summary = {
        accountCount: accounts.length,
        accounts: [],
        total: 0,
        success: 0,
        positiveReplies: 0,
        neutralReplies: 0,
        failed: 0,
        skipped: 0,
        skippedFlagged: 0,
        skippedUncertain: 0,
        skippedBlocked: 0,
        stopped: false,
        reviewDays: settings.reviewDays || 90,
      };
      try {
        for (const account of accounts) {
          if (job.stopRequested) break;
          let accountForRun = account;
          try {
            accountForRun = await ensureShopName(account, { required: true, job });
          } catch (err) {
            const accountResult = {
              accountId: account.id,
              accountName: account.name,
              shopName: account.shopName || '',
              status: 'error',
              total: 0,
              success: 0,
              failed: 1,
              skipped: 0,
              error: err.message || String(err),
            };
            summary.accounts.push(accountResult);
            summary.failed += 1;
            emit(job, 'progress', { status: 'account-done', ...accountResult });
            continue;
          }
          emit(job, 'progress', {
            status: 'account-start',
            accountId: accountForRun.id,
            accountName: accountForRun.name,
            shopName: accountForRun.shopName || '',
            reviewDays: settings.reviewDays || 90,
          });
          let accountResult;
          const riskSummary = createRiskSummary();
          try {
            const result = await runner(
              genReply,
              progress => emit(job, 'progress', {
                ...progress,
                accountId: accountForRun.id,
                accountName: accountForRun.name,
                shopName: accountForRun.shopName || '',
              }),
              {
                ...optionsForAccount(settings, accountForRun, options, riskSummary),
                stopSignal: {
                  isStopped: () => job.stopRequested,
                },
              }
            );
            accountResult = {
              accountId: accountForRun.id,
              accountName: accountForRun.name,
              shopName: accountForRun.shopName || '',
              ...result,
            };
          } catch (err) {
            accountResult = {
              accountId: accountForRun.id,
              accountName: accountForRun.name,
              shopName: accountForRun.shopName || '',
              status: 'error',
              total: 0,
              success: 0,
              failed: 1,
              skipped: 0,
              error: err.message || String(err),
            };
          } finally {
            await flushRiskSummary(settings, accountForRun, riskSummary, job);
          }
          summary.accounts.push(accountResult);
          summary.total += Number(accountResult?.total || 0);
          summary.success += Number(accountResult?.success || 0);
          summary.positiveReplies += Number(accountResult?.positiveReplies || 0);
          summary.neutralReplies += Number(accountResult?.neutralReplies || 0);
          summary.failed += Number(accountResult?.failed || 0);
          summary.skipped += Number(accountResult?.skipped || 0);
          summary.skippedFlagged += Number(accountResult?.skippedFlagged || 0);
          summary.skippedUncertain += Number(accountResult?.skippedUncertain || 0);
          summary.skippedBlocked += Number(accountResult?.skippedBlocked || 0);
          emit(job, 'progress', {
            status: 'account-done',
            ...accountResult,
          });
        }
        summary.stopped = job.stopRequested;
        job.result = summary;
        job.status = summary.stopped ? 'stopped' : 'done';
        emit(job, job.status, summary);
      } catch (err) {
        job.error = err.message || String(err);
        job.status = 'error';
        emit(job, 'error', { error: job.error });
      }
      return job;
    })();

    emit(job, 'started', {
      dryRun: Boolean(options.dryRun),
      maxCount: options.maxCount ?? 0,
      reviewDays: settings.reviewDays || 90,
      accountCount: accounts.length,
    });
    return publicJob(job);
  }

  function getJob(id) {
    const job = jobs.get(id);
    return job ? publicJob(job) : null;
  }

  function getActiveJob() {
    const job = findActiveJob();
    return job ? publicJob(job) : null;
  }

  function stopJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    job.stopRequested = true;
    if (job.status === 'running') job.status = 'stopping';
    emit(job, 'stopping', {});
    return publicJob(job);
  }

  function stopActiveJob() {
    const job = findActiveJob();
    return job ? stopJob(job.id) : null;
  }

  function subscribe(id, listener) {
    const job = jobs.get(id);
    if (!job) throw new Error('任务不存在');
    for (const event of job.events) listener(event);
    const handler = event => listener(event);
    emitter.on(id, handler);
    return () => emitter.off(id, handler);
  }

  async function waitForJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    await job.promise;
    return publicJob(job);
  }

  return {
    startReplyGoodReviews,
    startReplyAllAccounts,
    startE2EDryRun,
    getJob,
    getActiveJob,
    stopJob,
    stopActiveJob,
    subscribe,
    waitForJob,
  };

  function startJob({ type, runner, options, startedPayload }) {
    ensureNoActiveJob();
    const job = {
      id: randomUUID(),
      type,
      status: 'running',
      createdAt: new Date().toISOString(),
      events: [],
      result: null,
      error: '',
      stopRequested: false,
      promise: null,
    };
    jobs.set(job.id, job);

    job.promise = (async () => {
      try {
        const result = await runner(
          genReply,
          progress => emit(job, 'progress', progress),
          {
            ...options,
            stopSignal: {
              isStopped: () => job.stopRequested,
            },
          }
        );
        job.result = result;
        job.status = result?.stopped ? 'stopped' : 'done';
        emit(job, job.status, result || {});
      } catch (err) {
        job.error = err.message || String(err);
        job.status = 'error';
        emit(job, 'error', { error: job.error });
      }
      return job;
    })();

    emit(job, 'started', startedPayload || {});
    return publicJob(job);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    result: job.result,
    error: job.error,
  };
}

export const automationManager = createAutomationManager({
  detectShopName: detectShopNameForAccount,
});
