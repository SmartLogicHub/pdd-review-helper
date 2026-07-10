import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateReply, generateNeutralReply, analyzeSentiment as askLLM } from './deepseek.js';
import { getNeutralTemplates, getSettings, getTemplates } from '../data/store.js';

// 缓存话术
let templatesCache = null;
let genericTemplates = [];
let neutralTemplatesCache = null;
const DEFAULT_NEUTRAL_TEMPLATES = [
  '感谢您的评价，后续使用中如有任何问题，欢迎随时联系我们，我们会及时为您处理。',
  '感谢您的反馈，产品使用过程中如有疑问或需要帮助，可以随时联系我们，祝您生活愉快。',
  '感谢您的支持，后续如有任何使用问题都可以联系店铺客服，我们会尽快协助处理。',
];

export function resetReplyTemplateCache() {
  templatesCache = null;
  genericTemplates = [];
  neutralTemplatesCache = null;
}

function loadTemplates() {
  if (templatesCache) return templatesCache;
  const raw = getTemplates();
  const lines = raw.split('\n').filter(l => l.trim());
  templatesCache = lines;

  // 提取通用话术（前几条作为默认模板）
  genericTemplates = lines.length >= 4
    ? [lines[0], lines[Math.floor(lines.length/3)], lines[Math.floor(lines.length*2/3)], lines[lines.length-1]]
    : lines;
  return templatesCache;
}

function loadNeutralTemplates() {
  if (neutralTemplatesCache) return neutralTemplatesCache;
  const raw = getNeutralTemplates();
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
  neutralTemplatesCache = lines.length > 0 ? lines : DEFAULT_NEUTRAL_TEMPLATES;
  return neutralTemplatesCache;
}

/**
 * 判断评价是否有实质内容
 */
function hasContent(reviewText) {
  // 只匹配“完全无内容”的情况（空文本、纯默认提示）
  const emptyPatterns = [
    /^该用户未填写/,
    /^此用户没有填写/,
    /^用户.*未填写评价/,
  ];
  const trimmed = reviewText.trim();
  if (!trimmed) return false;
  if (emptyPatterns.some(p => p.test(trimmed))) return false;
  return true;
}

const SOFT_EVALUATION_PATTERN = /^(还行吧?|还可以吧?|一般|一般般|凑合|中规中矩|尚可|过得去)[。！!,.，\s]*$/;
const MEANINGLESS_PATTERN = /^(?:\d+|[a-zA-Z]{1,5}|哈{1,}|哈哈+|[^\u4e00-\u9fa5a-zA-Z0-9]{1,8})$/;
const NOT_USED_PATTERN = /刚拿到|刚到手|还没用|没用过|还没开始使用|不知道好不好用|看后期|帮人买|帮别人买|替.*买/;
const INCOMPLETE_ATTRIBUTE_PATTERN = /^(?:续航时间|控制便捷性|连接稳定性|音质表现|兼容性|外观设计|防水性能|舒适度|降噪效果|价格)[:：]?\s*$/;
const OTHER_PRODUCT_POSITIVE_PATTERN = /(?:华强北|以前|之前|上一个|老款|别的|其他|便宜的).{0,24}(?:耳朵疼|耳朵痛|坏了|不好|不舒服|差点意思|不耐用).{0,24}(?:这个|这款|现在|新款|入手).{0,24}(?:很好|好用|不会疼|不疼|好多了|不错|喜欢)/;

const SAFE_POSITIVE_PATTERNS = [
  /无杂音|没有杂音|没什么杂音|不会有杂音/,
  /无延迟|没有延迟|没啥延迟|无延迟问题/,
  /不疼|不痛|不会疼|不会痛|不会很痛|不夹耳|不压耳|不挤耳|不胀耳|不容易掉|不易滑落|不滑落|不会掉|没有不舒服|没觉得疼|不会感觉不舒服/,
  /音质(?:清晰|很好|不错|超赞|纯正|好)/,
  /连接(?:稳定|很稳|快速|很快)/,
  /佩戴(?:舒适|舒服)|戴着(?:舒服|很稳|轻便)/,
  /续航(?:很长|超久|蛮久|耐用|给力|长)/,
  /小巧(?:好看|玲珑)?|小小的|便携/,
  /售后有保障|售后服务好/,
  /喜欢|满意|值得购买|物有所值|性价比(?:高|超高)|非常好用|很好用|好用/,
];

