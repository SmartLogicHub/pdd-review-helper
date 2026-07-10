const SECONDS_PER_DAY = 24 * 60 * 60;
const DEFAULT_GOOD_REVIEW_DAYS = 90;
const GOOD_REVIEW_DAY_OPTIONS = new Set([30, 90, 180]);
export const PDD_REVIEW_DISPLAY_LIMIT = 2000;

export function normalizeReviewDays(value) {
  const days = Number(value);
  return GOOD_REVIEW_DAY_OPTIONS.has(days) ? days : DEFAULT_GOOD_REVIEW_DAYS;
}

export function reviewDaysFilterLabel(value) {
  return `近${normalizeReviewDays(value)}天`;
}

export function buildGoodReviewListRequest({
  pageNo = 1,
  pageSize = 10,
  nowSeconds = Math.floor(Date.now() / 1000),
  orderSn = '',
  reviewDays = DEFAULT_GOOD_REVIEW_DAYS,
} = {}) {
  const days = normalizeReviewDays(reviewDays);
  return {
    startTime: nowSeconds - days * SECONDS_PER_DAY,
    endTime: nowSeconds,
    pageNo,
    pageSize,
    descScore: ['4', '5'],
    replyStatus: '2',
    orderSn,
  };
}

export function visibleReviewRows({
  totalRows = 0,
  displayRows,
  displayLimit = PDD_REVIEW_DISPLAY_LIMIT,
} = {}) {
  const total = Math.max(0, Number(totalRows || 0));
  const explicitDisplay = Number(displayRows);
  const limit = Math.max(0, Number(displayLimit || 0));
  let visible = Number.isFinite(explicitDisplay) && explicitDisplay >= 0 ? explicitDisplay : total;

  if (total > 0) visible = Math.min(visible, total);
  if (limit > 0) visible = Math.min(visible, limit);
  return Math.max(0, visible);
}

export function reviewPageCountForRows({
  totalRows = 0,
  displayRows,
  pageSize = 10,
  maxPages = 0,
  displayLimit = PDD_REVIEW_DISPLAY_LIMIT,
} = {}) {
  const normalizedPageSize = Math.max(1, Number(pageSize || 10));
  const visibleRows = visibleReviewRows({ totalRows, displayRows, displayLimit });
  let pageCount = Math.max(1, Math.ceil(visibleRows / normalizedPageSize));
  const pageLimit = Number(maxPages || 0);
  if (pageLimit > 0) pageCount = Math.min(pageCount, pageLimit);
  return pageCount;
}

export function normalizePddReviewItem(item = {}) {
  const reviewId = String(item.reviewId ?? item.id ?? item.orderSn ?? '');
  const replyCount = Number(item.replyCount || 0);
  const replyList = Array.isArray(item.replyList) ? item.replyList : [];
  const replyStatus = item.replyStatus ?? 0;
  const content = String(item.comment || '').trim();
  const appendContent = String(item.appendReview?.comment || '').trim();
  const orderSnapshot = item.orderSnapshotInfo || {};
  const stars = Number(item.descScore || item.stars || 0);
  const createTime = Number(item.createTime || 0);

  return {
    id: reviewId,
    reviewId,
    content,
    appendContent,
    stars,
    userName: item.name || item.userName || '',
    orderNo: item.orderSn || orderSnapshot.orderSn || '',
    productName: item.goodsName || orderSnapshot.goodsName || '',
    specs: parseSpecs(item.specs),
    time: createTime ? formatPddTime(createTime) : '',
    fetchedAt: new Date().toISOString(),
    replied: replyCount > 0 || replyList.length > 0 || hasTextValue(item.reply),
    reply: item.reply || '',
    replyList,
    replyCount,
    canReview: normalizeOptionalBoolean(item.canReview),
    canInteract: item.canInteract !== false,
    replyStatus,
    replyBlocked: Boolean(item.replyBlocked),
    skipReason: item.skipReason || '',
    flagged: Boolean(item.flagged),
    flagReason: item.flagReason || '',
    uncertainSkip: Boolean(item.uncertainSkip),
    uncertainReason: item.uncertainReason || '',
    neutralReply: Boolean(item.neutralReply),
    neutralReason: item.neutralReason || '',
    sentimentLabel: item.sentimentLabel || '',
    riskWords: Array.isArray(item.riskWords) ? item.riskWords : [],
    safePositiveWords: Array.isArray(item.safePositiveWords) ? item.safePositiveWords : [],
  };
}

