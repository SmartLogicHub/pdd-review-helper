import { Router } from 'express';
import { getPublicSettings, getSettings, saveSettings } from '../data/store.js';
import { isMaskedApiKey } from '../data/settings-utils.js';
import { testConnection } from '../services/deepseek.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(getPublicSettings());
});

router.put('/', (req, res) => {
  saveSettings(req.body);
  res.json({ success: true, settings: getPublicSettings() });
});

// 测试 DeepSeek API 连接
router.post('/test-key', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const keyToTest = isMaskedApiKey(apiKey) ? getSettings().deepseekApiKey : apiKey;
    const result = await testConnection(keyToTest);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

export default router;
