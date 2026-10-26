import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config, log } from './helpers.js';
import { configSchema } from '../src/config.js';
import { HttpProviders } from '../src/providers.js';
import { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { Switchboard } from '../src/switchboard.js';
import { cleanupAll } from './media-support.js';

test('real Asterisk bridges, holding, snoop and event reconnection', { skip: process.env.ASTERISK_TEST_ENABLED !== '1', timeout: 40_000 }, async () => {
  const cfg = configSchema.parse({ ...config, ASTERISK_URL: process.env.ASTERISK_URL,
    ASTERISK_USERNAME: process.env.ASTERISK_USERNAME, ASTERISK_PASSWORD: process.env.ASTERISK_PASSWORD,
    ASTERISK_APP: `smoke-${randomUUID()}` });
  // Keep the production operator setup path, replacing only its external SIP
  // destination with an isolated local channel so this test never places calls.
  const providers = new HttpProviders(cfg, (input, init) => {
    const url = new URL(String(input));
    if (url.searchParams.get('endpoint') === `PJSIP/${cfg.VAPI_ENDPOINT}/${cfg.VAPI_SIP_URI}`) {
      url.searchParams.set('endpoint', 'Local/autoanswer@switchboard-test/n');
    }
    return fetch(url, init);
  });
  const primary = `smoke-${randomUUID()}`, destination = `smoke-${randomUUID()}`, operator = `operator-${randomUUID()}`;
  const bridge = `smoke-${randomUUID()}`;
  const db = new Database(':memory:');
  let socket: WebSocket | undefined;
  async function connect() {
    const url = new URL(`${cfg.ASTERISK_URL}/events`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('app', cfg.ASTERISK_APP);
    const ws = new WebSocket(url, { headers: { Authorization: `Basic ${Buffer.from(`${cfg.ASTERISK_USERNAME}:${cfg.ASTERISK_PASSWORD}`).toString('base64')}` }, handshakeTimeout: 8000 });
    socket = ws;
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return ws;
  }
  async function originate(id: string) {
    await providers.ari('channels', 'POST', { channelId: id, endpoint: 'Local/autoanswer@switchboard-test/n', app: cfg.ASTERISK_APP });
    const deadline = Date.now() + 8000;
    while ((await providers.call(id)).status !== 'in-progress') {
      if (Date.now() > deadline) throw new Error('Local test channel did not answer');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try {
    socket = await connect();
    await originate(primary); await originate(destination);
    await providers.bridge(bridge); await providers.add(bridge, primary); await providers.add(bridge, destination);
    const session = new Switchboard(new Store(db), providers, log).newSession(primary);
    session.conferenceName = bridge;
    await providers.dialOperator(session, {
      participantLabel: operator, generation: randomUUID(), identity: 'a'.repeat(64),
      carrierCallId: null, vapiCallId: null, controlUrl: null, state: 'creating', createdAt: Date.now(),
    });
    const deadline = Date.now() + 8000;
    while ((await providers.call(operator)).status !== 'in-progress') {
      if (Date.now() > deadline) throw new Error('Operator channel did not answer');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await providers.channel(operator)).caller?.number, 'a'.repeat(64));
    await providers.coach(bridge, operator, primary);
    assert.equal(await providers.inBridge(`${operator}-audio`, `${operator}-snoop`), true);
    assert.equal(await providers.inBridge(`${operator}-audio`, operator), true);
    await providers.hold(bridge, destination, true, primary);
    assert.equal(await providers.inBridge(bridge, destination), false);
    assert.equal(await providers.inBridge(`${bridge}-hold`, destination), true);
    await providers.hold(bridge, destination, false, primary);
    socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 1000));
    socket = await connect();
    assert.equal((await providers.call(primary)).status, 'in-progress');
    assert.equal((await providers.call(destination)).status, 'in-progress');
    assert.equal(await providers.inBridge(bridge, primary), true);
    assert.equal(await providers.inBridge(bridge, destination), true);
  } finally {
    await cleanupAll([
      ...[operator, destination, primary].map(id => () => providers.end(id, primary, id === primary)),
      () => providers.endConference(bridge), () => socket?.terminate(), () => db.close(),
    ]);
  }
});
