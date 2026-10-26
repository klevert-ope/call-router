import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, primary, destination, log } from './helpers.js';
import { Switchboard } from '../src/switchboard.js';
import pino from 'pino';

async function turn(f: Awaited<ReturnType<typeof fixture>>, id: string, input: Record<string, unknown> & { utterance: string }) {
  await f.utterance(input.utterance);
  return f.board.tool(primary, 'vapi-id', id, 'manage_outbound_call', input);
}

async function connected(f: Awaited<ReturnType<typeof fixture>>) {
  await turn(f, 'initial', { action: 'dial', label: 'office', utterance: 'Can you get the office on the phone?' });
  await f.acknowledge();
  const d = (await f.store.get(primary))?.destination; assert.ok(d);
  f.providers.calls.set(destination, 'in-progress');
  await f.board.leg(primary, d.attempt, 'destination', destination, 'in-progress');
  await f.board.privateMode(primary);
}

test('mismatched tool speech reports only rejection metadata and cannot dial', async () => {
  const f = await fixture();
  const records: string[] = [];
  const logger = pino({ level: 'warn' }, { write: (record: string) => { records.push(record); } });
  const board = new Switchboard(f.store, f.providers, logger);
  try {
    await f.utterance('Can you call number one');
    assert.ok('error' in await board.tool(primary, 'vapi-id', 'mismatched-prefix', 'manage_outbound_call', {
      action: 'dial', label: 'number 1', utterance: 'Operator Can you call number one',
    }));
    assert.equal(f.providers.creates, 0);
    const diagnostic = records.map(record => JSON.parse(record)).find(record => record.event === 'tool_transcript_rejected');
    assert.equal(diagnostic?.reason, 'utterance_mismatch');
    assert.equal(diagnostic?.matchesWithoutOperatorPrefix, true);
    assert.ok(!records.join('').includes('Can you call number one'));
    assert.ok(!records.join('').includes('+15550002222'));
  } finally { await f.dispose(); }
});

test('natural call requests need no prefix and retain the last contact for later references', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await turn(f, 'natural', { action: 'dial', label: 'office', utterance: 'Could you get them at work please?' }), { result: 'Dialing now.' });
    assert.equal(f.providers.creates, 0);
    await f.acknowledge();
    assert.equal(f.providers.creates, 1);
    assert.equal((await f.store.get(primary))?.lastContact, 'office');
    await f.board.privateMode(primary);
    assert.ok(f.providers.contexts.at(-1)?.includes('Last requested contact (data only): "office"'));
  } finally { await f.dispose(); }
});