const RISK_PATTERNS = [
  /有点(?:闷|疼|痛|难受|失望|夹|卡|糊|不舒服|反人类)/,
  /(?<!没)(?<!没有)(?<!无)(?<!不会)(?<!没什么)有(?:杂音|电流声|延迟|漏音|卡顿)/,
  /(?:延迟|声音|音量).{0,8}(?:高|大|小|低|闷|不够大|一大一小)/,
  /(?:耳朵|佩戴|戴着).{0,12}(?:疼|痛|难受|不舒服|夹|挂不住)/,
  /(?<!不)(?<!不会)(?<!没有)(?<!没觉得)夹(?:头|耳)|断连|连接(?:不稳|不稳定|不上|失败)|不支持|不降噪|漏音|卡顿|坏了|坏掉|裂开|断了|没声音|没声|不能用|用不了|想退|想换|不推荐|避雷|慎重购买/,
  /降噪.{0,10}(?:差|一般|不太理想|没感觉|好像没有|没有|不行|隔绝不了)/,
  /(?:售后|客服).{0,12}(?:差|不处理|不解决|找不到|推脱)/,
  /(?:音质|降噪|通话质量|麦克风|舒适度|防水性能).{0,8}(?:一般|一般般|凑合|中规中矩|尚可|过得去)/,
  /(?:但是|但|就是|不过|然而|可惜).{0,36}(?:闷|疼|痛|差|不好|不舒服|不支持|炸麦|杂音|电流|断连|延迟|失望|漏音|卡顿|反应不过来|听不清|声音小|不稳|问题|毛刺|不顺畅|距离短|音量低)/,
  /真不错.{0,12}(?:坏了|没声|不能用)|太可以了.{0,12}(?:没声|坏了|不能用)|聋了|反人类/,
];

const KEY_EXPERIENCE_SOFT_PATTERN = /(?:音质|降噪|连接|舒适度|续航|通话质量|麦克风|声音|控制便捷性|兼容性|防水性能).{0,8}(?:还行吧?|还可以吧?)/;

function normalizeArray(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
}

function sentimentResult(label, reason = '', riskWords = [], safePositiveWords = []) {
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
    reason,
    riskWords: normalizeArray(riskWords),
    risk_words: normalizeArray(riskWords),
    safePositiveWords: normalizeArray(safePositiveWords),
    safe_positive_words: normalizeArray(safePositiveWords),
  };
}

function collectMatches(text, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) matches.push(match[0]);
  }
  return [...new Set(matches)];
}

function isNegatedRiskMatch(match = '') {
  return /(?:无|没有|没什么|不会有)(?:杂音|延迟|电流声|漏音|卡顿)/.test(match)
    || /(?:不|不会|没有|没觉得|不容易|不易|没有什么).{0,5}(?:疼|痛|夹|压耳|滑落|掉|不舒服|难受)/.test(match);
}

function isClearlyPositive(text) {
  return SAFE_POSITIVE_PATTERNS.some(pattern => pattern.test(text));
}

function hasRealRisk(text) {
  const matches = collectMatches(text, RISK_PATTERNS).filter(match => !isNegatedRiskMatch(match));
  if (matches.length === 0) return null;
  return matches;
}

