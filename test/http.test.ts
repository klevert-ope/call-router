import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { fixture, config, primary, destination, log } from './helpers.js';

test('admin authentication, contact validation and normalization', async () => {
  const f = await fixture(); const app = createApp(config, f.board, log);
  try {
    await request(app).get('/admin/contacts').expect(401);
    await request(app).put('/admin/contacts/%20OFFICE%20').set('Authorization', `Bearer ${config.ADMIN_TOKEN}`).send({ number: '+15550003333' }).expect(200);
    assert.equal(await f.store.contact('office'), '+15550003333');
    await request(app).put('/admin/contacts/bad').set('Authorization', `Bearer ${config.ADMIN_TOKEN}`).send({ number: 'not-e164' }).expect(400);
    await request(app).delete('/admin/contacts/office').set('Authorization', `Bearer ${config.ADMIN_TOKEN}`).expect(204);
    assert.equal(await f.store.contact('office'), undefined);
    await request(app).get('/health/live').expect(200);
    await request(app).get('/health/ready').expect(200);
  } finally { await f.dispose(); }
});
test('Vapi rejects unauthenticated and malformed envelopes; tool errors are HTTP 200 strings', async () => {
  const f = await fixture(); const app = createApp(config, f.board, log);
  try {
    const path = '/webhook/vapi-switchboard';
    await request(app).post(path).send({}).expect(401);
    await request(app).post(path).set('Authorization', `Bearer ${config.VAPI_WEBHOOK_SECRET}`).send({ message: {} }).expect(400);
    const body = { message: { type: 'tool-calls', call: { id: 'vapi-id' }, toolCallList: [
      { id: 'a', function: { name: 'manage_outbound_call', arguments: { action: 'hangup', primaryCallId: primary } } },
      { id: 'b', function: { name: 'unknown_tool', arguments: {} } },
    ] } };
    const response = await request(app).post(path).set('Authorization', `Bearer ${config.VAPI_WEBHOOK_SECRET}`).send(body).expect(200);
    assert.equal(response.body.results.length, 2);
    assert.equal(typeof response.body.results[0].error, 'string');
    assert.equal(typeof response.body.results[1].error, 'string');
    assert.equal(f.providers.ended.length, 0);
  } finally { await f.dispose(); }
});
test('retired carrier endpoints cannot authorize keypad commands', async () => {
  const f = await fixture();
  try {
    const app = createApp(config, f.board, log);
    for (const route of ['inbound', 'pin', 'primary', 'conference', 'leg', 'hold']) {
      await request(app).post(`/webhook/telnyx/${route}`).send({ Digits: config.OPERATOR_PIN, Digit: '*' }).expect(404);
    }
    assert.deepEqual(f.providers.ended, []);
    f.providers.online = false;
    await request(app).get('/health/ready').expect(503);
  } finally { await f.dispose(); }
});
