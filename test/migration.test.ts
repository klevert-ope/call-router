import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, operator } from './helpers.js';
import { migrate } from '../src/migrate.js';

test('Telnyx migration preserves archived sessions, contacts and operator history and is idempotent', async () => {
  const f = await fixture();
  try {
    const id = 'CA' + '7'.repeat(32), generation = randomUUID();
    const archived = f.board.newSession(id); archived.phase = 'ended';
    const legacyOperator = { generation, identity: 'a'.repeat(64), participantLabel: 'old-operator', twilioCallId: operator,
      vapiCallId: 'old-vapi', controlUrl: null, state: 'connected', createdAt: Date.now() };
    await f.db.query('INSERT INTO sessions(primary_call_id,data) VALUES($1,$2)', [id, { ...archived, operator: legacyOperator }]);
    await f.db.query("INSERT INTO call_attempts(attempt_id,primary_call_id,role,data) VALUES($1,$2,'operator',$3)", [generation, id, legacyOperator]);
    await migrate(f.db); await migrate(f.db);
    assert.equal((await f.store.get(id))?.operator?.carrierCallId, operator);
    const history = await f.db.query("SELECT json_extract(data,'$.carrierCallId') AS id, json_type(data,'$.twilioCallId') IS NOT NULL AS legacy FROM call_attempts WHERE attempt_id=$1", [generation]);
    assert.deepEqual(history.rows, [{ id: operator, legacy: 0 }]);
    assert.equal(await f.store.contact('office'), '+15550001111');
  } finally { await f.dispose(); }
});

test('Telnyx migration refuses active Twilio calls without changing their session', async () => {
  const f = await fixture();
  try {
    const id = 'CA' + '6'.repeat(32);
    await f.store.create(f.board.newSession(id));
    await assert.rejects(migrate(f.db), /Drain active Twilio sessions/);
    assert.equal((await f.store.get(id))?.phase, 'active');
    assert.equal(await f.store.contact('office'), '+15550001111');
  } finally { await f.dispose(); }
});
