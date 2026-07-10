import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUiSessionManager } from '../services/ui-session-manager.js';

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runAll() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, timer] of pending) timer.fn();
    },
    get count() {
      return timers.size;
    },
  };
}

test('schedules shutdown after the last UI session closes', () => {
  const timers = createFakeTimers();
  let shutdowns = 0;
  const manager = createUiSessionManager({
    shutdownDelayMs: 15000,
    onShutdown: () => { shutdowns += 1; },
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });

  manager.register('page-1');
  manager.close('page-1');

  assert.equal(timers.count, 1);
  timers.runAll();
  assert.equal(shutdowns, 1);
});

test('new UI heartbeat cancels pending shutdown after refresh', () => {
  const timers = createFakeTimers();
  let shutdowns = 0;
  const manager = createUiSessionManager({
    shutdownDelayMs: 15000,
    onShutdown: () => { shutdowns += 1; },
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });

  manager.register('old-page');
  manager.close('old-page');
  manager.heartbeat('new-page');

  assert.equal(timers.count, 0);
  timers.runAll();
  assert.equal(shutdowns, 0);
});

test('does not schedule shutdown while another UI session is still open', () => {
  const timers = createFakeTimers();
  const manager = createUiSessionManager({
    shutdownDelayMs: 15000,
    onShutdown: () => {},
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });

  manager.register('page-1');
  manager.register('page-2');
  manager.close('page-1');

  assert.equal(manager.getActiveCount(), 1);
  assert.equal(timers.count, 0);
});
