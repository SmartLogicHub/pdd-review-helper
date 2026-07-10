export const SENTIMENT_LABELS = new Set([
  'positive_auto_reply',
  'neutral_auto_reply',
  'risk_manual_review',
  'uncertain_skip',
]);

export const DEFAULT_SENTIMENT_PROMPT = `你是一名资深电商客服质检助手，负责判断 4 星或 5 星评价是否可以进入自动回复流程。

商品场景：耳机、蓝牙耳机、音频设备。用户可能给了 4 星或 5 星，但文字里存在表面好评、真实情绪偏负面的反馈。

输入信息：
店铺名称：{{shopName}}
商品名称：{{productName}}
用户昵称：{{userName}}
星级：{{stars}}
评价内容：{{reviewContent}}

分类标签只能是：
1. positive_auto_reply：评价明确正面，可以正常自动回复。
2. neutral_auto_reply：内容中性、太短、无意义、刚拿到没用、帮人买、还行但无明确问题，可以使用保守中性回复。
3. risk_manual_review：当前商品存在真实负面体验、质量问题、功能问题、售后问题、先夸后踩、转折后指出问题、反讽、讽刺或阴阳怪气，需要人工处理。
4. uncertain_skip：语义无法安全判断，不自动回复，也不称为差评。

判断规则：
- 不要只靠关键词，要判断完整语义。
- 风险词必须表达当前商品的负面体验才算风险。
- “无杂音、没有延迟、不疼、不夹耳、不压耳、不容易掉、售后有保障、小巧好看”通常是正面表达。
- “有杂音、电流声、延迟高、声音小、声音闷、耳朵疼、夹头、断连、连接不稳、降噪差、漏音、卡顿、坏了、想退、想换、不好用”如果指当前商品，应判为 risk_manual_review。
- “还行、还可以、一般”如果只单独出现，判为 neutral_auto_reply；如果修饰音质、降噪、连接、舒适度、续航、通话质量等关键体验，倾向 risk_manual_review。
- 负面词如果描述的是旧商品、其他商品、对比对象，而当前商品被明确夸赞，不要判为风险。
- 无意义内容、纯数字、单独表情、刚拿到没用、帮人买，判为 neutral_auto_reply。
- uncertain_skip 的 is_real_negative 必须是 false。

只输出严格 JSON：
{
  "label": "positive_auto_reply",
  "can_auto_reply": true,
  "is_real_negative": false,
  "reason": "简要说明判断原因",
  "risk_words": [],
  "safe_positive_words": []
}`;

const REQUIRED_RESULT_KEYS = [
  'label',
  'can_auto_reply',
  'is_real_negative',
  'reason',
  'risk_words',
  'safe_positive_words',
];

function normalizeArray(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
}

function uncertainResult(reason = 'AI判断结果不是有效JSON，跳过自动回复') {
  return {
    label: 'uncertain_skip',
    canAutoReply: false,
    can_auto_reply: false,
    isRealNegative: false,
    is_real_negative: false,
    flagged: false,
    uncertain: true,
    neutral: false,
    reason,
    riskWords: [],
    risk_words: [],
    safePositiveWords: [],
    safe_positive_words: [],
  };
}

