import { Router } from 'express';
import {
  getCurrentAccount,
  getSentimentPrompt,
  resetSentimentPrompt,
  saveSentimentPrompt,
} from '../data/store.js';
import {
  DEFAULT_SENTIMENT_PROMPT,
  normalizeSentimentResult,
  reanalyzeStoredReviews,
  repairSentimentPrompt,
  validateSentimentPrompt,
} from '../services/sentiment.js';
import { analyzeSentiment, repairSentimentPromptWithAI } from '../services/deepseek.js';
import { analyzeSentiment as analyzeWithStrategy } from '../services/reply-strategy.js';

function promptPayload(content = getSentimentPrompt()) {
  return {
    content,
    defaultContent: DEFAULT_SENTIMENT_PROMPT,
    validation: validateSentimentPrompt(content),
  };
}

export function createSentimentRouter({
  analyzeReview = analyzeSentiment,
  repairPromptWithAI = repairSentimentPromptWithAI,
  reanalyzeReviews = reanalyzeStoredReviews,
} = {}) {
  const router = Router();

  router.get('/prompt', (req, res) => {
    res.json(promptPayload());
  });

  router.put('/prompt', (req, res) => {
    try {
      const content = String(req.body?.content || '');
      if (!content.trim()) {
        const restored = resetSentimentPrompt();
        return res.json({ success: true, restoredDefault: true, ...promptPayload(restored) });
      }
      const validation = validateSentimentPrompt(content);
      if (!validation.ok) {
        return res.status(400).json({
          ok: false,
          error: '情感分析提示词格式不正确，未保存',
          validation,
          current: promptPayload(),
        });
      }
      const saved = saveSentimentPrompt(content);
      res.json({ success: true, restoredDefault: false, ...promptPayload(saved) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/prompt/reset', (req, res) => {
    try {
      const restored = resetSentimentPrompt();
      res.json({ success: true, restoredDefault: true, ...promptPayload(restored) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/prompt/repair', async (req, res) => {
    try {
      const content = String(req.body?.content || '');
      const result = await repairSentimentPrompt(content, async () => {
        const repaired = await repairPromptWithAI(content);
        return repaired?.prompt || repaired?.content || repaired;
      });
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          error: 'DeepSeek 修复后的提示词仍不合格，未保存',
          validation: { ok: false, issues: result.issues },
        });
      }
      res.json({
        ok: true,
        content: result.prompt,
        validation: validateSentimentPrompt(result.prompt),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/test', async (req, res) => {
    try {
      const account = getCurrentAccount();
      const review = {
        content: String(req.body?.reviewContent || req.body?.content || ''),
        stars: Number(req.body?.stars || 5),
        productName: String(req.body?.productName || ''),
        userName: String(req.body?.userName || ''),
      };
      const result = normalizeSentimentResult(await analyzeReview(review.content, {
        stars: review.stars,
        productName: review.productName,
        userName: review.userName,
        shopName: account.shopName || account.name || '',
        promptOverride: req.body?.promptOverride,
      }));
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function runReanalysis(req, res, apply) {
    try {
      const scope = req.body?.scope === 'all' ? 'all' : 'current';
      const accountId = req.body?.accountId || '';
      const summary = await reanalyzeReviews({
        accountId,
        scope,
        apply,
        analyzer: (review, account) => analyzeWithStrategy(review.content || review.appendContent || '', review.stars, {
          productName: review.productName || '',
          userName: review.userName || '',
          shopName: account.shopName || account.name || '',
        }),
      });
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  router.post('/reanalyze/preview', (req, res) => runReanalysis(req, res, false));
  router.post('/reanalyze/apply', (req, res) => runReanalysis(req, res, true));

  return router;
}

export default createSentimentRouter();