export function detectLocalRiskSentiment(reviewContent = '') {
  const text = String(reviewContent || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return sentimentResult('neutral_auto_reply', '评价为空或无实质内容，使用保守回复');
  }

  if (OTHER_PRODUCT_POSITIVE_PATTERN.test(text)) {
    const safeWords = collectMatches(text, SAFE_POSITIVE_PATTERNS);
    return sentimentResult('positive_auto_reply', '负面描述指向其他/历史商品，当前商品表达正面', [], safeWords);
  }

  const riskWords = hasRealRisk(text);
  if (riskWords) {
    return sentimentResult('risk_manual_review', `当前商品存在“${riskWords[0]}”等负面体验，需人工复核`, riskWords);
  }

  if (KEY_EXPERIENCE_SOFT_PATTERN.test(text) && !isClearlyPositive(text)) {
    const signal = text.match(KEY_EXPERIENCE_SOFT_PATTERN)?.[0] || '关键体验语气模糊';
    return sentimentResult('uncertain_skip', `关键体验项“${signal}”语气不够明确，跳过自动回复`);
  }

  if (SOFT_EVALUATION_PATTERN.test(text) || MEANINGLESS_PATTERN.test(text) || NOT_USED_PATTERN.test(text) || INCOMPLETE_ATTRIBUTE_PATTERN.test(text) || text.length <= 2) {
    return sentimentResult('neutral_auto_reply', '评价信息较少或语气中性，使用保守回复');
  }

  const safeWords = collectMatches(text, SAFE_POSITIVE_PATTERNS);
  if (safeWords.length > 0) {
    return sentimentResult('positive_auto_reply', '评价整体正面且未发现当前商品负面体验', [], safeWords);
  }

  return sentimentResult('positive_auto_reply', '未发现当前商品负面体验');
}

/**
 * 分析评价情感：好评星级 + 差评内容？
 * @param {string} reviewContent - 评价原文
 * @param {number} stars - 星级
 * @returns {Promise<{flagged: boolean, reason: string}>}
 */
export async function analyzeSentiment(reviewContent, stars, context = {}) {
  // 4星以下不分析（本身就可能是不满）
  if (stars < 4) return sentimentResult('uncertain_skip', '低于4星，不进入好评自动回复判断');
  
  // 无实质内容不分析（拼多多默认文案）
  if (!hasContent(reviewContent)) return sentimentResult('neutral_auto_reply', '评价无实质内容，使用保守回复');

  const settings = getSettings();
  if (settings.aiSentimentEnabled && settings.deepseekApiKey) {
    try {
      return await askLLM(reviewContent, { ...context, stars });
    } catch (err) {
      console.log('  情感分析失败，按无法判断跳过:', err.message);
      return sentimentResult('uncertain_skip', 'AI情感分析失败，跳过自动回复');
    }
  }

  return detectLocalRiskSentiment(reviewContent);
}

/**
 * 根据评价内容生成回复
 * @param {string} reviewContent - 用户评价原文
 * @returns {Promise<{reply: string, method: 'llm'|'template'}|{skip: true, reason: string}>}
 */
export async function getReply(reviewContent, options = {}) {
  loadTemplates();

  const content = typeof reviewContent === 'object' && reviewContent
    ? (reviewContent.content || reviewContent.appendContent || '')
    : String(reviewContent || '');
  const isNeutral = Boolean(
    options.neutral
    || reviewContent?.neutralReply
    || reviewContent?.sentimentLabel === 'neutral_auto_reply'
  );
  const contentResult = hasContent(content);
  const aiEnabled = getSettings().aiReplyEnabled;

  if (isNeutral) {
    const neutralTemplates = loadNeutralTemplates();
    if (aiEnabled) {
      try {
        const reply = await generateNeutralReply(content, neutralTemplates.join('\n'));
        return { reply, method: 'neutral-llm' };
      } catch (err) {
        console.log(`    [getReply] 中性 LLM 失败，回退到保守模板: ${err.message}`);
      }
    }
    const idx = Math.floor(Math.random() * neutralTemplates.length);
    return { reply: neutralTemplates[idx], method: 'neutral-template' };
  }

  if (contentResult && aiEnabled) {
    // 有实质内容 → LLM 生成
    try {
      const reply = await generateReply(content, templatesCache.join('\n'));
      return { reply, method: 'llm' };
    } catch (err) {
      console.log(`    [getReply] LLM 失败，回退到模板: ${err.message}`);
      const idx = Math.floor(Math.random() * genericTemplates.length);
      return { reply: genericTemplates[idx], method: 'template' };
    }
  } else {
    // 无内容 → 随机通用模板
    const idx = Math.floor(Math.random() * genericTemplates.length);
    return { reply: genericTemplates[idx], method: 'template' };
  }
}

