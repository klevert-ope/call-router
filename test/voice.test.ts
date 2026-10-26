import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenPin, wakeWord } from '../src/domain.js';
import { fixture, config, primary, destination, conference } from './helpers.js';
import { migrate } from '../src/migrate.js';
import { randomUUID } from 'node:crypto';

async function pendingAuthentication() {
  const f = await fixture();
  await f.store.locked(primary, async s => {
    s.authentication = { state: 'pending', attempts: 0, deadline: Date.now() + 60_000, lastTranscriptAt: 0, promptedGeneration: null };
    s.commandMode = 'arming';
  });
  await f.board.joined(primary, conference);
  return f;
}

test('the first natural call request after PIN readiness needs no Operator prefix', async () => {
  const f = await pendingAuthentication();
  try {
    await f.board.transcript(primary, 'vapi-id', config.OPERATOR_PIN, Date.now() + 1);
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
    assert.equal(f.providers.spoken.at(-1), 'Operator ready.');
    await f.utterance('Can you call number one');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'natural-after-pin', 'manage_outbound_call', {
      action: 'dial', label: 'number 1', utterance: 'Can you call number one',
    }), { result: 'Dialing now.' });
    await f.acknowledge();
    assert.equal(f.providers.creates, 1);
    assert.equal((await f.store.get(primary))?.destination?.label, 'number 1');
  } finally { await f.dispose(); }
});

test('digit-by-digit PIN transcripts form one attempt without persisting fragments', async () => {
  const f = await pendingAuthentication();
  try {
    const at = Date.now() + 10;
    for (const [index, digit] of ['zero', 'four', 'two'].entries()) {
      await f.board.transcript(primary, 'vapi-id', digit, at + index * 100);
      await f.board.transcript(primary, 'vapi-id', digit, at + index * 100);
      const auth = (await f.store.get(primary))?.authentication;
      assert.ok(auth?.state === 'pending' && auth.attempts === 0);
    }
    assert.deepEqual(f.providers.spoken, ['Please speak your four digit PIN.']);
    const rows = f.db.query('SELECT data AS stored_json FROM sessions WHERE primary_call_id=$1', [primary]);
    assert.ok(!['zero', 'four', 'two'].some(word => String(rows.rows[0]?.stored_json).includes(word)));
    await f.board.transcript(primary, 'vapi-id', 'seven', at + 300);
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
  } finally { await f.dispose(); }
});

test('a complete PIN starts a new attempt after partial digits, with failures counted once', async () => {
  const f = await pendingAuthentication();
  try {
    const at = Date.now() + 10;
    await f.board.transcript(primary, 'vapi-id', 'zero', at);
    await f.board.transcript(primary, 'vapi-id', '9999', at + 1);
    const auth = (await f.store.get(primary))?.authentication;
    assert.ok(auth?.state === 'pending' && auth.attempts === 1);
    await f.board.transcript(primary, 'vapi-id', 'zero four', at + 2);
    await f.board.transcript(primary, 'vapi-id', 'two seven', at + 3);
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
  } finally { await f.dispose(); }
});

test('PIN fragments do not cross operator generations or long pauses', async () => {
  for (const reset of ['generation', 'pause']) {
    const f = await pendingAuthentication();
    try {
      await f.store.locked(primary, async s => { if (s.authentication.state === 'pending') s.authentication.lastTranscriptAt = 0; });
      const at = Date.now() - 8000;
      await f.board.transcript(primary, 'vapi-id', 'zero', at);
      if (reset === 'generation') await f.store.locked(primary, async s => { if (s.operator) s.operator.generation = randomUUID(); });
      await f.board.transcript(primary, 'vapi-id', 'four two seven', reset === 'pause' ? at + 7000 : at + 1);
      assert.equal((await f.store.get(primary))?.authentication.state, 'pending');
      await f.board.transcript(primary, 'vapi-id', '0427', Date.now() + 1);
      assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
    } finally { await f.dispose(); }
  }
});


test('spoken PIN preserves leading zeros and rejects inferred or extra digits', () => {
  for (const phrase of ['0427', '0 4 2 7', 'zero four two seven', 'oh, four, two, seven.', '04:27', '0-4-2-7']) assert.equal(spokenPin(phrase), '0427');
  for (const phrase of ['four hundred twenty seven', 'my PIN is 0427', '04270', 'four two seven', 'call office', 'zero four two seven please']) assert.equal(spokenPin(phrase), undefined);
  assert.equal(wakeWord('Operator!'), true);
  for (const phrase of ['Operator call office', 'the operator', 'Operator please']) assert.equal(wakeWord(phrase), false);
});

