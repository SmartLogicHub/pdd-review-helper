import OpenAI from 'openai';
import { getSentimentPrompt, getSettings } from '../data/store.js';
import {
  DEFAULT_SENTIMENT_PROMPT,
  normalizeSentimentResult,
  parseSentimentResponse,
  parseSentimentResponseStrict,
  repairSentimentPrompt,
  renderSentimentPrompt,
  sentimentContextFromInput,
  validateSentimentPrompt,
} from './sentiment-core.js';
import { requestSentimentWithRetry } from './sentiment-reliability.js';

let client = null;
let clientKey = '';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
// V4 系列是思考模型：推理过程与最终回答共用同一份 max_tokens 预算，默认 reasoning_effort='high'
// 会把预算吃光，导致 content 返回空、finish_reason='length'。本项目的分类/客服回复都属于简单任务，
// 关闭思考既能把预算全留给正文，也更快更省 token。
const REASONING_OFF = 'none';
const SENTIMENT_REQUEST_OPTIONS = {
  temperature: 0.1,
  max_tokens: 1500,
  reasoning_effort: REASONING_OFF,
  // 强制模型返回合法 JSON，避免夹带 Markdown/解释导致解析失败（invalid_json）
  response_format: { type: 'json_object' },
};

/** 情感判断用的模型与参数；参与缓存指纹，换模型或改参数后旧的判断缓存自动失效 */
export function sentimentModelSignature() {
  return JSON.stringify({ model: DEEPSEEK_MODEL, ...SENTIMENT_REQUEST_OPTIONS });
}

/**
 * 读取 completion 正文，并显式检查 finish_reason。
 * 空内容/被截断一律抛错，交由上层回退模板或重试，避免静默产出空回复。
 */
function readCompletionText(response, label = 'AI') {
  const choice = response?.choices?.[0] || {};
  const text = String(choice.message?.content || '').trim();
  if (text) return text;
  const finishReason = choice.finish_reason || 'unknown';
  const error = new Error(
    finishReason === 'length'
      ? `${label}生成被 max_tokens 截断，未产出正文（finish_reason=length，可能被推理占满预算）`
      : `${label}返回空内容（finish_reason=${finishReason}）`
  );
  error.kind = 'empty_content';
  error.finishReason = finishReason;
  throw error;
}

function getClient(apiKeyOverride = '') {
  const settings = getSettings();
  const apiKey = apiKeyOverride || settings.deepseekApiKey;
  if (!apiKey) {
    throw new Error('请先配置 DeepSeek API Key');
  }
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com',
    });
    clientKey = apiKey;
  }
  return client;
}

/**
 * 根据评价内容和话术模板生成回复
 * @param {string} reviewContent - 用户评价内容
 * @param {string} templates - 话术模板文本
 * @returns {Promise<string>} 生成的回复
 */
function promptText(value = '', limit = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 好评回复提示词。固定内容（要求 + 话术模板）在前、每条评价不同的内容在后，
 * 前缀不变就能命中 DeepSeek 的上下文缓存，模板再长也只按缓存价计费。
 */
function buildReplyPrompt({ reviewContent = '', templates = '', shopName = '', productName = '' } = {}) {
  const shop = promptText(shopName, 40);
  const productTitle = promptText(productName, 120);
  return `请以拼多多店铺客服的身份，参考下面的话术模板，为用户评价改写一条真诚、个性化的回复。

## 回复要求：
1. 参考话术模板的语气和风格（亲切、真诚、有温度），但要结合这条评价的具体内容重新组织语言，不要整句照抄模板
2. 评价提到了什么就回应什么（如提到音质就回应音质，提到佩戴舒适就回应舒适度）
3. 可以从商品标题中提炼一个简短、口语化的商品称呼（如「品牌+型号」），在回复中自然提及一次；不要照抄完整标题、不要堆砌关键词；商品标题未知时不要编造商品名
4. 品牌、型号、功能卖点只能用商品标题或评价里出现过的，不要编造参数、功能或活动，也不要从话术模板里照搬与本商品不符的内容
5. 以本店的口吻用「我们」自称，不要提及其他店铺
6. 回复长度控制在 50-150 字
7. 直接输出回复内容，不要加任何前缀说明
8. 不要使用空格、换行和表情符号（拼多多会拒收）；商品称呼里的英文、型号直接连写，如「LolliClipSE」

## 话术模板参考：
${templates}

## 店铺名称：
${shop || '（未知）'}

## 商品标题：
${productTitle || '（未知）'}

## 用户评价：
${reviewContent}

请生成回复：`;
}

/**
 * 根据评价内容、店铺和商品标题，参考话术模板改写回复
 * @param {string} reviewContent - 用户评价内容
 * @param {string} templates - 话术模板文本
 * @param {{shopName?: string, productName?: string}} context - 店铺名称、商品标题
 * @returns {Promise<string>} 生成的回复
 */
export async function generateReply(reviewContent, templates, { shopName = '', productName = '' } = {}) {
  const openai = getClient();
  const response = await openai.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: '你是一名专业的拼多多店铺客服，回复亲切真诚，不夸大、不编造。' },
      { role: 'user', content: buildReplyPrompt({ reviewContent, templates, shopName, productName }) },
    ],
    temperature: 0.7,
    max_tokens: 1200,
    reasoning_effort: REASONING_OFF,
  });

  return readCompletionText(response, '好评回复');
}

