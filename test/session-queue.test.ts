import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionQueue } from '../src/session-queue.js';

test('a stalled call cannot block another call and events within a call retain their order', { timeout: 5000 }, async () => {
  const queue = new SessionQueue(2, 8);
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const a = queue.submit('caller-a', async () => { order.push('a-start'); await blocked; order.push('a-end'); });
  const laterA = queue.submit('caller-a', async () => { order.push('a-later'); });
  try {
    await queue.submit('caller-b', async () => { order.push('b-ended'); });
    assert.deepEqual(order, ['a-start', 'b-ended']);
  } finally { release(); }
  await Promise.all([a, laterA]); await queue.idle();
  assert.deepEqual(order, ['a-start', 'b-ended', 'a-end', 'a-later']);
});

test('disconnect discards queued events without replaying them ahead of recovery', async () => {
  const queue = new SessionQueue(1, 8);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = queue.submit('a', () => blocked);
  let obsoleteRan = false;
  const obsolete = assert.rejects(queue.submit('a', async () => { obsoleteRan = true; }), /superseded/);
  queue.discardPending();
  const recovered = queue.submit('b', async () => {});
  release(); await Promise.all([first, obsolete, recovered]); await queue.idle();
  assert.equal(obsoleteRan, false);
});

test('queue capacity is bounded and a rejected job cannot stall later events', { timeout: 5000 }, async () => {
  const queue = new SessionQueue(1, 2);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = queue.submit('a', () => blocked);
  const failed = queue.submit('b', async () => { throw new Error('Injected provider failure'); });
  const failure = assert.rejects(failed, /Injected provider failure/);
  try { await assert.rejects(queue.submit('c', async () => {}), /queue full/); }
  finally { release(); }
  await first; await failure; await queue.idle();
  let ran = false;
  await queue.submit('b', async () => { ran = true; });
  assert.equal(ran, true);
});