test('spoken authentication rejects tools, deduplicates retries and never stores PIN text', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => {
      s.authentication = { state: 'pending', attempts: 0, deadline: Date.now() + 60_000, lastTranscriptAt: 0, promptedGeneration: null };
      s.commandMode = 'arming';
    });
    await f.board.joined(primary, conference);
    assert.equal(f.providers.spoken.at(-1), 'Please speak your four digit PIN.');
    const tool = await f.board.tool(primary, 'vapi-id', 'before-auth', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    assert.ok('error' in tool);
    const timestamp = Date.now() + 10;
    await f.board.transcript(primary, 'vapi-id', 'one two three four', timestamp);
    await f.board.transcript(primary, 'vapi-id', 'one two three four', timestamp);
    const auth = (await f.store.get(primary))?.authentication;
    assert.ok(auth?.state === 'pending' && auth.attempts === 1);
    await f.board.transcript(primary, 'vapi-id', 'zero four two seven', Math.max(Date.now(), timestamp + 1, auth.lastTranscriptAt + 1));
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    const rows = await f.db.query('SELECT data AS stored_json FROM sessions WHERE primary_call_id=$1', [primary]);
    const stored = rows.rows[0]?.stored_json;
    assert.equal(typeof stored, 'string');
    assert.ok(typeof stored === 'string' && !stored.includes('zero four two seven') && !stored.includes(config.OPERATOR_PIN));
    assert.equal(f.providers.creates, 0);
  } finally { await f.dispose(); }
});

test('five bad spoken PINs or authentication timeout disconnect the entire session', async () => {
  for (const timeout of [false, true]) {
    const f = await fixture();
    try {
      await f.store.locked(primary, async s => {
        s.authentication = { state: 'pending', attempts: 0, deadline: Date.now() + (timeout ? -1 : 60_000), lastTranscriptAt: 0, promptedGeneration: s.operator?.generation ?? null };
        s.commandMode = 'arming'; s.commandDeadline = Date.now() - 1;
      });
      if (timeout) await f.board.expireWindows();
      else for (let i = 0; i < 5; i++) await f.board.transcript(primary, 'vapi-id', 'nine nine nine nine', Date.now() + i + 1);
      assert.equal((await f.store.get(primary))?.phase, 'ended');
      assert.ok(f.providers.ended.includes(primary));
      assert.equal(f.providers.creates, 0);
    } finally { await f.dispose(); }
  }
});

test('a mispronounced PIN gets a clear retry and the fifth attempt can still authenticate', async () => {
  const f = await pendingAuthentication();
  try {
    for (let i = 0; i < 4; i++) await f.board.transcript(primary, 'vapi-id', 'zero fork two seven', Date.now() + i + 1);
    assert.equal(f.providers.spoken.at(-1), 'Please retry. Speak each PIN digit.');
    assert.equal((await f.store.get(primary))?.phase, 'active');
    await f.board.transcript(primary, 'vapi-id', 'zero four two seven', Date.now() + 10);
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
    assert.equal(f.providers.spoken.at(-1), 'Operator ready.');
  } finally { await f.dispose(); }
});

test('a failed PIN retry announcement recovers and never counts a replay twice', async () => {
  const f = await pendingAuthentication();
  try {
    const say = f.providers.say.bind(f.providers); let rejectOnce = true;
    f.providers.say = async (...args) => {
      if (rejectOnce) { rejectOnce = false; throw new Error('Retry announcement lost'); }
      return say(...args);
    };
    const timestamp = Date.now() + 10;
    await assert.rejects(f.board.transcript(primary, 'vapi-id', 'zero fork two seven', timestamp));
    await f.store.locked(primary, async s => { if (s.announcement) s.announcement.retryAt = 0; });
    await f.board.reconcile();
    assert.equal(f.providers.spoken.at(-1), 'Please retry. Speak each PIN digit.');
    await f.board.transcript(primary, 'vapi-id', 'zero fork two seven', timestamp);
    const auth = (await f.store.get(primary))?.authentication;
    assert.ok(auth?.state === 'pending' && auth.attempts === 1);
    await f.board.transcript(primary, 'vapi-id', 'zero four two seven', Math.max(Date.now(), timestamp + 1, auth.lastTranscriptAt + 1));
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
  } finally { await f.dispose(); }
});

async function connect(f: Awaited<ReturnType<typeof fixture>>) {
  await f.utterance('Operator call office');
  await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
  await f.acknowledge();
  const s = await f.store.get(primary);
  assert.ok(s?.destination);
  f.providers.calls.set(destination, 'in-progress');
  await f.board.leg(primary, s.destination.attempt, 'destination', destination, 'in-progress');
}

test('a misheard command keeps the connected destination isolated until a corrected retry', async () => {
  const f = await fixture();
  try {
    await connect(f); await f.board.privateMode(primary);
    await f.utterance('Operator switch to ofice');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'misheard-switch', 'manage_outbound_call', {
      action: 'switch', label: 'ofice', utterance: 'Operator switch to ofice',
    }), { error: 'Contact not found. Who should I call?' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    assert.equal((await f.store.get(primary))?.destination?.held, true);
    assert.equal(f.providers.creates, 1); assert.deepEqual(f.providers.ended, []);
    await f.utterance('Operator switch to number one');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'corrected-switch', 'manage_outbound_call', {
      action: 'switch', label: 'number 1', utterance: 'Operator switch to number one',
    }), { result: 'End this call and call number 1?' });
    assert.deepEqual(await f.confirm(), { result: 'Switching now.' });
    await f.acknowledge();
    assert.equal(f.providers.creates, 2);
    assert.equal((await f.store.get(primary))?.destination?.label, 'number 1');
  } finally { await f.dispose(); }
});