export async function generateNeutralReply(reviewContent, neutralTemplates = '') {
  const openai = getClient();
  const prompt = `请为一条中性、短文本或信息不完整的拼多多评价生成一条保守客服回复。

评价内容：
${reviewContent || '(用户未填写具体内容)'}

中性回复模板参考：
${neutralTemplates || '感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们。'}

回复要求：
1. 不要脑补用户没有提到的产品体验。
2. 不要主动提音质、续航、佩戴、连接、降噪、通话等具体功能，除非评价原文明确提到。
3. 参考中性回复模板的语气和结构，只表达感谢、欢迎后续反馈、如有问题可联系客服。
4. 语气自然、简短，控制在 30-80 字。
5. 直接输出回复内容，不要加任何解释。
6. 不要使用空格、换行和表情符号（拼多多会拒收）。`;

  const response = await openai.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: '你是一个谨慎的电商客服，只生成保守回复，不夸大、不脑补。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.35,
    max_tokens: 800,
    reasoning_effort: REASONING_OFF,
  });

  return readCompletionText(response, '中性回复');
}

function buildSentimentPrompt(reviewContent, context = {}) {
  const promptTemplate = Object.hasOwn(context, 'promptOverride')
    ? context.promptOverride
    : (context.useStoredPrompt === false ? DEFAULT_SENTIMENT_PROMPT : getSentimentPrompt());
  return renderSentimentPrompt(
    promptTemplate,
    sentimentContextFromInput(reviewContent, context)
  );
}

/**
 * 分析评价情感：好评星级+差评内容检测
 * @param {string} reviewContent - 用户评价原文
 * @returns {Promise<{flagged: boolean, reason: string}>}
 */
export async function analyzeSentiment(reviewContent, context = {}) {
  const openai = getClient();

  const prompt = buildSentimentPrompt(reviewContent, context);
  const outcome = await requestSentimentWithRetry({
    prompt,
    parse: parseSentimentResponseStrict,
    request: async effectivePrompt => {
      const response = await openai.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: '你是质检助手，只返回严格JSON，不输出Markdown或解释。' },
          { role: 'user', content: effectivePrompt },
        ],
        ...SENTIMENT_REQUEST_OPTIONS,
      });
      return readCompletionText(response, '情感分析');
    },
  });
  return {
    ...outcome.result,
    analysisAttempts: outcome.attempts,
  };
}

export async function repairSentimentPromptWithAI(content = '') {
  const openai = getClient();
  const validation = validateSentimentPrompt(content);
  const prompt = `请修复下面这份“电商评价情感分析提示词”，让它可以直接用于 DeepSeek 判断拼多多耳机/音频产品评价是否能自动回复。

必须满足：
1. 保留四个标签：positive_auto_reply、neutral_auto_reply、risk_manual_review、uncertain_skip。
2. 保留变量：{{reviewContent}}、{{stars}}、{{productName}}、{{shopName}}、{{userName}}。
3. 输出要求必须是严格 JSON，字段固定为 label、can_auto_reply、is_real_negative、reason、risk_words、safe_positive_words。
4. 不要输出 Markdown、解释、代码块，只输出修复后的完整提示词正文。
5. 保持安全原则：风险评价不自动回复，无法判断时返回 uncertain_skip。

当前校验问题：
${validation.issues.join('\n') || '无'}

系统默认模板参考：
${DEFAULT_SENTIMENT_PROMPT}

用户当前模板：
${content || '(空模板)'}`;

  const response = await openai.chat.completions.create({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: '你是资深提示词工程师，只输出修复后的提示词正文。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1800,
  });

  const text = response.choices[0].message.content.trim()
    .replace(/^```(?:text)?/i, '')
    .replace(/```$/i, '')
    .trim();
  return repairSentimentPrompt(text, async ({ prompt: repaired }) => repaired);
}

export const __testing = {
  DEEPSEEK_MODEL,
  buildReplyPrompt,
  sentimentRequestOptions: () => ({ ...SENTIMENT_REQUEST_OPTIONS }),
  buildSentimentPrompt: (reviewContent, context = {}) => buildSentimentPrompt(reviewContent, {
    ...context,
    useStoredPrompt: false,
  }),
  normalizeSentimentResult,
  parseSentimentResponse,
};

/**
 * 测试 DeepSeek API 连接是否正常
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testConnection(apiKey = '') {
  const openai = getClient(apiKey);
  try {
    const response = await openai.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'user', content: '回复 OK' },
      ],
      max_tokens: 10,
      temperature: 0,
    });
    const text = response.choices[0].message.content.trim();
    return { ok: true, message: `连接成功 (模型: ${DEEPSEEK_MODEL})` };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('401') || msg.includes('Authentication')) {
      return { ok: false, message: 'API Key 无效，请检查' };
    }
    if (msg.includes('402') || msg.includes('Insufficient Balance')) {
      return { ok: false, message: '账户余额不足，请充值' };
    }
    if (msg.includes('429') || msg.includes('rate')) {
      return { ok: false, message: '请求太频繁，请稍后再试' };
    }
    return { ok: false, message: `连接失败: ${msg.substring(0, 100)}` };
  }
}
