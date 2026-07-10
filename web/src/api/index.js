const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || '请求失败');
    Object.assign(error, err, { status: res.status });
    throw error;
  }
  return res.json();
}

export const api = {
  registerUiSession: (sessionId) => request('/app/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  }),
  heartbeatUiSession: (sessionId) => request('/app/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  }),
  closeUiSession: (sessionId) => {
    const payload = JSON.stringify({ sessionId });
    if (navigator.sendBeacon) {
      return navigator.sendBeacon('/api/app/session/close', new Blob([payload], { type: 'application/json' }));
    }
    fetch('/api/app/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
    return true;
  },
  getStats: () => request('/reviews/stats'),
  getReviews: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reviews?${qs}`);
  },
  fetchReviews: (accountId) => request('/reviews/fetch', {
    method: 'POST',
    body: JSON.stringify(accountId ? { accountId } : {}),
  }),
  generateReply: (id) => request(`/reviews/${id}/generate`, { method: 'POST' }),
  syncRiskReview: (id) => request(`/reviews/${id}/sync-risk`, { method: 'POST' }),
  submitReply: (id, reply) => request(`/reviews/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ reply }),
  }),
  async replyAll(onProgress) {
    const res = await fetch(`${BASE}/reviews/reply-all`, { method: 'POST' });
    if (!res.ok) throw new Error('请求失败');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let result = { total: 0, success: 0, failed: 0 };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(line => line.startsWith('data: '));
      for (const line of lines) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.done) {
            result = data;
          } else if (data.error) {
            throw new Error(data.error);
          } else {
            onProgress?.(data);
          }
        } catch (err) {
          if (err.message !== 'Unexpected end of JSON input') throw err;
        }
      }
    }
    return result;
  },
  startAutoReply: ({ maxCount, dryRun = false, accountId } = {}) => request('/automation/reply-good-reviews', {
    method: 'POST',
    body: JSON.stringify({ maxCount, dryRun, accountId }),
  }),
  startReplyAllAccounts: ({ maxCount, dryRun = false } = {}) => request('/automation/reply-all-accounts', {
    method: 'POST',
    body: JSON.stringify({ maxCount, dryRun }),
  }),
  startE2EDryRun: ({ safetyMax, maxPages } = {}) => request('/automation/e2e-dry-run', {
    method: 'POST',
    body: JSON.stringify({ safetyMax, maxPages, dryRun: true }),
  }),
  stopAutoReply: (jobId) => request(`/automation/stop/${jobId}`, { method: 'POST' }),
  stopActiveAutomation: () => request('/automation/stop-active', { method: 'POST' }),
  getActiveAutomation: () => request('/automation/active'),
  subscribeAutoReply: (jobId, onEvent) => {
    const source = new EventSource(`${BASE}/automation/events/${jobId}`);
    const handle = (event) => {
      try {
        onEvent?.(JSON.parse(event.data));
      } catch (err) {
        onEvent?.({ type: 'error', error: err.message });
      }
    };
    ['started', 'progress', 'done', 'stopped', 'stopping', 'error'].forEach(type => {
      source.addEventListener(type, handle);
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        onEvent?.({ type: 'error', error: '自动回复进度连接已断开' });
      }
    };
    return source;
  },
  getSettings: () => request('/settings'),
  updateSettings: (settings) => request('/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  }),
  getAccounts: () => request('/accounts'),
  getAccountsSummary: () => request('/accounts/summary'),
  createAccount: (name) => request('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name }),
  }),
  updateAccount: (id, updates) => request(`/accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  }),
  switchAccount: (id) => request(`/accounts/${id}/switch`, { method: 'POST' }),
  openAccount: (id) => request(`/accounts/${id}/open`, { method: 'POST' }),
  detectAccountShop: (id) => request(`/accounts/${id}/detect-shop`, { method: 'POST' }),
  detectAllAccountShops: () => request('/accounts/detect-shops', { method: 'POST' }),
  closeAccountBrowser: () => request('/accounts/browser/close', { method: 'POST' }),
  deleteAccount: (id) => request(`/accounts/${id}`, { method: 'DELETE' }),
  testKey: (apiKey) => request('/settings/test-key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  }),
  getTemplates: () => request('/templates'),
  updateTemplates: (content) => request('/templates', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  }),
  getNeutralTemplates: () => request('/templates/neutral'),
  updateNeutralTemplates: (content) => request('/templates/neutral', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  }),
  getSentimentPrompt: () => request('/sentiment/prompt'),
  updateSentimentPrompt: (content) => request('/sentiment/prompt', {
    method: 'PUT',
    body: JSON.stringify({ content }),
  }),
  resetSentimentPrompt: () => request('/sentiment/prompt/reset', { method: 'POST' }),
  repairSentimentPrompt: (content) => request('/sentiment/prompt/repair', {
    method: 'POST',
    body: JSON.stringify({ content }),
  }),
  testSentimentPrompt: ({ reviewContent, stars, promptOverride }) => request('/sentiment/test', {
    method: 'POST',
    body: JSON.stringify({ reviewContent, stars, promptOverride }),
  }),
  previewSentimentReanalysis: ({ scope = 'current' } = {}) => request('/sentiment/reanalyze/preview', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  }),
  applySentimentReanalysis: ({ scope = 'current' } = {}) => request('/sentiment/reanalyze/apply', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  }),
  clearReplied: () => request('/reviews/replied', { method: 'DELETE' }),
  clearAll: () => request('/reviews', { method: 'DELETE' }),
};
