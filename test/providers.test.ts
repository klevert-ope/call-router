import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpProviders, ProviderError } from '../src/providers.js';
import { config, primary, destination, conference, log } from './helpers.js';
import { Switchboard } from '../src/switchboard.js';
import { Store } from '../src/store.js';
import { Database } from '../src/database.js';
import { randomUUID } from 'node:crypto';

test('Telnyx dial uses deterministic ID, personal caller ID and 30-second timeout', async () => {
  const db = new Database(':memory:');
  const attempt = randomUUID(), label = `destination-${attempt}`;
  let requests = 0;
  const providers = new HttpProviders(config, async (url, init) => {
    requests++;
    const u = new URL(String(url));
    assert.equal(u.origin + u.pathname, `${config.ASTERISK_URL}/channels`);
    assert.equal(u.searchParams.get('channelId'), label);
    assert.equal(u.searchParams.get('endpoint'), 'PJSIP/+15550001111@telnyx-out');
    assert.equal(u.searchParams.get('callerId'), `<${config.BOSS_PERSONAL_NUMBER}>`);
    assert.equal(u.searchParams.get('timeout'), '30');
    assert.equal(u.searchParams.get('appArgs'), `destination,${primary},${attempt}`);
    assert.equal(init?.method, 'POST');
    assert.ok(init?.signal);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from(`${config.ASTERISK_USERNAME}:${config.ASTERISK_PASSWORD}`).toString('base64')}`);
    return Response.json({ id: label, state: 'Down' });
  });
  try {
    const s = new Switchboard(new Store(db), providers, log).newSession(primary); s.conferenceId = conference;
    assert.equal(await providers.dialDestination(s, { attempt, participantLabel: label, label: 'office', number: '+15550001111', callId: null, state: 'creating', createdAt: Date.now(), held: true }), label);
    assert.equal(requests, 1);
  } finally { await db.close(); }
});

test('primary protection and absent-channel termination are idempotent', async () => {
  let requests = 0;
  const providers = new HttpProviders(config, async () => { requests++; return new Response('{}', { status: 404 }); });
  await assert.rejects(providers.end(primary, primary), /Primary leg protected/);
  assert.equal(requests, 0);
  await providers.end(destination, primary);
  assert.equal((await providers.call(destination)).status, 'completed');
});

test('an explicit outbound caller ID overrides the personal default', async () => {
  const callerId = '+15551234567';
  const id = `destination-${randomUUID()}`;
  const providers = new HttpProviders({ ...config, OUTBOUND_CALLER_ID: callerId }, async (url) => {
    assert.equal(new URL(String(url)).searchParams.get('callerId'), `<${callerId}>`);
    return Response.json({ id, state: 'Down' });
  });
  const db = new Database(':memory:');
  try {
    const s = new Switchboard(new Store(db), providers, log).newSession(primary);
    await providers.dialDestination(s, { attempt: randomUUID(), participantLabel: id, label: 'office', number: '+15550001111', callId: null, state: 'creating', createdAt: Date.now(), held: true });
  } finally { db.close(); }
});

test('private hold verifies destination membership and fails if isolation is unconfirmed', async () => {
  const memberships = new Map<string, string[]>([[conference, [primary, destination]]]);
  const providers = new HttpProviders(config, async (value, init) => {
    const u = new URL(String(value)), parts = u.pathname.split('/');
    const id = decodeURIComponent(parts[3] ?? '');
    if (init?.method === 'POST' && !parts[4]) { memberships.set(id, memberships.get(id) ?? []); return Response.json({}); }
    if (parts[4] === 'removeChannel') { memberships.set(id, (memberships.get(id) ?? []).filter(c => c !== destination)); return new Response(null, { status: 204 }); }
    if (parts[4] === 'addChannel') { memberships.set(id, [...(memberships.get(id) ?? []), destination]); return new Response(null, { status: 204 }); }
    return Response.json({ id, channels: memberships.get(id) ?? [] });
  });
  await providers.hold(conference, destination, true, primary);
  assert.deepEqual(memberships.get(conference), [primary]);
  assert.deepEqual(memberships.get(`${conference}-hold`), [destination]);
  await providers.hold(conference, destination, false, primary);
  assert.deepEqual(memberships.get(conference), [primary, destination]);
  const broken = new HttpProviders(config, async () => Response.json({ id: conference, channels: [] }));
  await assert.rejects(broken.hold(conference, destination, true, primary), /membership unverified/);
});

test('operator snoop listens only to caller ingress and whispers only to caller egress', async () => {
  const snoop = 'operator-test-snoop';
  const mutations: URL[] = [];
  let snoopExists = false;
  const providers = new HttpProviders(config, async (value, init) => {
    const u = new URL(String(value));
    if (init?.method === 'POST') mutations.push(u);
    if (u.pathname.includes('/snoop/')) { snoopExists = true; return Response.json({ id: snoop, state: 'Up' }); }
    if (u.pathname === `/ari/channels/${snoop}`) return snoopExists ? Response.json({ id: snoop, state: 'Up' }) : new Response('{}', { status: 404 });
    if (u.pathname === '/ari/channels/operator-test') return Response.json({ id: 'operator-test', state: 'Up' });
    return Response.json({ id: 'operator-test-audio', channels: [snoop, 'operator-test'] });
  });
  await providers.coach(conference, 'operator-test', primary);
  const setup = mutations.find(u => u.pathname.includes('/snoop/'));
  assert.equal(setup?.searchParams.get('spy'), 'in');
  assert.equal(setup?.searchParams.get('whisper'), 'out');
  assert.ok(mutations.every(u => !u.pathname.includes(`/bridges/${conference}/addChannel`)));
});

test('Vapi private/public bearer keys are separated and control redirects/hosts rejected', async () => {
  const keys: string[] = [];
  const providers = new HttpProviders(config, async (url, init) => {
    keys.push(new Headers(init?.headers).get('Authorization') ?? '');
    if (String(url).startsWith('https://api.vapi.ai/call/')) return Response.json({ id: 'vapi-id', assistantId: config.VAPI_ASSISTANT_ID, customer: { number: 'a'.repeat(64) } });
    return new Response('ok');
  });
  await providers.vapiCall('vapi-id');
  await providers.say('https://live.vapi.ai/id/control', 'Connected.');
  assert.deepEqual(keys, ['Bearer private-key','Bearer public-key']);
  for (const url of ['https://attacker.test/control','http://live.vapi.ai/control','https://user:pass@live.vapi.ai/control','https://live.vapi.ai:444/control']) await assert.rejects(providers.say(url, 'Connected.'));
  assert.throws(() => providers.say('https://live.vapi.ai/id/control', 'one two three four five six seven eight'));
  assert.equal(keys.length, 2);
});
test('network failures and server errors are ambiguous; rejected requests are definitive', async () => {
  for (const status of [400,429,500]) {
    const p = new HttpProviders(config, async () => new Response('{}', { status }));
    await assert.rejects(p.call(primary), e => e instanceof ProviderError && e.ambiguous === (status === 500));
  }
  const p = new HttpProviders(config, async () => { throw new Error('Secret upstream URL'); });
  await assert.rejects(p.call(primary), e => e instanceof ProviderError && e.ambiguous && !e.message.includes('Secret'));
});
test('control and error responses release their response streams', async () => {
  for (const status of [200, 400, 429, 500]) {
    let canceled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
      cancel() { canceled = true; },
    });
    const providers = new HttpProviders(config, async () => new Response(stream, { status }));
    if (status === 200) await providers.say('https://live.vapi.ai/id/control', 'Hello.');
    else await assert.rejects(providers.call(primary), ProviderError);
    assert.equal(canceled, true);
  }
});
