import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing as deepseekTesting } from '../services/deepseek.js';
import { detectLocalRiskSentiment } from '../services/reply-strategy.js';

test('sentiment prompt explicitly covers sarcasm and mixed praise criticism', () => {
  const prompt = deepseekTesting.buildSentimentPrompt('挺好的，就是声音有点闷');

  assert.match(prompt, /阴阳怪气|反讽|讽刺/);
  assert.match(prompt, /先夸后踩|转折/);
  assert.match(prompt, /表面.*好评|真实情绪/);
  assert.match(prompt, /positive_auto_reply/);
  assert.match(prompt, /neutral_auto_reply/);
  assert.match(prompt, /risk_manual_review/);
  assert.match(prompt, /uncertain_skip/);
  assert.match(prompt, /无杂音|没有延迟|不疼|不夹耳/);
});

test('local sentiment fallback flags subtle negative 4 or 5 star reviews', () => {
  const result = detectLocalRiskSentiment('还行吧，无线挺好用，之前用G4，对比下来感觉有点闷');

  assert.equal(result.label, 'risk_manual_review');
  assert.equal(result.flagged, true);
  assert.equal(result.isRealNegative, true);
  assert.match(result.reason, /有点闷|当前商品/);
});

test('local sentiment fallback allows clearly positive reviews', () => {
  const result = detectLocalRiskSentiment('音质很好，连接稳定，佩戴也很舒服，非常满意');

  assert.equal(result.flagged, false);
  assert.equal(result.label, 'positive_auto_reply');
  assert.equal(result.canAutoReply, true);
});

test('local sentiment fallback does not flag negated risk words as negative', () => {
  const safeSamples = [
    '音质清晰无杂音，佩戴轻盈不压耳，续航超久，连接稳定',
    '没有杂音，连接也很稳定，听歌效果不错',
    '戴久了也不疼，不夹耳，挺舒服的',
    '华强北的耳机戴得我耳朵疼，这个就很好不会疼',
    '小巧好看，音质清晰，续航很长',
    '售后有保障，物流快，商品质量不错',
  ];

  for (const sample of safeSamples) {
    const result = detectLocalRiskSentiment(sample);
    assert.equal(result.label, 'positive_auto_reply', sample);
    assert.equal(result.flagged, false, sample);
    assert.equal(result.canAutoReply, true, sample);
  }
});

test('local sentiment fallback allows neutral low-information reviews to receive conservative replies', () => {
  const neutralSamples = ['还行', '还可以', '一般', '哈哈', '123456789', '刚拿到，还没用', '帮人买的，还不知道怎么样', '续航时间'];

  for (const sample of neutralSamples) {
    const result = detectLocalRiskSentiment(sample);
    assert.equal(result.label, 'neutral_auto_reply', sample);
    assert.equal(result.flagged, false, sample);
    assert.equal(result.uncertain, false, sample);
    assert.equal(result.neutral, true, sample);
    assert.equal(result.canAutoReply, true, sample);
    assert.equal(result.isRealNegative, false, sample);
  }
});

test('local sentiment fallback flags current-product risk experiences', () => {
  const riskySamples = [
    '音质很好，就是漏音',
    '佩戴舒服，但是延迟有点高',
    '有杂音，但是偶尔有又偶尔没有',
    '老是断连，连接不稳定',
    '降噪效果一般',
    '不支持ACC，不好，没想到',
  ];

  for (const sample of riskySamples) {
    const result = detectLocalRiskSentiment(sample);
    assert.equal(result.label, 'risk_manual_review', sample);
    assert.equal(result.flagged, true, sample);
    assert.equal(result.canAutoReply, false, sample);
    assert.equal(result.isRealNegative, true, sample);
  }
});
