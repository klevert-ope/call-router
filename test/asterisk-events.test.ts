import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { fixture, config, log } from './helpers.js';
import { HttpProviders } from '../src/providers.js';
import { Switchboard } from '../src/switchboard.js';
import { AsteriskEvents } from '../src/asterisk.js';

test('ARI events authenticate, recover inbound calls, reject callers, map busy and reconnect', { timeout: 20_000 }, async () => {
  const f = await fixture();
  await f.db.query('DELETE FROM sessions');
  const server = createServer();
  const sockets = new WebSocketServer({ server, verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.authorization === `Basic ${Buffer.from(`${config.ASTERISK_USERNAME}:${config.ASTERISK_PASSWORD}`).toString('base64')}` });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const cfg = { ...config, ASTERISK_URL: `http://127.0.0.1:${address.port}/ari` };
  type Channel = { id: string; state: string; caller?: { number: string }; dialplan?: { context: string; exten: string } };
  const primary = '1729330000.1';
  const channels = new Map<string, Channel>([[primary, { id: primary, state: 'Up', caller: { number: config.BOSS_PERSONAL_NUMBER }, dialplan: { context: 'from-telnyx', exten: config.TELNYX_FROM_NUMBER } }]]);
  const bridges = new Map<string, string[]>();
  const providers = new HttpProviders(cfg, async (value, init) => {
    const u = new URL(String(value)), [, , resource, encoded, operation] = u.pathname.split('/');
    const id = decodeURIComponent(encoded ?? '');
    const method = init?.method ?? 'GET';
    if (resource === 'applications') return Response.json({ channel_ids: [...channels.keys()] });
    if (resource === 'bridges') {
      if (method === 'DELETE') bridges.delete(id);
      else if (operation === 'addChannel') {
        const channel = u.searchParams.get('channel') ?? '';
        for (const [key, members] of bridges) bridges.set(key, members.filter(member => member !== channel));
        bridges.set(id, [...(bridges.get(id) ?? []), channel]);
      } else if (operation === 'removeChannel') bridges.set(id, (bridges.get(id) ?? []).filter(member => member !== u.searchParams.get('channel')));
      else if (method === 'POST') bridges.set(id, bridges.get(id) ?? []);
      return Response.json({ id, channels: bridges.get(id) ?? [] });
    }
    if (resource === 'channels') {
      if (method === 'POST' && !id) {
        const created = { id: u.searchParams.get('channelId') ?? '', state: 'Up' };
        channels.set(created.id, created); return Response.json(created);
      }
      if (operation === 'snoop') {
        if (!channels.has(id)) return new Response('{}', { status: 404 });
        const snoop = decodeURIComponent(u.pathname.split('/')[5] ?? '');
        const created = { id: snoop, state: 'Up' }; channels.set(snoop, created); return Response.json(created);
      }
      if (method === 'DELETE') { channels.delete(id); return new Response(null, { status: 204 }); }
      const channel = channels.get(id);
      if (!channel) return new Response('{}', { status: 404 });
      if (operation) return new Response(null, { status: 204 });
      return Response.json(channel);
    }
    throw new Error('Unexpected provider request');
  });
  const board = new Switchboard(f.store, providers, log, config.OPERATOR_PIN);
  const events = new AsteriskEvents(cfg, providers, board, log);
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 8000;
    while (!await check()) { if (Date.now() > deadline) throw new Error('ARI event did not reconcile'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  function send(event: unknown) { for (const ws of sockets.clients) ws.send(JSON.stringify(event)); }
  try {
    events.start();
    await until(async () => providers.available());
    const session = await f.store.get(primary);
    assert.ok(session?.operator?.carrierCallId);
    assert.equal(session.authentication.state, 'pending');
    assert.ok(await providers.inBridge(session.conferenceName, primary));
    const rejected = { id: '1729330000.2', state: 'Up', caller: { number: '+15559999999' }, dialplan: { context: 'from-telnyx', exten: '+15558888888' } };
    channels.set(rejected.id, rejected); send({ type: 'StasisStart', channel: rejected });
    await until(async () => !channels.has(rejected.id));
    assert.equal(await f.store.get(rejected.id), undefined);
    const otherCaller = { id: '1729330000.3', state: 'Up', caller: { number: '+15559999999' }, dialplan: { context: 'from-telnyx', exten: config.TELNYX_FROM_NUMBER } };
    channels.set(otherCaller.id, otherCaller); send({ type: 'StasisStart', channel: otherCaller });
    await until(async () => (await f.store.get(otherCaller.id))?.authentication.state === 'pending');
    assert.equal((await f.store.get(otherCaller.id))?.commandMode, 'arming');
    channels.delete(otherCaller.id);
    send({ type: 'ChannelDestroyed', cause: 16, channel: otherCaller });
    await until(async () => (await f.store.get(otherCaller.id))?.phase === 'ended');
    const attempt = randomUUID(), destination = `destination-${attempt}`;
    await f.store.locked(primary, async s => {
      s.authentication = { state: 'verified' }; s.commandMode = 'closed';
      s.destination = { attempt, participantLabel: destination, label: 'office', number: '+15550001111', callId: destination, state: 'ringing', createdAt: Date.now(), held: false };
    });
    send({ type: 'ChannelDestroyed', cause: 17, channel: { id: destination, state: 'Down' } });
    await until(async () => (await f.store.get(primary))?.destination === null);
    assert.equal((await f.store.get(primary))?.notice, 'The line is busy.');
    const failedAttempt = randomUUID(), failedDestination = `destination-${failedAttempt}`;
    await f.store.locked(primary, async s => {
      s.destination = { attempt: failedAttempt, participantLabel: failedDestination, label: 'office', number: '+15550001111', callId: failedDestination, state: 'ringing', createdAt: Date.now(), held: false };
    });
    send({ type: 'ChannelDestroyed', cause: 41, channel: { id: failedDestination, state: 'Down' } });
    await until(async () => (await f.store.get(primary))?.destination === null);
    assert.equal((await f.store.get(primary))?.notice, 'Call could not connect.');
    assert.equal(channels.has(primary), true);
    for (const ws of sockets.clients) ws.terminate();
    await until(async () => !providers.available());
    await until(async () => providers.available());
    assert.equal((await f.store.get(primary))?.phase, 'active');
    assert.equal(channels.get(primary)?.state, 'Up');
    // Miss the caller's destroy event and leave its operator alive. A scan must
    // clean it up rather than repeatedly trying to snoop the missing caller.
    channels.delete(primary);
    await events.synchronize();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.equal(channels.has(session.operator.carrierCallId), false);
  } finally {
    await events.stop();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.dispose();
  }
});