export function normalizeSentimentResult(raw = {}) {
  if (!raw || typeof raw !== 'object') return uncertainResult();
  const missingRequired = REQUIRED_RESULT_KEYS.some(key => !Object.hasOwn(raw, key));
  const label = String(raw.label || '').trim();
  if (missingRequired || !SENTIMENT_LABELS.has(label)) {
    return uncertainResult('AI判断结果字段不完整或标签非法，跳过自动回复');
  }

  const flagged = label === 'risk_manual_review';
  const uncertain = label === 'uncertain_skip';
  const neutral = label === 'neutral_auto_reply';
  const canAutoReply = label === 'positive_auto_reply' || neutral;
  return {
    label,
    canAutoReply,
    can_auto_reply: canAutoReply,
    isRealNegative: flagged,
    is_real_negative: flagged,
    flagged,
    uncertain,
    neutral,
    reason: String(raw.reason || (flagged ? '当前商品存在负面体验' : uncertain ? '评价无法安全判断，跳过自动回复' : neutral ? '中性评价，使用保守回复' : '评价整体正面')).trim(),
    riskWords: normalizeArray(raw.risk_words ?? raw.riskWords),
    risk_words: normalizeArray(raw.risk_words ?? raw.riskWords),
    safePositiveWords: normalizeArray(raw.safe_positive_words ?? raw.safePositiveWords),
    safe_positive_words: normalizeArray(raw.safe_positive_words ?? raw.safePositiveWords),
  };
}

export function parseSentimentResponse(text = '') {
  const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return uncertainResult();
  try {
    return normalizeSentimentResult(JSON.parse(jsonMatch[0]));
  } catch {
    return uncertainResult();
  }
}

export function sentimentContextFromInput(input = '', context = {}) {
  const review = typeof input === 'object' && input ? input : {};
  return {
    reviewContent: String(review.content ?? review.comment ?? input ?? ''),
    stars: String(context.stars ?? review.stars ?? review.descScore ?? ''),
    productName: String(context.productName ?? review.productName ?? review.goodsName ?? ''),
    shopName: String(context.shopName ?? review.shopName ?? ''),
    userName: String(context.userName ?? review.userName ?? review.name ?? ''),
  };
}

export function renderSentimentPrompt(prompt = DEFAULT_SENTIMENT_PROMPT, context = {}) {
  const values = {
    reviewContent: context.reviewContent ?? '',
    stars: context.stars ?? '',
    productName: context.productName ?? '',
    shopName: context.shopName ?? '',
    userName: context.userName ?? '',
  };
  return String(prompt || DEFAULT_SENTIMENT_PROMPT).replace(
    /\{\{(reviewContent|stars|productName|shopName|userName)\}\}/g,
    (_match, key) => String(values[key] ?? '')
  );
}

export function statusFromSentimentResult(result = {}) {
  if (result.label === 'risk_manual_review') return 'flagged';
  if (result.label === 'neutral_auto_reply') return 'neutral';
  if (result.label === 'uncertain_skip') return 'uncertain';
  return 'pending';
}

export function validateSentimentPrompt(prompt = '') {
  const text = String(prompt || '').trim();
  const issues = [];
  if (!text) issues.push('提示词不能为空');

  for (const variable of ['{{reviewContent}}', '{{stars}}', '{{productName}}', '{{shopName}}', '{{userName}}']) {
    if (!text.includes(variable)) issues.push(`缺少变量 ${variable}`);
  }
  for (const label of SENTIMENT_LABELS) {
    if (!text.includes(label)) issues.push(`缺少标签 ${label}`);
  }
  for (const field of REQUIRED_RESULT_KEYS) {
    if (!text.includes(`"${field}"`)) issues.push(`缺少 JSON 字段 ${field}`);
  }
  if (!/JSON/i.test(text)) issues.push('缺少严格 JSON 输出要求');

  return {
    ok: issues.length === 0,
    issues,
  };
}

export async function repairSentimentPrompt(prompt = '', repairer) {
  if (typeof repairer !== 'function') {
    return { ok: false, prompt: '', issues: ['缺少提示词修复函数'] };
  }
  const repaired = await repairer({
    prompt: String(prompt || ''),
    defaultPrompt: DEFAULT_SENTIMENT_PROMPT,
    issues: validateSentimentPrompt(prompt).issues,
  });
  const nextPrompt = typeof repaired === 'string' ? repaired : String(repaired?.prompt || '');
  const validation = validateSentimentPrompt(nextPrompt);
  return {
    ok: validation.ok,
    prompt: validation.ok ? nextPrompt.trim() : '',
    issues: validation.issues,
  };
}