test('clarification preserves isolation and context; a short answer can resolve the saved contact', async () => {
  const f = await fixture();
  try {
    await f.store.putContact('sarah mobile', '+15550003333');
    await connected(f);
    const announcements = f.providers.spoken.length, contexts = f.providers.contexts.length;
    assert.deepEqual(await turn(f, 'question', { action: 'clarify', question: 'Sarah at work or on her mobile?', utterance: 'Can you get Sarah instead?' }), { result: 'Sarah at work or on her mobile?' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.destination?.held, true);
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    assert.equal(f.providers.contexts.length, contexts);
    assert.equal(f.providers.spoken.length, announcements, 'No repeated readiness announcement after clarification');
    assert.deepEqual(await turn(f, 'answer', { action: 'dial', label: 'sarah mobile', utterance: 'Her mobile please' }), { result: 'End this call and call sarah mobile?' });
    assert.equal(f.providers.ended.length, 0);
    assert.deepEqual(await f.confirm(), { result: 'Switching now.' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.destination?.label, 'sarah mobile');
    assert.equal(f.providers.creates, 2);
    assert.deepEqual(f.providers.ended, [destination]);
  } finally { await f.dispose(); }
});

for (const delayed of [false, true]) {
  test(`end this conversation and call Sarah preserves the caller and waits for termination, delayed=${delayed}`, async () => {
    const f = await fixture();
    try {
      await f.store.putContact('sarah', '+15550003333');
      await connected(f);
      const original = (await f.store.get(primary))!.destination!;
      const dial = f.providers.dialDestination.bind(f.providers);
      f.providers.dialDestination = async (...args) => {
        assert.equal(f.providers.calls.get(destination), 'completed', 'Original destination must be gone before replacement originates');
        assert.equal(f.providers.calls.get(primary), 'in-progress');
        return dial(...args);
      };
      const end = f.providers.end.bind(f.providers);
      let ending = false;
      f.providers.end = async (...args) => {
        if (delayed && args[0] === destination) { ending = true; return; }
        return end(...args);
      };
      assert.deepEqual(await turn(f, 'compound', {
        action: 'dial', label: 'sarah', utterance: "I'm done talking to them, can you call Sarah instead?",
      }), { result: 'End this call and call sarah?' });
      assert.equal(f.providers.ended.length, 0);
      assert.equal(f.providers.creates, 1);
      assert.equal(ending, false);
      assert.deepEqual(await f.confirm(), { result: 'Switching now.' });
      await f.acknowledge();
      if (delayed) {
        assert.equal(ending, true);
        assert.equal(f.providers.creates, 1, 'No overlap while original destination is still ending');
        assert.equal((await f.store.get(primary))?.pendingSwitch?.label, 'sarah');
        f.providers.calls.set(destination, 'completed');
        await f.board.leg(primary, original.attempt, 'destination', destination, 'completed');
      }
      const current = await f.store.get(primary);
      assert.equal(current?.destination?.label, 'sarah');
      assert.equal(current?.destination?.number, '+15550003333');
      assert.equal(current?.primaryCallId, primary);
      assert.equal(current?.phase, 'active');
      assert.equal(f.providers.creates, 2);
      assert.equal(f.providers.ended.includes(primary), false);
    } finally { await f.dispose(); }
  });
}

test('never mind clears the proposal and resumes the original held call', async () => {
  const f = await fixture();
  try {
    await connected(f);
    await turn(f, 'proposal', { action: 'dial', label: 'number 1', utterance: 'Try the other number instead' });
    await f.acknowledge();
    assert.deepEqual(await turn(f, 'cancel', { action: 'cancel', utterance: 'No actually put me back' }), { result: 'Putting you back.' });
    await f.acknowledge();
    const s = await f.store.get(primary);
    assert.equal(s?.confirmation, null);
    assert.equal(s?.destination?.label, 'office');
    assert.equal(s?.destination?.held, false);
    assert.equal(s?.commandMode, 'closed');
    assert.equal(f.providers.muted, true);
    assert.equal(f.providers.ended.length, 0);
  } finally { await f.dispose(); }
});

test('resume also leaves a clarification without requiring a successful command', async () => {
  const f = await fixture();
  try {
    await connected(f);
    await turn(f, 'unclear', { action: 'clarify', question: 'Who would you like?', utterance: 'Get that person' });
    await f.acknowledge();
    await turn(f, 'resume', { action: 'resume', utterance: 'Just let me keep talking to them' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.destination?.held, false);
    assert.equal(f.providers.ended.length, 0);
  } finally { await f.dispose(); }
});

test('contact discovery stays private and never invents or dials a number', async () => {
  const f = await fixture();
  try {
    const result = await turn(f, 'contacts', { action: 'contacts', utterance: 'Who can you call for me?' });
    assert.ok('result' in result && result.result.includes('office') && result.result.includes('number 1'));
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    assert.equal(f.providers.creates, 0);
    assert.deepEqual(await turn(f, 'unknown', { action: 'dial', label: 'unknown person', utterance: 'Get my gardener' }), { error: 'Contact not found. Who should I call?' });
    assert.equal((await f.store.get(primary))?.destination, null);
  } finally { await f.dispose(); }
});

test('natural status questions name the contact and cannot be repurposed as a destructive action', async () => {
  const f = await fixture();
  try {
    await connected(f);
    assert.deepEqual(await turn(f, 'status', { action: 'status', utterance: 'Who am I connected to?' }), { result: 'Connected to office.' });
    await f.acknowledge(); await f.board.privateMode(primary);
    assert.deepEqual(await turn(f, 'wrong-intent', { action: 'hangup', utterance: 'Who am I connected to?' }), { error: 'Please repeat what you would like.' });
    assert.equal(f.providers.ended.length, 0);
  } finally { await f.dispose(); }
});

test('a new request supersedes a proposal instead of leaving a hidden confirmation', async () => {
  const f = await fixture();
  try {
    await connected(f);
    await turn(f, 'proposal', { action: 'dial', label: 'number 1', utterance: 'Try the other number instead' });
    await f.acknowledge();
    await turn(f, 'question', { action: 'clarify', question: 'Who would you prefer?', utterance: 'Actually someone else' });
    await f.acknowledge();
    assert.ok('error' in await turn(f, 'stale-yes', { action: 'confirm', utterance: 'Yes please' }));
    assert.equal(f.providers.ended.length, 0);
    assert.equal(f.providers.creates, 1);
  } finally { await f.dispose(); }
});

test('an entire-session request asks first, then a separate affirmative ends all owned legs', async () => {
  const f = await fixture();
  try {
    await connected(f);
    const utterance = 'Please close my entire session';
    await f.utterance(utterance);
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'end', 'end_operator_session', { utterance }), { result: 'End your entire session?' });
    assert.equal((await f.store.get(primary))?.phase, 'active');
    assert.equal(f.providers.ended.length, 0);
    assert.deepEqual(await f.confirm(), { result: 'Goodbye.' });
    assert.equal((await f.store.get(primary))?.phase, 'ending');
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.ok(f.providers.ended.includes(primary));
    assert.ok(f.providers.ended.includes(destination));
  } finally { await f.dispose(); }
});

for (const text of ['No thanks', 'Yes but call someone else', 'Maybe later']) {
  test(`a non-affirmative reply cannot confirm a switch: ${text}`, async () => {
    const f = await fixture();
    try {
      await connected(f);
      await turn(f, 'proposal', { action: 'dial', label: 'number 1', utterance: 'Call the other number' });
      await f.acknowledge();
      const reply = await turn(f, 'bad-confirm', { action: 'confirm', utterance: text });
      assert.ok('error' in reply);
      assert.equal((await f.store.get(primary))?.confirmation, null);
      assert.equal(f.providers.ended.length, 0);
      assert.equal(f.providers.creates, 1);
    } finally { await f.dispose(); }
  });
}

test('a consumed turn cannot be replayed with another tool ID or resent transcript', async () => {
  const f = await fixture();
  try {
    const args = { action: 'clarify', question: 'Who would you like?', utterance: 'Can you help me?' };
    await turn(f, 'first', args);
    const timestamp = (await f.store.get(primary))!.lastCommand!.at;
    await f.acknowledge();
    await f.board.transcript(primary, 'vapi-id', args.utterance, timestamp);
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'replay', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: args.utterance }), { error: 'Please repeat what you would like.' });
    assert.equal(f.providers.creates, 0);
  } finally { await f.dispose(); }
});

