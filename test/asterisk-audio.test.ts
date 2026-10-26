import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { config, log } from './helpers.js';
import { configSchema } from '../src/config.js';
import { HttpProviders } from '../src/providers.js';
import { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { Switchboard } from '../src/switchboard.js';
import { cleanupAll, toneLevels, expectTones } from './media-support.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function ulaw(sample: number): number {
  const sign = sample < 0 ? 128 : 0;
  const value = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 16384; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15))) & 255;
}
function pcm(byte: number): number {
  const value = (~byte) & 255;
  const sample = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
  return value & 128 ? 132 - sample : sample - 132;
}

test('real Asterisk two-way RTP survives private hold and caller recovery', { skip: process.env.ASTERISK_TEST_ENABLED !== '1', timeout: 30_000 }, async () => {
  const cfg = configSchema.parse({ ...config, ASTERISK_URL: process.env.ASTERISK_URL,
    ASTERISK_USERNAME: process.env.ASTERISK_USERNAME, ASTERISK_PASSWORD: process.env.ASTERISK_PASSWORD,
    ASTERISK_APP: `audio-${randomUUID()}` });
  const providers = new HttpProviders(cfg), bridge = cfg.ASTERISK_APP;
  const db = new Database(':memory:');
  const url = new URL(`${cfg.ASTERISK_URL}/events`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('app', cfg.ASTERISK_APP);
  const socket = new WebSocket(url, { headers: { Authorization: `Basic ${Buffer.from(`${cfg.ASTERISK_USERNAME}:${cfg.ASTERISK_PASSWORD}`).toString('base64')}` }, handshakeTimeout: 8000 });
  socket.on('error', () => {});
  const legs: { id: string; socket: dgram.Socket; port: number; frequency: number; sequence: number; timestamp: number; tones: number[]; frames: number }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  async function leg(frequency: number, prefix = 'audio') {
    const socket = dgram.createSocket('udp4');
    const leg = { id: `${prefix}-${randomUUID()}`, socket, port: 0, frequency, sequence: 0, timestamp: 0, tones: [0, 0, 0], frames: 0 };
    legs.push(leg);
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    const address = socket.address();
    socket.on('message', packet => {
      if (packet.length < 12 || (packet[0]! >> 6) !== 2 || (packet[1]! & 127) !== 0) return;
      let offset = 12 + (packet[0]! & 15) * 4;
      if (packet[0]! & 16) {
        if (packet.length < offset + 4) return;
        offset += 4 + packet.readUInt16BE(offset + 2) * 4;
      }
      const end = packet[0]! & 32 ? packet.length - packet[packet.length - 1]! : packet.length;
      if (end <= offset) return;
      const levels = toneLevels(Array.from(packet.subarray(offset, end), pcm));
      levels.forEach((level, index) => { leg.tones[index]! += level; }); leg.frames++;
    });
    await providers.ari('channels/externalMedia', 'POST', { channelId: leg.id, app: cfg.ASTERISK_APP, external_host: `127.0.0.1:${address.port}`, format: 'ulaw' });
    const variable = await providers.ari(`channels/${leg.id}/variable`, 'GET', { variable: 'UNICASTRTP_LOCAL_PORT' });
    assert.ok(variable && typeof variable === 'object' && 'value' in variable);
    leg.port = Number(variable.value); assert.ok(leg.port > 0);
    return leg;
  }
  async function levels() {
    await sleep(300);
    for (const leg of legs) { leg.tones = [0, 0, 0]; leg.frames = 0; }
    await sleep(1000);
    return legs.map(leg => leg.tones.map(value => value / Math.max(1, leg.frames)));
  }
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const caller = await leg(440), destination = await leg(660);
    timer = setInterval(() => {
      for (const leg of legs) {
        if (!leg.port) continue; // A new external-media leg is still allocating its RTP socket.
        const packet = Buffer.alloc(172); packet[0] = 128; packet[1] = 0;
        packet.writeUInt16BE(leg.sequence++ & 65535, 2); packet.writeUInt32BE(leg.timestamp >>> 0, 4); packet.writeUInt32BE(1234, 8);
        for (let i = 0; i < 160; i++) packet[12 + i] = ulaw(5000 * Math.sin(2 * Math.PI * leg.frequency * (leg.timestamp + i) / 8000));
        leg.timestamp += 160; leg.socket.send(packet, leg.port, '127.0.0.1');
      }
    }, 20);
    // prepare is the production ingress/reconnect path, including whisper timing.
    const session = new Switchboard(new Store(db), providers, log).newSession(caller.id);
    session.conferenceName = bridge;
    await providers.prepare(session);
    await providers.hold(bridge, destination.id, false, caller.id);
    let received = await levels();
    expectTones(received[0]!, [1], [0, 2], 'caller');
    expectTones(received[1]!, [0], [1, 2], 'destination');
    await providers.prepare(session);
    received = await levels();
    expectTones(received[0]!, [1], [0, 2], 'recovered caller');
    expectTones(received[1]!, [0], [1, 2], 'recovered destination');
    await providers.hold(bridge, destination.id, true, caller.id);
    for (const level of await levels()) expectTones(level, [], [0, 1, 2], 'held peer');
    await providers.hold(bridge, destination.id, false, caller.id);
    received = await levels();
    expectTones(received[0]!, [1], [0, 2], 'resumed caller');
    expectTones(received[1]!, [0], [1, 2], 'resumed destination');
    await providers.hold(bridge, destination.id, true, caller.id);
    const operator = await leg(880, 'operator');
    await providers.coach(bridge, operator.id, caller.id);
    const privateLevels = await levels();
    expectTones(privateLevels[0]!, [2], [0, 1], 'private caller');
    expectTones(privateLevels[1]!, [], [0, 1, 2], 'private destination');
    expectTones(privateLevels[2]!, [0], [1, 2], 'private operator');
    await providers.hold(bridge, destination.id, false, caller.id);
    const conversation = await levels();
    expectTones(conversation[0]!, [1, 2], [0], 'caller with operator');
    expectTones(conversation[1]!, [0], [1, 2], 'destination excludes operator whisper');
    expectTones(conversation[2]!, [0], [1, 2], 'operator excludes destination ingress');
  } finally {
    if (timer) clearInterval(timer);
    await cleanupAll([
      ...legs.map(leg => () => providers.end(leg.id, leg.id, true)),
      () => providers.endConference(bridge),
      ...legs.map(leg => () => leg.socket.close()),
      () => socket.terminate(), () => db.close(),
    ]);
  }
});
