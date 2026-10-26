import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, primary, destination, operator, conference } from './helpers.js';
import { Switchboard } from '../src/switchboard.js';
import { Store } from '../src/store.js';
import { log } from './helpers.js';
import { createHash } from 'node:crypto';

test('dial, duplicate, answered, private switch and hangup preserve the primary', async () => {
  const f = await fixture();
  try {
    const args = { action: 'dial', label: ' OFFICE ', utterance: 'Operator call office' };
    await f.utterance(args.utterance);
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'dial-1', 'manage_outbound_call', args), { result: 'Dialing now.' });
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'dial-1', 'manage_outbound_call', args), { result: 'Dialing now.' });
    assert.equal(f.providers.creates, 0);
    await f.acknowledge();
    assert.equal(f.providers.creates, 1);
    const attempt = (await f.store.get(primary))?.destination?.attempt;
    assert.ok(attempt);
    f.providers.calls.set(destination, 'in-progress');
    await f.board.leg(primary, attempt, 'destination', destination, 'in-progress');
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.commandMode, 'closed');
    assert.equal(f.providers.holds.at(-1)?.held, false);
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'blocked', 'manage_outbound_call', { action: 'hangup', utterance: 'Operator hang up' }), { error: 'Say Operator for private commands.' });
    await f.board.privateMode(primary); await f.board.joined(primary, conference);
    await f.utterance('Operator switch to number 1');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'switch', 'manage_outbound_call', { action: 'switch', label: 'number 1', utterance: 'Operator switch to number 1' }), { result: 'End this call and call number 1?' });
    assert.deepEqual(await f.confirm(), { result: 'Switching now.' });
    assert.deepEqual(f.providers.ended, [destination]);
    await f.acknowledge();
    assert.equal(f.providers.creates, 2);
    assert.equal((await f.store.get(primary))?.destination?.label, 'number 1');
    await f.acknowledge(); await f.board.privateMode(primary); await f.board.joined(primary, conference);
    // Fake ringing participant is initially muted, but must be held before arming.
    await f.store.locked(primary, async s => { if (s.destination) s.destination.held = true; });
    await f.board.joined(primary, conference);
    await f.utterance('Operator hang up');
    await f.board.tool(primary, 'vapi-id', 'hangup', 'manage_outbound_call', { action: 'hangup', utterance: 'Operator hang up' });
    assert.equal((await f.store.get(primary))?.destination, null);
    assert.ok(!f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});
