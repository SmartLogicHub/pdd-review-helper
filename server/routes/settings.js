import { Router } from 'express';
import { getPublicSettings, getSettings, saveSettings } from '../data/store.js';
import { isMaskedApiKey, parseFeishuBitableUrl } from '../data/settings-utils.js';
import { testConnection } from '../services/deepseek.js';
import { createFeishuClient, RISK_TABLE_NAME, RISK_TABLE_REQUIRED_FIELDS } from '../services/risk-sync.js';

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

// 测试飞书台账：用表单里当前填写的值（未保存也可以测），检查能否访问、7 个必需字段是否齐全
router.post('/test-feishu', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = { ...getSettings() };
    if (typeof body.feishuAppId === 'string' && body.feishuAppId.trim()) {
      settings.feishuAppId = body.feishuAppId.trim();
    }
    if (typeof body.feishuAppSecret === 'string' && body.feishuAppSecret.trim() && !isMaskedApiKey(body.feishuAppSecret)) {
      settings.feishuAppSecret = body.feishuAppSecret.trim();
    }
    if (typeof body.feishuBitableUrl === 'string' && body.feishuBitableUrl.trim()) {
      const parsed = parseFeishuBitableUrl(body.feishuBitableUrl);
      if (!parsed.appToken || !parsed.tableId) {
        return res.json({ ok: false, message: '无法从链接里识别出表格和数据表，请在飞书里打开「' + RISK_TABLE_NAME + '」表后复制浏览器地址栏的完整链接' });
      }
      settings.feishuAppToken = parsed.appToken;
      settings.feishuTableId = parsed.tableId;
    }
    const result = await createFeishuClient(settings).validateRiskTable({ force: true });
    if (!result.ok) {
      return res.json({ ok: false, message: result.error, missingFields: result.missingFields });
    }
    res.json({
      ok: true,
      message: `飞书台账可用：${RISK_TABLE_REQUIRED_FIELDS.length} 个必需字段齐全。如果写入时提示无权限，请把应用设为该多维表格的「可编辑」协作者`,
    });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

export default router;
