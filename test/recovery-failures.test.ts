import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, primary, destination, operator, config, log } from './helpers.js';
import { Switchboard } from '../src/switchboard.js';
import { HttpProviders, ProviderError } from '../src/providers.js';

test('partial cleanup attempts all legs and persists explicit caller termination through recovery', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => {
      s.destination = { attempt: randomUUID(), participantLabel: destination, label: 'office', number: '+15550001111',
        callId: destination, state: 'connected', createdAt: Date.now(), held: false };
    });
    f.providers.calls.set(destination, 'in-progress');
    const end = f.providers.end.bind(f.providers);
    const attempted: string[] = [];
    f.providers.end = async (id, ...args) => {
      attempted.push(id);
      if (id === primary || id === destination) throw new ProviderError('asterisk', 500, true);
      await end(id, ...args);
    };
    f.providers.endConference = async () => { throw new ProviderError('asterisk', 500, true); };
    await assert.rejects(f.store.locked(primary, (s, save) => f.board.cleanup(s, save, true)), AggregateError);
    assert.deepEqual(new Set(attempted), new Set([primary, destination, operator]));
    assert.equal((await f.store.get(primary))?.phase, 'ending');
    assert.equal((await f.store.get(primary))?.endPrimaryOnCleanup, true);
    f.providers.end = end;
    f.providers.endConference = async () => {};
    const recovered = new Switchboard(f.store, f.providers, log, config.OPERATOR_PIN);
    await recovered.reconcile();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.equal((await f.providers.call(primary)).status, 'completed');
    assert.equal((await f.providers.call(destination)).status, 'completed');
    assert.equal(f.providers.creates, 0);
  } finally { await f.dispose(); }
});

test('an unconfirmed channel termination keeps cleanup pending', async () => {
  const f = await fixture();
  try {
    f.providers.end = async () => {};
    await assert.rejects(f.store.locked(primary, (s, save) => f.board.cleanup(s, save)), AggregateError);
    assert.equal((await f.store.get(primary))?.phase, 'ending');
    assert.ok((await f.store.get(primary))?.operator);
  } finally { await f.dispose(); }
});

test('operator and conference teardown attempt every resource despite individual failures', async () => {
  const id = `operator-${randomUUID()}`;
  const requests: string[] = [];
  const providers = new HttpProviders(config, async (value, init) => {
    const path = new URL(String(value)).pathname;
    requests.push(`${init?.method} ${path}`);
    if (path === `/ari/channels/${id}` || path === '/ari/bridges/main') return new Response('{}', { status: 500 });
    if (init?.method === 'GET') return Response.json({ id: 'main-hold', channels: [] });
    return new Response(null, { status: 204 });
  });
  await assert.rejects(providers.end(id, primary), AggregateError);
  assert.ok(requests.includes(`DELETE /ari/channels/${id}-snoop`));
  assert.ok(requests.includes(`DELETE /ari/bridges/${id}-audio`));
  await assert.rejects(providers.endConference('main'), AggregateError);
  assert.ok(requests.includes('DELETE /ari/bridges/main-hold'));
});

test('lost operator creation is canceled and verified before a fresh generation is allocated', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { s.operator = null; s.commandMode = 'closed'; });
    const sequence: string[] = [];
    f.providers.dialOperator = async (_s, o) => {
      sequence.push(`create:${o.participantLabel}`);
      if (sequence.length === 1) throw new ProviderError('asterisk', 0, true);
      f.providers.calls.set(o.participantLabel, 'in-progress');
      return o.participantLabel;
    };
    const end = f.providers.end.bind(f.providers);
    f.providers.end = async (id, ...args) => { sequence.push(`end:${id}`); await end(id, ...args); };
    await f.board.reconcile();
    const old = (await f.store.get(primary))!.operator!;
    assert.equal(old.state, 'unknown');
    await f.board.reconcile();
    assert.equal(sequence.length, 1, 'An uncertain creation cannot be blindly retried');
    await f.store.locked(primary, async s => { s.operator!.createdAt -= 61_000; });
    const recovered = new Switchboard(f.store, f.providers, log, config.OPERATOR_PIN);
    await recovered.reconcile();
    const replacement = (await f.store.get(primary))!.operator!;
    assert.notEqual(replacement.generation, old.generation);
    assert.equal(sequence[1], `end:${old.participantLabel}`);
    assert.equal(sequence[2], `create:${replacement.participantLabel}`);
    let coached = false;
    f.providers.coach = async () => { coached = true; };
    await recovered.leg(primary, old.generation, 'operator', old.participantLabel, 'in-progress');
    assert.equal((await f.store.get(primary))?.operator?.generation, replacement.generation);
    assert.equal(coached, false, 'Retired events cannot restore their snoop audio');
  } finally { await f.dispose(); }
});

