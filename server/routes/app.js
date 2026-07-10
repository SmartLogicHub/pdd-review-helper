import { Router } from 'express';

export function createAppRouter({ uiSessionManager }) {
  const router = Router();

  router.post('/session', (req, res) => {
    const { sessionId } = req.body || {};
    res.json({ success: true, ...uiSessionManager.register(sessionId) });
  });

  router.post('/heartbeat', (req, res) => {
    const { sessionId } = req.body || {};
    res.json({ success: true, ...uiSessionManager.heartbeat(sessionId) });
  });

  router.post('/session/close', (req, res) => {
    const { sessionId } = req.body || {};
    res.json({ success: true, ...uiSessionManager.close(sessionId) });
  });

  return router;
}
