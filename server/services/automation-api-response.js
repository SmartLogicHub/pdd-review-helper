const MANUAL_REQUIRED_PATTERN = /登录|验证码|人机|滑块|风控|安全验证|账号安全|身份验证|请手动|缺少真实店铺名称|识别真实店铺名|manual/i;
const BLOCKED_PATTERN = /已有自动化任务|正在运行|停止中|任务不存在|账号不存在|当前没有正在运行|不可回复|不可评论|不支持回复|平台限制|已经不是可回复|超过安全上限|blocked/i;
const TIMEOUT_PATTERN = /timeout|timed out|超时/i;
const SERVICE_FAILED_PATTERN = /DeepSeek|飞书|企业微信|Webhook|API Key|tenant_access_token|网络|fetch failed|ECONN|ENOTFOUND|外部同步|配置缺失|service/i;

const SUGGESTIONS = {
  manual_required: '请在打开的浏览器中完成登录、验证码、人机验证或店铺名识别后重试。',
  service_failed: '请检查本地服务、DeepSeek、飞书、企业微信或飞书群机器人配置后重试。',
  timeout: '请确认网络和拼多多后台页面正常，稍后重试；如果浏览器卡住，请关闭后重新启动助手。',
  blocked: '请先处理当前阻塞状态，例如等待现有任务结束、切换正确账号，或确认该评价/任务是否仍可操作。',
  failed: '请查看错误详情和任务进度日志，修复后重试。',
};

export function standardActionStarted(job = {}) {
  return {
    jobId: job.id || '',
    status: 'started',
    message: '任务已启动',
    job,
  };
}

export function categorizeAutomationError(error = '') {
  const message = typeof error === 'string' ? error : (error?.message || String(error || ''));
  if (MANUAL_REQUIRED_PATTERN.test(message)) return 'manual_required';
  if (TIMEOUT_PATTERN.test(message)) return 'timeout';
  if (BLOCKED_PATTERN.test(message)) return 'blocked';
  if (SERVICE_FAILED_PATTERN.test(message)) return 'service_failed';
  return 'failed';
}

export function standardAutomationError(error = '', override = {}) {
  const message = typeof error === 'string' ? error : (error?.message || String(error || '未知错误'));
  const category = override.category || categorizeAutomationError(message);
  return {
    error: message,
    category,
    recoverable: override.recoverable ?? category !== 'failed',
    suggestion: override.suggestion || SUGGESTIONS[category] || SUGGESTIONS.failed,
  };
}

export function automationErrorStatus(category = 'failed') {
  if (category === 'blocked') return 409;
  if (category === 'manual_required') return 409;
  if (category === 'timeout') return 504;
  if (category === 'service_failed') return 503;
  return 500;
}

export function sendAutomationError(res, error, override = {}) {
  const payload = standardAutomationError(error, override);
  return res.status(override.statusCode || automationErrorStatus(payload.category)).json(payload);
}
