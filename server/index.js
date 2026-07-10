import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import reviewsRouter from './routes/reviews.js';
import settingsRouter from './routes/settings.js';
import templatesRouter from './routes/templates.js';
import sentimentRouter from './routes/sentiment.js';
import automationRouter from './routes/automation.js';
import accountsRouter from './routes/accounts.js';
import { createAppRouter } from './routes/app.js';
import { createUiSessionManager } from './services/ui-session-manager.js';
import { automationManager } from './services/automation.js';
import { closeBrowser } from './services/playwright.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 在 pkg 打包模式下，使用 exe 所在目录作为应用根目录
const APP_DIR = process.env.APP_DIR || join(__dirname);
const app = express();
const PORT = Number(process.env.PDD_HELPER_PORT || 3001);
let server;
let shuttingDown = false;

async function shutdownApp(reason = 'ui-closed') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`正在关闭拼多多评价助手: ${reason}`);
  try {
    automationManager.stopActiveJob();
  } catch (err) {
    console.warn('停止自动化任务失败:', err.message);
  }
  try {
    await closeBrowser();
  } catch (err) {
    console.warn('关闭自动化浏览器失败:', err.message);
  }
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}

const uiSessionManager = createUiSessionManager({
  shutdownDelayMs: Number(process.env.PDD_HELPER_UI_SHUTDOWN_DELAY_MS || 15000),
  onShutdown: shutdownApp,
});

app.use(cors());
app.use(express.json());

// API 路由
app.use('/api/app', createAppRouter({ uiSessionManager }));
app.use('/api/accounts', accountsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/sentiment', sentimentRouter);
app.use('/api/automation', automationRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 托管前端静态文件
const staticDir = join(APP_DIR, 'public');
app.use(express.static(staticDir));
app.get('*', (req, res) => {
  res.sendFile(join(staticDir, 'index.html'));
});

server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`🚀 服务已启动: ${url}`);
  // 自动打开浏览器
  exec(`start "" "${url}"`);
});