test('conversation stays muted after connected announcement and greetings until operator wake', async () => {
  const f = await fixture();
  try {
    await connect(f);
    assert.equal(f.providers.muted, true);
    await f.board.reconcile();
    assert.equal(f.providers.spoken.at(-1), 'Connected.');
    assert.equal(f.providers.muted, false);
    await f.acknowledge();
    assert.equal(f.providers.muted, true);
    assert.ok(f.providers.contexts.at(-1)?.includes('including hello'));
    const count = f.providers.spoken.length;
    await f.board.transcript(primary, 'vapi-id', 'Hello', Date.now() + 10);
    assert.equal(f.providers.spoken.length, count);
    assert.equal((await f.store.get(primary))?.commandMode, 'closed');
    await f.board.transcript(primary, 'vapi-id', 'Operator', Date.now() + 20);
    assert.equal(f.providers.muted, false);
    assert.equal(f.providers.spoken.at(-1), 'Operator ready.');
    assert.equal(f.providers.holds.at(-1)?.held, true);
  } finally { await f.dispose(); }
});

test('connected announcement timeout restores muted conversation', async () => {
  const f = await fixture();
  try {
    await connect(f);
    await f.board.reconcile();
    await f.store.locked(primary, async s => { s.commandDeadline = Date.now() - 1; });
    await f.board.expireWindows();
    assert.equal(f.providers.muted, true);
    assert.equal((await f.store.get(primary))?.ack, null);
    assert.equal((await f.store.get(primary))?.phase, 'active');
  } finally { await f.dispose(); }
});

test('wake word isolates destination before accepting a fresh command; replay cannot reopen', async () => {
  const f = await fixture();
  try {
    await connect(f);
    await f.board.transcript(primary, 'vapi-id', 'Operator hang up on them', Date.now());
    assert.equal((await f.store.get(primary))?.lastCommand, null);
    const wakeAt = Date.now() + 1;
    await f.board.transcript(primary, 'vapi-id', 'Operator', wakeAt);
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    assert.equal(f.providers.holds.at(-1)?.held, true);
    assert.equal(f.providers.spoken.at(-1), 'Operator ready.');
    await f.board.transcript(primary, 'vapi-id', 'Operator status', Date.now() + 2);
    const reply = await f.board.tool(primary, 'vapi-id', 'status', 'manage_outbound_call', { action: 'status', utterance: 'Operator status' });
    assert.deepEqual(reply, { result: 'Connected to office.' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.commandMode, 'closed');
    await f.board.transcript(primary, 'vapi-id', 'Operator', wakeAt);
    await f.board.transcript(primary, 'retired-vapi', 'Operator', Date.now() + 3);
    assert.equal((await f.store.get(primary))?.commandMode, 'closed');
    assert.ok(!f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});

test('voice isolation failure and ARI disconnection never authorize commands', async () => {
  const f = await fixture();
  try {
    await connect(f);
    f.providers.holdFails = true;
    await assert.rejects(f.board.transcript(primary, 'vapi-id', 'Operator', Date.now() + 1));
    assert.equal((await f.store.get(primary))?.commandMode, 'arming');
    const args = { action: 'hangup', utterance: 'Operator hang up on them' };
    await f.utterance(args.utterance);
    assert.ok('error' in await f.board.tool(primary, 'vapi-id', 'isolating', 'manage_outbound_call', args));
    f.providers.holdFails = false;
    await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    f.providers.online = false;
    await f.board.suspendControls();
    await f.utterance(args.utterance);
    assert.ok('error' in await f.board.tool(primary, 'vapi-id', 'offline', 'manage_outbound_call', args));
    assert.equal(f.providers.ended.length, 0);
    f.providers.online = true;
    await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.lastCommand, null);
  } finally { await f.dispose(); }
});

test('Telnyx cutover refuses active DIDWW/Asterisk sessions and preserves archives', async () => {
  const f = await fixture();
  try {
    await f.db.query(`UPDATE sessions SET data=json_set(data,'$.carrier','asterisk') WHERE primary_call_id=$1`, [primary]);
    await assert.rejects(migrate(f.db), /Drain active DIDWW\/Asterisk or legacy sessions/);
    await f.db.query(`UPDATE sessions SET data=json_set(data,'$.phase','ended') WHERE primary_call_id=$1`, [primary]);
    await migrate(f.db); await migrate(f.db);
    assert.equal(await f.store.contact('office'), '+15550001111');
  } finally { await f.dispose(); }
});
