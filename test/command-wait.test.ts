import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, primary, destination, config, log } from './helpers.js';
import { Switchboard } from '../src/switchboard.js';

test('seven-minute reply deadline survives recovery and ends every owned leg at the boundary', async t => {
  const f = await fixture(); let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    await f.board.privateMode(primary);
    const deadline = (await f.store.get(primary))?.replyDeadline;
    assert.equal(deadline, now + 420_000);
    now += 419_999;
    const restarted = new Switchboard(f.store, f.providers, log, config.OPERATOR_PIN);
    await restarted.suspendControls(); await restarted.reconcile();
    assert.equal((await f.store.get(primary))?.replyDeadline, deadline);
    assert.equal((await f.store.get(primary))?.phase, 'active');
    now++;
    await restarted.expireWindows();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.ok(f.providers.ended.includes(primary));
    assert.ok(f.providers.closed);
  } finally { await f.dispose(); }
});

test('unanswered private wake ends caller and destination, ordinary conversation has no idle timer', async t => {
  const f = await fixture(); let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    const d = (await f.store.get(primary))?.destination; assert.ok(d);
    f.providers.calls.set(destination, 'in-progress');
    await f.board.leg(primary, d.attempt, 'destination', destination, 'in-progress');
    await f.board.reconcile(); await f.acknowledge();
    assert.equal((await f.store.get(primary))?.replyDeadline, null);
    now += 500_000; await f.board.expireWindows();
    assert.equal((await f.store.get(primary))?.phase, 'active');
    await f.board.transcript(primary, 'vapi-id', 'Operator', now);
    assert.equal((await f.store.get(primary))?.commandDeadline, null);
    assert.equal((await f.store.get(primary))?.destination?.held, true);
    now += 420_000; await f.board.expireWindows();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.ok(f.providers.ended.includes(primary)); assert.ok(f.providers.ended.includes(destination));
  } finally { await f.dispose(); }
});

test('a fresh natural reply renews the seven-minute wait', async t => {
  const f = await fixture(); let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    await f.board.privateMode(primary);
    now += 400_000;
    await f.board.transcript(primary, 'vapi-id', 'hello', now);
    assert.equal((await f.store.get(primary))?.replyDeadline, now + 420_000);
    now++;
    await f.board.transcript(primary, 'vapi-id', 'please repeat', now);
    assert.equal((await f.store.get(primary))?.replyDeadline, now + 420_000);
    now += 20_001; await f.board.expireWindows();
    assert.equal((await f.store.get(primary))?.phase, 'active');
  } finally { await f.dispose(); }
});

test('a stale different transcript does not prevent a later matching command webhook', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator status');
    const pending = f.board.tool(primary, 'vapi-id', 'late-final', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await new Promise(resolve => setTimeout(resolve, 75));
    await f.utterance('Operator call office');
    assert.deepEqual(await pending, { result: 'Dialing now.' });
    assert.equal((await f.store.get(primary))?.destination?.label, 'office');
  } finally { await f.dispose(); }
});

test('an unclear contact command stays private for a fresh retry and executes only the corrected target', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call ofice');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'misheard', 'manage_outbound_call', {
      action: 'dial', label: 'ofice', utterance: 'Operator call ofice',
    }), { error: 'Contact not found. Who should I call?' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    assert.equal(f.providers.creates, 0);
    await f.utterance('Operator call office');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'corrected', 'manage_outbound_call', {
      action: 'dial', label: 'office', utterance: 'Operator call office',
    }), { result: 'Dialing now.' });
    await f.acknowledge();
    assert.equal(f.providers.creates, 1);
  } finally { await f.dispose(); }
});
