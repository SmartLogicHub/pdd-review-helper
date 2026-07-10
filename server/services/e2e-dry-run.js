import { reviewPageCountForRows, shouldAutoReplyReview, visibleReviewRows } from './review-normalizer.js';

export function createE2EDryRunReport({
  totalRows = 0,
  displayRows,
  pageSize = 10,
  safetyMax = 0,
  requestBody = null,
} = {}) {
  return {
    mode: 'e2e-dry-run',
    dryRun: true,
    totalRows: Number(totalRows || 0),
    visibleRows: visibleReviewRows({ totalRows, displayRows }),
    safetyMax: Number(safetyMax || 0),
    pageSize: Number(pageSize || 10),
    page: 0,
    pageCount: reviewPageCountForRows({ totalRows, displayRows, pageSize }),
    lastPageReached: false,
    scanned: 0,
    skipped: 0,
    skippedAlreadyReplied: 0,
    replyable: 0,
    dialogOpened: 0,
    failed: 0,
    aiFailed: 0,
    pageFailed: 0,
    firstFailure: null,
    requestBodies: requestBody ? [requestBody] : [],
    pages: [],
    stopped: false,
  };
}

export function summarizeE2EPageReviews(reviews = []) {
  const summary = {
    scanned: 0,
    skipped: 0,
    skippedAlreadyReplied: 0,
    replyable: 0,
    candidate: null,
    decisions: [],
  };

  for (const review of reviews) {
    summary.scanned += 1;
    const decision = shouldAutoReplyReview(review);
    summary.decisions.push({ review, decision });
    if (!decision.ok) {
      summary.skipped += 1;
      if (/已回复/.test(decision.reason)
        || Number(review.replyCount || 0) > 0
        || (Array.isArray(review.replyList) && review.replyList.length > 0)) {
        summary.skippedAlreadyReplied += 1;
      }
      continue;
    }

    summary.replyable += 1;
    if (!summary.candidate) summary.candidate = review;
  }

  return summary;
}

export function validateGoodReviewPageRequest(
  requestBody = {},
  { expectedPageNo, expectedPageSize } = {}
) {
  if (!requestBody || typeof requestBody !== 'object') {
    return { ok: false, reason: '缺少评价列表请求体' };
  }
  if (Number(requestBody.pageNo) !== Number(expectedPageNo)) {
    return { ok: false, reason: `pageNo 应为 ${expectedPageNo}，实际为 ${requestBody.pageNo}` };
  }
  if (Number(requestBody.pageSize) !== Number(expectedPageSize)) {
    return { ok: false, reason: `pageSize 应为 ${expectedPageSize}，实际为 ${requestBody.pageSize}` };
  }
  if (requestBody.replyStatus !== '2') {
    return { ok: false, reason: `replyStatus 应为 2，实际为 ${requestBody.replyStatus}` };
  }
  if (!Array.isArray(requestBody.descScore)
    || !requestBody.descScore.includes('4')
    || !requestBody.descScore.includes('5')) {
    return { ok: false, reason: 'descScore 未包含 4 星和 5 星' };
  }
  return { ok: true, reason: '' };
}

export function recordE2EDryRunPage(report, {
  pageNo,
  pageCount,
  requestBody,
  scanned = 0,
  skipped = 0,
  skippedAlreadyReplied = 0,
  replyable = 0,
  dialogOpened = false,
  failed = 0,
  aiFailed = 0,
  pageFailed = 0,
  failures = [],
  sample = null,
  lastPageReached = false,
} = {}) {
  if (requestBody) report.requestBodies.push(requestBody);

  const pageRecord = {
    pageNo,
    pageCount,
    scanned,
    skipped,
    skippedAlreadyReplied,
    replyable,
    dialogOpened: Boolean(dialogOpened),
    failed,
    aiFailed,
    pageFailed,
  };
  if (sample) pageRecord.sample = sample;
  report.pages.push(pageRecord);

  report.page = pageNo;
  report.pageCount = pageCount || report.pageCount;
  report.scanned += scanned;
  report.skipped += skipped;
  report.skippedAlreadyReplied += skippedAlreadyReplied;
  report.replyable += replyable;
  report.dialogOpened += dialogOpened ? 1 : 0;
  report.failed += failed;
  report.aiFailed += aiFailed;
  report.pageFailed += pageFailed;
  report.lastPageReached = Boolean(lastPageReached || pageNo >= report.pageCount);

  if (!report.firstFailure && failures.length > 0) {
    const first = failures[0];
    report.firstFailure = {
      pageNo,
      reviewId: first.reviewId || '',
      orderSn: first.orderSn || '',
      stage: first.stage || '',
      reason: first.reason || '',
      screenshot: first.screenshot || undefined,
      networkRequests: first.networkRequests || undefined,
    };
    if (!report.firstFailure.screenshot) delete report.firstFailure.screenshot;
    if (!report.firstFailure.networkRequests) delete report.firstFailure.networkRequests;
  }

  return pageRecord;
}