export function shouldAutoReplyReview(review = {}) {
  if (!['4', '5'].includes(String(review.stars))) {
    return { ok: false, reason: '不是4星或5星评价' };
  }
  if (isReviewAlreadyReplied(review)) {
    return { ok: false, reason: '评价已回复' };
  }
  if (!isUnrepliedStatus(review.replyStatus)) {
    return { ok: false, reason: 'replyStatus 不是未回复' };
  }
  if (review.flagged) {
    return { ok: false, reason: effectiveFlagReason(review) };
  }
  if (review.uncertainSkip) {
    return { ok: false, reason: review.uncertainReason || '评价无法判断，已跳过自动回复' };
  }
  if (review.canReview === false || review.canInteract === false) {
    return { ok: false, reason: '平台不允许回复/互动' };
  }
  if (review.replyBlocked) {
    return { ok: false, reason: review.skipReason || '平台提示该评价不可回复' };
  }
  if (!review.reviewId && !review.orderNo) {
    return { ok: false, reason: '缺少稳定评价标识' };
  }
  return {
    ok: true,
    reason: '',
    replyMode: review.neutralReply || review.sentimentLabel === 'neutral_auto_reply' ? 'neutral' : 'positive',
  };
}

const PLATFORM_SKIP_REASON_PATTERN = /平台.*(不允许|不可|不能|不支持).*(回复|互动|评论)|用户.*(不可|不允许|不能|不支持).*(回复|互动|评论)|不可回复|不可评论|不支持回复|不能回复|无法回复|不允许回复\/互动/;

export function isPlatformSkipReason(reason = '') {
  return PLATFORM_SKIP_REASON_PATTERN.test(String(reason || '').trim());
}

export function effectiveFlagReason(review = {}, reason = '') {
  const riskWords = Array.isArray(review.riskWords)
    ? review.riskWords.map(word => String(word || '').trim()).filter(Boolean)
    : [];
  const candidates = [reason, review.flagReason]
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .filter(item => !isPlatformSkipReason(item));
  if (candidates.length) return candidates[0];
  if (riskWords.length) return riskWords.join('、');
  return '疑似差评，需人工处理';
}

export function isReviewAlreadyReplied(review = {}) {
  return Boolean(
    review.replied
    || Number(review.replyCount || 0) > 0
    || (Array.isArray(review.replyList) && review.replyList.length > 0)
    || hasTextValue(review.reply)
  );
}

export function isUnrepliedStatus(replyStatus) {
  if (replyStatus === undefined || replyStatus === null || replyStatus === '') return true;
  const status = String(replyStatus).trim();
  return ['0', '2', 'false', '未回复'].includes(status);
}

export function isLocallyPendingReview(review = {}) {
  return classifyReviewStatus(review) === 'pending';
}

export function classifyReviewStatus(review = {}) {
  if (isReviewAlreadyReplied(review)) return 'replied';
  if (review.flagged) return 'flagged';
  if (review.replyBlocked || review.canReview === false || review.canInteract === false) return 'blocked';
  if (review.uncertainSkip) return 'uncertain';
  if (!isUnrepliedStatus(review.replyStatus)) return 'blocked';
  if (review.neutralReply || review.sentimentLabel === 'neutral_auto_reply') return 'neutral';
  return 'pending';
}

export function decorateReviewStatus(review = {}) {
  return {
    ...review,
    reviewStatus: classifyReviewStatus(review),
  };
}

export function filterReviewRecordsByStatus(reviews = [], status = 'all') {
  const normalized = String(status || 'all').toLowerCase();
  if (normalized === 'all') return reviews.map(decorateReviewStatus);
  return reviews
    .map(decorateReviewStatus)
    .filter(review => review.reviewStatus === normalized);
}

export function normalizeReviewStatusFilter({
  status = 'all',
  replied,
  flagged,
} = {}) {
  if (flagged === 'true') return 'flagged';
  if (replied === 'true') return 'replied';
  if (replied === 'false') return 'pending';
  const normalized = String(status || 'all').toLowerCase();
  return ['all', 'pending', 'neutral', 'replied', 'flagged', 'blocked', 'uncertain'].includes(normalized)
    ? normalized
    : 'all';
}

