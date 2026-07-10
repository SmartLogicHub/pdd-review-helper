import { Router } from 'express';
import { getNeutralTemplates, getTemplates, saveNeutralTemplates, saveTemplates } from '../data/store.js';
import { resetReplyTemplateCache } from '../services/reply-strategy.js';

const router = Router();

router.get('/neutral', (req, res) => {
  res.json({ content: getNeutralTemplates() });
});

router.put('/neutral', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '模板内容不能为空' });
  }
  saveNeutralTemplates(content);
  resetReplyTemplateCache();
  res.json({ success: true });
});

router.get('/', (req, res) => {
  res.json({ content: getTemplates() });
});

router.put('/', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '模板内容不能为空' });
  }
  saveTemplates(content);
  resetReplyTemplateCache();
  res.json({ success: true });
});

export default router;
