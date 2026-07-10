import { Router } from 'express';
import { automationManager } from '../services/automation.js';
import { sendAutomationError, standardActionStarted } from '../services/automation-api-response.js';

const router = Router();

router.get('/active', (req, res) => {
  res.json({ job: automationManager.getActiveJob() });
});

router.post('/reply-good-reviews', (req, res) => {
  try {
    const { maxCount, dryRun, accountId, pageTraversal, maxPages, pageSuccessLimit } = req.body || {};
    const job = automationManager.startReplyGoodReviews({
      maxCount: maxCount === undefined || maxCount === null ? undefined : Number(maxCount),
      dryRun: Boolean(dryRun),
      accountId,
      pageTraversal,
      maxPages: maxPages === undefined || maxPages === null ? undefined : Number(maxPages),
      pageSuccessLimit: pageSuccessLimit === undefined || pageSuccessLimit === null ? undefined : Number(pageSuccessLimit),
    });
    res.json(standardActionStarted(job));
  } catch (err) {
    sendAutomationError(res, err);
  }
});

router.post('/reply-all-accounts', (req, res) => {
  try {
    const { maxCount, dryRun, pageTraversal, maxPages, pageSuccessLimit } = req.body || {};
    const job = automationManager.startReplyAllAccounts({
      maxCount: maxCount === undefined || maxCount === null ? undefined : Number(maxCount),
      dryRun: Boolean(dryRun),
      pageTraversal,
      maxPages: maxPages === undefined || maxPages === null ? undefined : Number(maxPages),
      pageSuccessLimit: pageSuccessLimit === undefined || pageSuccessLimit === null ? undefined : Number(pageSuccessLimit),
    });
    res.json(standardActionStarted(job));
  } catch (err) {
    sendAutomationError(res, err);
  }
});

router.post('/e2e-dry-run', (req, res) => {
  try {
    const { safetyMax, accountId, maxPages } = req.body || {};
    const job = automationManager.startE2EDryRun({
      safetyMax: safetyMax === undefined || safetyMax === null ? undefined : Number(safetyMax),
      maxPages: maxPages === undefined || maxPages === null ? undefined : Number(maxPages),
      dryRun: true,
      accountId,
    });
    res.json(standardActionStarted(job));
  } catch (err) {
    sendAutomationError(res, err);
  }
});

router.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = automationManager.getJob(jobId);
  if (!job) {
    return sendAutomationError(res, new Error('任务不存在'));
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = automationManager.subscribe(jobId, send);
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.post('/stop/:jobId', (req, res) => {
  const job = automationManager.stopJob(req.params.jobId);
  if (!job) return sendAutomationError(res, new Error('任务不存在'));
  res.json({ success: true, job });
});

router.post('/stop-active', (req, res) => {
  const job = automationManager.stopActiveJob();
  if (!job) return sendAutomationError(res, new Error('当前没有正在运行的任务'));
  res.json({ success: true, job });
});

router.get('/jobs/:jobId', (req, res) => {
  const job = automationManager.getJob(req.params.jobId);
  if (!job) return sendAutomationError(res, new Error('任务不存在'));
  res.json({ job });
});

export default router;