export function summarizeReviewRecords(reviews = []) {
  const statuses = reviews.map(classifyReviewStatus);
  const total = reviews.length;
  const replied = statuses.filter(status => status === 'replied').length;
  const flagged = statuses.filter(status => status === 'flagged').length;
  const blocked = statuses.filter(status => status === 'blocked').length;
  const uncertain = statuses.filter(status => status === 'uncertain').length;
  const pending = statuses.filter(status => status === 'pending').length;
  const neutral = statuses.filter(status => status === 'neutral').length;
  const actionable = pending + neutral;
  const unreplied = actionable;
  return { total, replied, unreplied, pending, neutral, actionable, flagged, blocked, uncertain };
}

const REPLY_BLOCKED_MESSAGE_PATTERN = /不可评论|不支持回复|暂不支持回复|不能回复|无法回复|评价已关闭|评论已关闭|已设置为不可评论/;
const REPLY_SUCCESS_MESSAGE_PATTERN = /回复成功|提交成功|操作成功/;

export function classifyReplySubmitMessage(text = '') {
  const message = String(text || '').replace(/\s+/g, ' ').trim();
  if (!message) return null;
  if (REPLY_BLOCKED_MESSAGE_PATTERN.test(message)) {
    return {
      ok: false,
      status: 'skip',
      reason: `平台提示不可回复：${message}`,
      message,
    };
  }
  if (REPLY_SUCCESS_MESSAGE_PATTERN.test(message)) {
    return {
      ok: true,
      status: 'ok',
      reason: message,
      message,
    };
  }
  return null;
}

export function createReplyRunReport({
  target = 0,
  totalRows = 0,
  displayRows,
  displayLimit = PDD_REVIEW_DISPLAY_LIMIT,
  limit = 0,
  requestBody = null,
  dryRun = false,
} = {}) {
  const initialTarget = Number(target || 0);
  const initialTotalRows = Number(totalRows || 0);
  const initialVisibleRows = visibleReviewRows({
    totalRows: initialTotalRows,
    displayRows,
    displayLimit,
  });
  const report = {
    initialTarget,
    total: initialTarget,
    totalRows: initialTotalRows,
    initialTotalRows,
    displayLimit: Number(displayLimit || 0),
    initialVisibleRows,
    visibleRows: initialVisibleRows,
    liveTotalRows: initialTotalRows,
    remainingTargets: initialTarget,
    processed: 0,
    limit: Number(limit || 0),
    scanned: 0,
    replyable: 0,
    positiveReplies: 0,
    neutralReplies: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    skippedAlreadyReplied: 0,
    skippedFlagged: 0,
    skippedUncertain: 0,
    skippedBlocked: 0,
    firstFailure: null,
    requestBody,
    records: [],
    stopped: false,
    dryRun: Boolean(dryRun),
  };
  updateReplyRunLiveState(report, { totalRows: initialTotalRows });
  return report;
}

export function shouldContinueReplyRun(report = {}, maxCount = 0) {
  return Number(report.success || 0) < Number(maxCount || 0);
}

function refreshReplyRunTotals(report = {}) {
  const processed = Number(report.success || 0) + Number(report.skipped || 0) + Number(report.failed || 0);
  const liveTotalRows = Math.max(0, Number(report.liveTotalRows ?? report.totalRows ?? 0));
  const initialTarget = Math.max(0, Number(report.initialTarget ?? report.total ?? 0));

  let remainingTargets;
  if (report.dryRun) {
    remainingTargets = Math.max(0, initialTarget - Number(report.success || 0));
  } else {
    remainingTargets = Math.max(0, liveTotalRows - Number(report.skipped || 0));
  }

  let total = processed + remainingTargets;

  report.processed = processed;
  report.remainingTargets = remainingTargets;
  report.total = total;
  report.totalRows = liveTotalRows;
  return report;
}

