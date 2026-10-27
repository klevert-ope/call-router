import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, primary, destination, conference, config } from './helpers.js';
import { HttpProviders } from '../src/providers.js';

test('ringback starts after the acknowledgement and stops before private speech and answer', async () => {
  const f = await fixture();
  try {
    await f.utterance('Please call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Please call office' });
    assert.equal(f.providers.ringing, false);
    await f.acknowledge();
    assert.equal(f.providers.ringing, true);
    await f.board.privateMode(primary);
    assert.equal(f.providers.ringing, false);
    assert.equal(f.providers.spoken.at(-1), 'Operator ready.');
    const d = (await f.store.get(primary))!.destination!;
    f.providers.calls.set(destination, 'in-progress');
    await f.board.leg(primary, d.attempt, 'destination', destination, 'in-progress');
    assert.equal(f.providers.ringing, false);
    assert.equal(f.providers.holds.at(-1)?.held, true);
    await f.utterance('Put me back');
    await f.board.tool(primary, 'vapi-id', 'resume', 'manage_outbound_call', { action: 'resume', utterance: 'Put me back' });
    await f.acknowledge();
    assert.equal(f.providers.ringing, false);
    assert.equal(f.providers.holds.at(-1)?.held, false);
  } finally { await f.dispose(); }
});

test('ringback resumes after a canceled private request while a destination still rings', async () => {
  const f = await fixture();
  try {
    await f.utterance('Call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Call office' });
    await f.acknowledge();
    await f.board.privateMode(primary);
    await f.utterance('Never mind');
    await f.board.tool(primary, 'vapi-id', 'cancel', 'manage_outbound_call', { action: 'cancel', utterance: 'Never mind' });
    await f.acknowledge();
    await f.board.reconcile();
    assert.equal(f.providers.ringing, true);
    const d = (await f.store.get(primary))!.destination!;
    f.providers.calls.set(destination, 'completed');
    await f.board.leg(primary, d.attempt, 'destination', destination, 'no-answer');
    assert.equal(f.providers.ringing, false);
    assert.ok(f.providers.spoken.includes('No answer.'));
  } finally { await f.dispose(); }
});

test('ringback reconciles a lost playback response without creating a second tone', async () => {
  const requests: string[] = [];
  const id = `${conference}-ringback`;
  let playing = false, failResponse = true;
  const providers = new HttpProviders(config, async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === `/ari/playbacks/${id}`) {
      if (method === 'DELETE') { playing = false; return new Response(null, { status: 204 }); }
      return playing ? Response.json({ id, state: 'playing' }) : new Response('{}', { status: 404 });
    }
    if (url.pathname === `/ari/bridges/${conference}`) return Response.json({ id: conference, channels: [primary] });
    if (url.pathname.includes('/play/')) {
      assert.equal(url.searchParams.get('media'), 'tone:ring;tonezone=us');
      playing = true;
      if (failResponse) { failResponse = false; throw new Error('Response lost'); }
      return Response.json({ id, state: 'playing' });
    }
    return new Response(null, { status: 204 });
  });
  await assert.rejects(providers.ringback(conference, primary, true));
  await providers.ringback(conference, primary, true);
  assert.equal(requests.filter(value => value.includes('/play/')).length, 1);
  const start = requests.indexOf(`POST /ari/bridges/${conference}/play/${id}`);
  assert.ok(requests.indexOf(`DELETE /ari/channels/${encodeURIComponent(primary)}/silence`) < start);
  await providers.ringback(conference, primary, false);
  assert.equal(playing, false);
  assert.equal(requests.at(-1), `POST /ari/channels/${encodeURIComponent(primary)}/silence`);
});

test('ringback cannot start on a bridge shared with the destination', async () => {
  const requests: string[] = [];
  const providers = new HttpProviders(config, async (value, init) => {
    const path = new URL(String(value)).pathname;
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.includes('/playbacks/')) return new Response('{}', { status: 404 });
    return Response.json({ id: conference, channels: [primary, destination] });
  });
  await assert.rejects(providers.ringback(conference, primary, true), /caller-only/);
  assert.ok(requests.every(value => value.startsWith('GET')));
});
