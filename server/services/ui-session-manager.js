export function createUiSessionManager({
  shutdownDelayMs = 15000,
  onShutdown = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  let shutdownTimer = null;

  function cancelShutdown() {
    if (!shutdownTimer) return;
    clearTimer(shutdownTimer);
    shutdownTimer = null;
  }

  function scheduleShutdown() {
    if (sessions.size > 0 || shutdownTimer) return;
    shutdownTimer = setTimer(() => {
      shutdownTimer = null;
      if (sessions.size === 0) onShutdown('last-ui-session-closed');
    }, shutdownDelayMs);
    shutdownTimer?.unref?.();
  }

  function register(sessionId) {
    if (!sessionId) return { activeCount: sessions.size };
    sessions.set(sessionId, now());
    cancelShutdown();
    return { activeCount: sessions.size };
  }

  function heartbeat(sessionId) {
    return register(sessionId);
  }

  function close(sessionId) {
    if (sessionId) sessions.delete(sessionId);
    if (sessions.size === 0) scheduleShutdown();
    return { activeCount: sessions.size };
  }

  function getActiveCount() {
    return sessions.size;
  }

  return {
    register,
    heartbeat,
    close,
    getActiveCount,
  };
}