export function updateReplyRunLiveState(report = {}, {
  totalRows,
  displayRows,
  pageNo,
  pageCount,
} = {}) {
  if (totalRows !== undefined && totalRows !== null) {
    report.liveTotalRows = Math.max(0, Number(totalRows || 0));
  } else if (report.liveTotalRows === undefined) {
    report.liveTotalRows = Math.max(0, Number(report.totalRows || 0));
  }
  report.visibleRows = visibleReviewRows({
    totalRows: report.liveTotalRows,
    displayRows,
    displayLimit: report.displayLimit || PDD_REVIEW_DISPLAY_LIMIT,
  });
  if (pageNo !== undefined) report.page = Number(pageNo || 0);
  if (pageCount !== undefined) report.pageCount = Number(pageCount || 0);
  return refreshReplyRunTotals(report);
}

export function replyRunProgressFields(report = {}) {
  refreshReplyRunTotals(report);
  return {
    current: Number(report.success || 0),
    total: Number(report.total || 0),
    initialTotalRows: Number(report.initialTotalRows || 0),
    liveTotalRows: Number(report.liveTotalRows || 0),
    visibleRows: Number(report.visibleRows || 0),
    displayLimit: Number(report.displayLimit || 0),
    remainingTargets: Number(report.remainingTargets || 0),
    processed: Number(report.processed || 0),
    scanned: Number(report.scanned || 0),
    success: Number(report.success || 0),
    positiveReplies: Number(report.positiveReplies || 0),
    neutralReplies: Number(report.neutralReplies || 0),
    skipped: Number(report.skipped || 0),
    skippedAlreadyReplied: Number(report.skippedAlreadyReplied || 0),
    skippedFlagged: Number(report.skippedFlagged || 0),
    skippedUncertain: Number(report.skippedUncertain || 0),
    skippedBlocked: Number(report.skippedBlocked || 0),
    failed: Number(report.failed || 0),
    replyable: Number(report.replyable || 0),
    page: report.page,
    pageCount: report.pageCount,
  };
}

export function nextReplyPageAction({
  dryRun = false,
  pageHadSuccess = false,
  pageNo = 1,
  pageCount = 1,
  refreshAfterSuccess = true,
} = {}) {
  if (!dryRun && pageHadSuccess && refreshAfterSuccess) return 'refresh-first';
  if (Number(pageNo || 1) >= Number(pageCount || 1)) return 'done';
  return 'next-page';
}

export function recordReplyRunOutcome(report, {
  review = {},
  status = '',
  reason = '',
  reply = '',
  method = '',
  screenshot = '',
} = {}) {
  report.scanned += 1;

  const record = {
    reviewId: review.reviewId || review.id || '',
    orderSn: review.orderNo || review.orderSn || '',
    status,
    reason,
  };
  if (reply) record.reply = reply;
  if (method) record.method = method;
  if (screenshot) record.screenshot = screenshot;
  report.records.push(record);

  if (status === 'skip') {
    report.skipped += 1;
    if (isReviewAlreadyReplied(review) || /已回复/.test(reason)) {
      report.skippedAlreadyReplied += 1;
    }
    const reviewStatus = classifyReviewStatus(review);
    if (reviewStatus === 'flagged') report.skippedFlagged += 1;
    if (reviewStatus === 'uncertain') report.skippedUncertain += 1;
    if (reviewStatus === 'blocked') report.skippedBlocked += 1;
    refreshReplyRunTotals(report);
    return record;
  }

  if (status === 'fail') {
    report.failed += 1;
    if (!report.firstFailure) {
      report.firstFailure = { ...record };
    }
    refreshReplyRunTotals(report);
    return record;
  }

  if (status === 'ok' || status === 'dry-run') {
    report.replyable += 1;
    report.success += 1;
    if (review.neutralReply || review.sentimentLabel === 'neutral_auto_reply') {
      report.neutralReplies += 1;
    } else {
      report.positiveReplies += 1;
    }
  }

  refreshReplyRunTotals(report);
  return record;
}

export function normalizePddReviewListResponse(payload = {}) {
  const result = payload.result || payload;
  const data = Array.isArray(result.data) ? result.data : [];
  const totalRows = Number(result.totalRows ?? result.showNum ?? data.length);
  const displayRows = Number(result.showNum ?? result.displayRows ?? totalRows);
  return {
    totalRows,
    displayRows: visibleReviewRows({
      totalRows,
      displayRows,
      displayLimit: PDD_REVIEW_DISPLAY_LIMIT,
    }),
    totalNum: Number(result.totalNum ?? result.totalRows ?? data.length),
    pageReviews: data.map(normalizePddReviewItem).filter(r => r.reviewId),
  };
}