test('unknown label and spoofed utterance cannot dial or end a session', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'spoof', 'end_operator_session', { utterance: 'Operator, end session' }), { error: 'Please repeat what you would like.' });
    await f.acknowledge(); await f.utterance('Operator call missing');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'missing', 'manage_outbound_call', { action: 'dial', label: 'missing', utterance: 'Operator call missing' }), { error: 'Contact not found. Who should I call?' });
    assert.equal(f.providers.creates, 0); assert.equal(f.providers.closed, false);
  } finally { await f.dispose(); }
});
test('ambiguous creation survives restart, reconciles by label and is never redialed', async () => {
  const f = await fixture();
  try {
    f.providers.ambiguous = true;
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'ambiguous', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.destination?.state, 'unknown');
    const recovered = new Switchboard(new Store(f.db), f.providers, log);
    await recovered.reconcile();
    assert.equal((await f.store.get(primary))?.destination?.callId, destination);
    assert.equal(f.providers.creates, 1);
    const history = await f.db.query("SELECT role FROM call_attempts WHERE role='destination'");
    assert.equal(history.rowCount, 1);
  } finally { await f.dispose(); }
});
test('unresolved creation blocks replacement and late callbacks cannot affect new attempts', async () => {
  const f = await fixture();
  try {
    f.providers.ambiguous = true; await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'lost', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    const old = (await f.store.get(primary))?.destination;
    assert.ok(old); f.providers.participants.delete(old.participantLabel);
    await f.acknowledge();
    await f.store.locked(primary, async s => { s.commandMode = 'open'; s.commandOpenedAt = Date.now() - 1000; });
    await f.utterance('Operator switch to number 1');
    const reply = await f.board.tool(primary, 'vapi-id', 'blocked-switch', 'manage_outbound_call', { action: 'switch', label: 'number 1', utterance: 'Operator switch to number 1' });
    assert.deepEqual(reply, { result: 'End this call and call number 1?' });
    assert.deepEqual(await f.confirm(), { result: 'Switching now.' }); assert.equal(f.providers.creates, 1);
    await f.board.leg(primary, '00000000-0000-4000-8000-000000000000', 'destination', destination, 'completed');
    assert.equal((await f.store.get(primary))?.destination?.attempt, old.attempt);
  } finally { await f.dispose(); }
});
test('concurrent commands serialize and execute at most one outbound creation', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await Promise.all(['a','b'].map(id => f.board.tool(primary, 'vapi-id', id, 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' })));
    await f.acknowledge();
    assert.equal(f.providers.creates, 1);
  } finally { await f.dispose(); }
});
test('busy/no-answer clear only destination and report actual outcomes', async () => {
  for (const status of ['busy','no-answer']) {
    const f = await fixture();
    try {
      await f.utterance('Operator call office');
      await f.board.tool(primary, 'vapi-id', status, 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
      await f.acknowledge();
      const d = (await f.store.get(primary))?.destination; assert.ok(d);
      f.providers.calls.set(destination, status);
      await f.board.leg(primary, d.attempt, 'destination', destination, status);
      await f.board.reconcile();
      assert.equal((await f.store.get(primary))?.destination, null);
      assert.ok(f.providers.spoken.includes(status === 'busy' ? 'The line is busy.' : 'No answer.'));
      assert.ok(!f.providers.ended.includes(primary));
    } finally { await f.dispose(); }
  }
});
test('hold failure keeps commands closed and worker retries isolation', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge(); f.providers.calls.set(destination, 'in-progress'); f.providers.holdFails = true;
    await assert.rejects(f.board.privateMode(primary));
    assert.equal((await f.store.get(primary))?.commandMode, 'arming');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'unsafe', 'manage_outbound_call', { action: 'hangup', utterance: 'Operator hang up' }), { error: 'Say Operator for private commands.' });
    f.providers.holdFails = false; await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
  } finally { await f.dispose(); }
});
test('goodbye requires a real explicit transcript; interrupted ack has persisted cleanup timer', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator goodbye');
    await f.board.tool(primary, 'vapi-id', 'ordinary', 'end_operator_session', { utterance: 'Operator goodbye' });
    assert.equal(f.providers.closed, false);
    await f.acknowledge(); await f.utterance('Operator, end session');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'explicit', 'end_operator_session', { utterance: 'Operator, end session' }), { result: 'End your entire session?' });
    assert.deepEqual(await f.confirm(), { result: 'Goodbye.' });
    assert.equal((await f.store.get(primary))?.phase, 'ending');
    await f.store.locked(primary, async s => { s.commandDeadline = Date.now() - 1; });
    await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.ok(f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});
test('operator rollover and natural caller disconnect preserve cleanup semantics', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { if (s.operator) s.operator.createdAt = Date.now() - 43_100_000; });
    await f.board.reconcile();
    assert.equal(f.providers.operatorCreates, 1);
    assert.deepEqual(f.providers.ended, [operator]);
    assert.equal((await f.store.get(primary))?.operator?.vapiCallId, null);
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'retired', 'manage_outbound_call', { action: 'hangup', utterance: 'Operator hang up' }), { error: 'Operator session expired.' });
    f.providers.calls.set(primary, 'completed'); await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.ok(!f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});
test('persisted command timeout resumes destination after restart without an acknowledgement', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    const d = (await f.store.get(primary))?.destination; assert.ok(d);
    f.providers.calls.set(destination, 'in-progress');
    await f.board.leg(primary, d.attempt, 'destination', destination, 'in-progress');
    await f.board.privateMode(primary); await f.board.joined(primary, conference);
    await f.store.locked(primary, async s => { s.commandDeadline = Date.now() - 1; });
    await new Switchboard(new Store(f.db), f.providers, log).expireWindows();
    assert.equal((await f.store.get(primary))?.commandMode, 'closed');
    assert.equal(f.providers.holds.at(-1)?.held, false);
    assert.equal(f.providers.ended.length, 0);
  } finally { await f.dispose(); }
});
test('a crash leaving an unfinished dedup record never replays the side effect', async () => {
  const f = await fixture();
  try {
    const name = 'manage_outbound_call';
    const input = { action: 'dial', label: 'office', utterance: 'Operator call office' };
    const fingerprint = createHash('sha256').update(JSON.stringify({ name, input })).digest('hex');
    await f.store.beginResult('vapi-id', 'interrupted', fingerprint);
    await f.utterance(input.utterance);
    const fresh = new Switchboard(new Store(f.db), f.providers, log);
    assert.deepEqual(await fresh.tool(primary, 'vapi-id', 'interrupted', name, input), { error: 'Call status is uncertain. Please wait.' });
    assert.equal(f.providers.creates, 0);
  } finally { await f.dispose(); }
});