test('failed or unconfirmed operator cancellation blocks replacement', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { s.operator!.carrierCallId = null; s.operator!.createdAt -= 61_000; });
    const old = (await f.store.get(primary))!.operator!;
    f.providers.end = async () => { throw new ProviderError('asterisk', 500, true); };
    await f.board.reconcile();
    assert.equal(f.providers.operatorCreates, 0);
    assert.equal((await f.store.get(primary))?.operator?.state, 'ending');
    f.providers.calls.set(old.participantLabel, 'in-progress');
    f.providers.end = async () => {};
    await f.board.reconcile();
    assert.equal(f.providers.operatorCreates, 0);
    assert.equal((await f.store.get(primary))?.operator?.generation, old.generation);
  } finally { await f.dispose(); }
});

test('a definitive setup error still requires confirmed cancellation of an allocated operator', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { s.operator = null; s.commandMode = 'closed'; });
    let creates = 0;
    f.providers.dialOperator = async (_s, o) => {
      creates++;
      f.providers.calls.set(o.participantLabel, 'in-progress');
      throw new ProviderError('asterisk', 400, false); // Originate succeeded; coaching failed.
    };
    f.providers.end = async () => {}; // Accepted cancellation, but channel remains up.
    await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.operator?.state, 'ending');
    await f.board.reconcile();
    assert.equal(creates, 1);
    assert.equal((await f.store.get(primary))?.operator?.state, 'ending');
  } finally { await f.dispose(); }
});

for (const mode of ['closed', 'arming'] as const) test(`failed call notice survives recovery in ${mode} mode`, async t => {
  const f = await fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    await f.store.locked(primary, async s => { s.commandMode = mode; s.notice = 'The line is busy.'; });
    const say = f.providers.say.bind(f.providers);
    f.providers.say = async () => { throw new ProviderError('vapi-control', 503, true); };
    await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.notice, 'The line is busy.');
    assert.ok((await f.store.get(primary))?.noticeDelivery);
    f.providers.say = say;
    now += 11_000;
    const recovered = new Switchboard(f.store, f.providers, log, config.OPERATOR_PIN);
    await recovered.expireWindows(); await recovered.reconcile();
    assert.ok(f.providers.spoken.includes('The line is busy.'));
    assert.equal((await f.store.get(primary))?.notice, null);
    assert.equal((await f.store.get(primary))?.noticeDelivery, null);
  } finally { await f.dispose(); }
});

test('expired call notices are discarded and never delivered after recovery', async t => {
  const f = await fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    await f.store.locked(primary, async s => { s.commandMode = 'closed'; s.notice = 'Connected.'; });
    f.providers.say = async () => { throw new ProviderError('vapi-control', 503, true); };
    await f.board.reconcile();
    now += 61_000;
    f.providers.say = async (_url, content) => { f.providers.spoken.push(content); };
    await f.board.expireWindows(); await f.board.reconcile();
    assert.ok(!f.providers.spoken.includes('Connected.'));
    assert.equal((await f.store.get(primary))?.notice, null);
  } finally { await f.dispose(); }
});

test('a new dial supersedes an undelivered notice from the previous attempt', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => {
      s.notice = 'The line is busy.';
      s.noticeDelivery = { content: s.notice, retryAt: Date.now() + 3000, expiresAt: Date.now() + 60_000 };
    });
    await f.utterance('Call office');
    await f.board.tool(primary, 'vapi-id', 'new-dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Call office' });
    assert.equal((await f.store.get(primary))?.notice, null);
    assert.equal((await f.store.get(primary))?.noticeDelivery, null);
    await f.acknowledge(); await f.board.reconcile();
    assert.ok(!f.providers.spoken.includes('The line is busy.'));
    assert.equal(f.providers.creates, 1);
  } finally { await f.dispose(); }
});
