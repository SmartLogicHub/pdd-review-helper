import { Router } from 'express';
import {
  createAccount,
  deleteAccount,
  getAccountsSummary,
  getAccountsState,
  markAccountOpened,
  switchAccount,
  updateAccount,
} from '../data/store.js';
import { closeBrowser, detectShopNameForAccount, initBrowser } from '../services/playwright.js';
import { sendAutomationError } from '../services/automation-api-response.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(getAccountsState());
});

router.get('/summary', (req, res) => {
  res.json(getAccountsSummary());
});

router.post('/', (req, res) => {
  try {
    const account = createAccount({ name: req.body?.name });
    res.json({ success: true, account, state: getAccountsState() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const account = updateAccount(req.params.id, req.body || {});
    res.json({ success: true, account, state: getAccountsState() });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/:id/switch', async (req, res) => {
  try {
    const account = switchAccount(req.params.id);
    await closeBrowser();
    res.json({ success: true, account, state: getAccountsState() });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/:id/open', async (req, res) => {
  try {
    const account = switchAccount(req.params.id);
    const ctx = await initBrowser({ accountId: account.id });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://mms.pinduoduo.com/goods/evaluation/index', {
      timeout: 60000,
      waitUntil: 'domcontentloaded',
    }).catch(() => {});
    const openedAccount = markAccountOpened(account.id);
    res.json({ success: true, account: openedAccount, state: getAccountsState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/detect-shop', async (req, res) => {
  try {
    if (req.body?.dryRun || req.query.dryRun === 'true') {
      return res.json({
        success: true,
        dryRun: true,
        message: 'dryRun：将打开该账号浏览器并识别真实店铺名，但不会写入账号档案',
        accountId: req.params.id,
      });
    }
    const account = switchAccount(req.params.id);
    const detected = await detectShopNameForAccount(account, { timeout: 45000 });
    res.json({ success: true, account: detected, state: getAccountsState() });
  } catch (err) {
    sendAutomationError(res, err);
  }
});

router.post('/detect-shops', async (req, res) => {
  const state = getAccountsState();
  if (req.body?.dryRun || req.query.dryRun === 'true') {
    return res.json({
      success: true,
      dryRun: true,
      message: 'dryRun：将按顺序打开所有账号并识别真实店铺名，但不会写入账号档案',
      accounts: state.accounts.map(account => ({
        accountId: account.id,
        accountName: account.name,
        currentShopName: account.shopName || '',
      })),
    });
  }
  const results = [];
  for (const account of state.accounts) {
    try {
      switchAccount(account.id);
      const detected = await detectShopNameForAccount(account, { timeout: 45000 });
      results.push({ accountId: account.id, success: true, shopName: detected.shopName });
    } catch (err) {
      results.push({ accountId: account.id, success: false, error: err.message });
    }
  }
  res.json({ success: results.every(item => item.success), results, state: getAccountsState() });
});

router.post('/browser/close', async (req, res) => {
  try {
    await closeBrowser();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const state = deleteAccount(req.params.id);
    res.json({ success: true, state });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