export function mergeReviewRecords(existing = [], incoming = []) {
  const byKey = new Map();

  for (const review of existing) {
    byKey.set(reviewKey(review), review);
  }

  for (const review of incoming) {
    const key = reviewKey(review);
    const old = byKey.get(key);
    const hasExplicitReplyState = Object.prototype.hasOwnProperty.call(review, 'replyStatus')
      || Object.prototype.hasOwnProperty.call(review, 'replyCount')
      || Object.prototype.hasOwnProperty.call(review, 'replyList')
      || Object.prototype.hasOwnProperty.call(review, 'reply');
    const incomingExplicitlyUnreplied = hasExplicitReplyState
      && review.replied === false
      && Number(review.replyCount || 0) === 0
      && (!Array.isArray(review.replyList) || review.replyList.length === 0)
      && !hasTextValue(review.reply)
      && isUnrepliedStatus(review.replyStatus);
    const replied = Boolean(review.replied || (old?.replied && !incomingExplicitlyUnreplied));
    const incomingAllowsReply = review.canReview === true
      && review.canInteract !== false
      && review.replyBlocked !== true;
    byKey.set(key, {
      ...old,
      ...review,
      id: review.id || old?.id || key,
      reviewId: review.reviewId || old?.reviewId || key,
      replied,
      repliedAt: replied ? (old?.repliedAt || review.repliedAt) : undefined,
      replyList: review.replyList ?? old?.replyList ?? [],
      replyCount: incomingExplicitlyUnreplied ? 0 : (review.replyCount ?? old?.replyCount),
      replyStatus: review.replyStatus ?? old?.replyStatus,
      replyBlocked: incomingAllowsReply ? false : Boolean(old?.replyBlocked || review.replyBlocked),
      skipReason: incomingAllowsReply ? '' : (old?.skipReason || review.skipReason || ''),
      flagged: Boolean(review.flagged ?? old?.flagged),
      flagReason: review.flagReason ?? old?.flagReason ?? '',
      uncertainSkip: Boolean(review.uncertainSkip ?? old?.uncertainSkip),
      uncertainReason: review.uncertainReason ?? old?.uncertainReason ?? '',
      neutralReply: Boolean(review.neutralReply ?? old?.neutralReply),
      neutralReason: review.neutralReason ?? old?.neutralReason ?? '',
      sentimentLabel: review.sentimentLabel ?? old?.sentimentLabel ?? '',
      riskWords: review.riskWords ?? old?.riskWords ?? [],
      safePositiveWords: review.safePositiveWords ?? old?.safePositiveWords ?? [],
    });
  }

  return Array.from(byKey.values());
}

export function mergeReviewRecordsWithStats(existing = [], incoming = []) {
  const existingKeys = new Set(existing.map(reviewKey).filter(Boolean));
  const incomingKeys = new Set(incoming.map(reviewKey).filter(Boolean));
  const reviews = mergeReviewRecords(existing, incoming);
  const newCount = [...incomingKeys].filter(key => !existingKeys.has(key)).length;
  const stats = summarizeReviewRecords(reviews);

  return {
    reviews,
    fetchedCount: incoming.length,
    newCount,
    ...stats,
  };
}

export function reviewKey(review = {}) {
  return String(review.reviewId || review.id || review.orderNo || review.content || '');
}

export function reviewIdentityValues(review = {}) {
  return [...new Set([
    review.reviewId,
    review.id,
    review.orderNo,
    review.orderSn,
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

export function sameReviewIdentity(left = {}, right = {}) {
  const rightValues = new Set(reviewIdentityValues(right));
  if (rightValues.size === 0) return false;
  return reviewIdentityValues(left).some(value => rightValues.has(value));
}

function parseSpecs(specs) {
  if (!specs) return '';
  if (typeof specs !== 'string') return String(specs);
  try {
    return JSON.parse(specs).map(item => `${item.spec_key}:${item.spec_value}`).join('，');
  } catch {
    return specs;
  }
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

function hasTextValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
}

function formatPddTime(seconds) {
  const date = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
