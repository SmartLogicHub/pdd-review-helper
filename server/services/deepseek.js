import OpenAI from 'openai';
import { getSentimentPrompt, getSettings } from '../data/store.js';
import {
  DEFAULT_SENTIMENT_PROMPT,
  normalizeSentimentResult,
  parseSentimentResponse,
  repairSentimentPrompt,
  renderSentimentPrompt,
  sentimentContextFromInput,
  validateSentimentPrompt,
} from './sentiment-core.js';

let client = null;
let clientKey = '';

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
export async function generateReply(reviewContent, templates) {
  const openai = getClient();

  const prompt = `你是一个拼多多耳机店铺「HECATE/漫步者」的客服。请根据用户评价，参考以下话术模板，生成一条真诚、个性化的回复。

## 话术模板参考：
${templates}

## 回复要求：
1. 必须参考上面话术的语气和风格（亲切、真诚、有温度）
2. 根据用户评价的具体内容匹配对应风格（如评价提到音质→用音质类话术；提到佩戴舒适→用舒适度话术）
3. 回复长度控制在 50-150 字
4. 不要复制粘贴原文，要结合用户评价内容个性化
5. 直接输出回复内容，不要加任何前缀说明

## 用户评价：
${reviewContent}

请生成回复：`;

  const response = await openai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是一个专业的拼多多耳机店铺客服，回复风格亲切真诚。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    max_tokens: 300,
  });

  return response.choices[0].message.content.trim();
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
5. 直接输出回复内容，不要加任何解释。`;

  const response = await openai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是一个谨慎的电商客服，只生成保守回复，不夸大、不脑补。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.35,
    max_tokens: 160,
  });

  return response.choices[0].message.content.trim();
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

  const response = await openai.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是质检助手，只返回严格JSON，不输出Markdown或解释。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 220,
  });

  const text = response.choices[0].message.content.trim();
  try {
    return parseSentimentResponse(text);
  } catch (e) {
    return normalizeSentimentResult({ label: 'uncertain_skip', reason: 'AI判断结果不是有效JSON，跳过自动回复' });
  }
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
    model: 'deepseek-chat',
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
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: '回复 OK' },
      ],
      max_tokens: 10,
      temperature: 0,
    });
    const text = response.choices[0].message.content.trim();
    return { ok: true, message: `连接成功 (模型: deepseek-chat)` };
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