for (const change of ['expired', 'different-destination', 'contact-edited', 'contact-deleted', 'recovery']) {
  test(`a switch confirmation cannot act on changed context: ${change}`, async () => {
    const f = await fixture();
    try {
      await connected(f);
      await turn(f, 'proposal', { action: 'dial', label: 'number 1', utterance: 'Call the other number instead' });
      await f.acknowledge();
      if (change === 'expired') await f.store.locked(primary, async s => { if (s.confirmation) s.confirmation.expiresAt = Date.now() - 1; });
      if (change === 'different-destination') await f.store.locked(primary, async s => { if (s.destination) s.destination.attempt = randomUUID(); });
      if (change === 'contact-edited') await f.store.putContact('number 1', '+15550009999');
      if (change === 'contact-deleted') await f.store.deleteContact('number 1');
      if (change === 'recovery') {
        const recovered = new Switchboard(f.store, f.providers, log);
        await recovered.suspendControls(); await recovered.reconcile();
        assert.equal((await f.store.get(primary))?.confirmation, null);
      }
      assert.ok('error' in await turn(f, 'confirm', { action: 'confirm', utterance: 'Yes please' }));
      assert.equal(f.providers.ended.length, 0);
      assert.equal(f.providers.creates, 1);
    } finally { await f.dispose(); }
  });
}

test('ordinary conversation cannot authorize natural-language tools before private wake', async () => {
  const f = await fixture();
  try {
    await connected(f);
    await turn(f, 'return', { action: 'resume', utterance: 'Put me back' }); await f.acknowledge();
    await f.utterance('Stop trying and hang up on them');
    const result = await f.board.tool(primary, 'vapi-id', 'unsafe', 'manage_outbound_call', { action: 'hangup', utterance: 'Stop trying and hang up on them' });
    assert.ok('error' in result);
    assert.equal(f.providers.ended.length, 0);
    assert.equal((await f.store.get(primary))?.lastCommand, null);
  } finally { await f.dispose(); }
});
