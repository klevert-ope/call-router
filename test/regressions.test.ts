import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, primary, destination, conference, log } from './helpers.js';
import { Store, Locked } from '../src/store.js';
import { Switchboard } from '../src/switchboard.js';
import { migrate } from '../src/migrate.js';
import { ProviderError } from '../src/providers.js';

test('a caller disconnect before acknowledgement prevents the queued outbound call', async () => {
  const f = await fixture();
  try {
    await f.utterance('Call office');
    await f.board.tool(primary, 'vapi-id', 'disconnect-before-dial', 'manage_outbound_call', {
      action: 'dial', label: 'office', utterance: 'Call office',
    });
    f.providers.calls.set(primary, 'completed');
    await f.acknowledge();
    await f.board.reconcile();
    assert.equal(f.providers.creates, 0);
    assert.equal((await f.store.get(primary))?.phase, 'ended');
  } finally { await f.dispose(); }
});

for (const missingOperator of [false, true]) test(`a disconnected caller never receives a retried operator or prompt, missingOperator=${missingOperator}`, async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => {
      s.commandMode = 'arming';
      if (missingOperator) s.operator = null;
    });
    f.providers.calls.set(primary, 'completed');
    f.providers.participants.delete(primary);
    await f.board.joined(primary, conference);
    await f.board.reconcile();
    await f.board.reconcile();
    assert.equal(f.providers.operatorCreates, 0);
    assert.equal(f.providers.creates, 0);
    assert.equal(f.providers.spoken.length, 0);
    assert.equal((await f.store.get(primary))?.phase, 'ended');
  } finally { await f.dispose(); }
});

test('a destination routing failure reports failure before readiness and preserves the caller', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'failed-route', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    const d = (await f.store.get(primary))?.destination; assert.ok(d);
    await f.board.leg(primary, d.attempt, 'destination', destination, 'failed');
    assert.deepEqual(f.providers.spoken.slice(-2), ['Call could not connect.', 'Operator ready.']);
    assert.equal((await f.store.get(primary))?.phase, 'active');
    assert.equal(f.providers.ended.includes(primary), false);
  } finally { await f.dispose(); }
});

test('numbered contacts accept word/digit variants without changing the authorized target', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator, call number one.');
    const reply = await f.board.tool(primary, 'vapi-id', 'numbered', 'manage_outbound_call', {
      action: 'dial', label: 'number one', utterance: 'Operator call number 1',
    });
    assert.deepEqual(reply, { result: 'Dialing now.' });
    assert.equal((await f.store.get(primary))?.destination?.number, '+15550002222');
  } finally { await f.dispose(); }
});

test('a tool arriving before its final transcript waits without holding the session lease', async () => {
  const f = await fixture();
  try {
    const pending = f.board.tool(primary, 'vapi-id', 'early', 'manage_outbound_call', {
      action: 'dial', label: 'number 1', utterance: 'Operator call number one',
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    await f.utterance('Operator, call number 1.');
    assert.deepEqual(await pending, { result: 'Dialing now.' });
    assert.equal((await f.store.get(primary))?.destination?.label, 'number 1');
  } finally { await f.dispose(); }
});

test('a tool without a fresh transcript remains unauthorized after the wait', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'unspoken', 'manage_outbound_call', {
      action: 'dial', label: 'number 1', utterance: 'Operator call number 1',
    }), { error: 'Please repeat what you would like.' });
    assert.equal((await f.store.get(primary))?.destination, null);
  } finally { await f.dispose(); }
});


test('a verified status transcript cannot authorize dialing or hanging up', async () => {
  const f = await fixture();
  try {
    for (const action of ['dial', 'hangup']) {
      await f.utterance('Operator status');
      const args = action === 'dial' ? { action, label: 'office', utterance: 'Operator status' } : { action, utterance: 'Operator status' };
      assert.deepEqual(await f.board.tool(primary, 'vapi-id', action, 'manage_outbound_call', args), { error: 'Please repeat what you would like.' });
      await f.acknowledge();
    }
    assert.equal(f.providers.creates, 0);
    assert.deepEqual(f.providers.ended, []);
  } finally { await f.dispose(); }
});

test('queued dialing survives restart and creates no external leg during private mode', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.board.reconcile();
    assert.equal(f.providers.creates, 0);
    assert.equal((await f.store.get(primary))?.destination?.state, 'queued');
    await f.store.locked(primary, async s => { s.commandDeadline = Date.now() - 1; });
    const recovered = new Switchboard(new Store(f.db), f.providers, log);
    const create = f.providers.dialDestination.bind(f.providers);
    f.providers.dialDestination = async (s, d) => {
      assert.equal((await f.store.get(primary))?.commandMode, 'closed');
      return create(s, d);
    };
    await recovered.expireWindows();
    await recovered.reconcile();
    assert.equal(f.providers.creates, 1);
  } finally { await f.dispose(); }
});

test('a rejected deferred creation returns to idle command mode without dropping the caller', async () => {
  const f = await fixture();
  try {
    f.providers.dialDestination = async () => { throw new ProviderError('asterisk', 400, false); };
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.destination, null);
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    await f.board.reconcile();
    assert.ok(f.providers.spoken.includes('Service unavailable. Please try again.'));
    assert.deepEqual(f.providers.ended, []);
  } finally { await f.dispose(); }
});

test('private-mode request can cancel a queued destination before any provider creation', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.board.privateMode(primary); await f.board.joined(primary, conference);
    await f.utterance('Operator hang up on them');
    await f.board.tool(primary, 'vapi-id', 'cancel', 'manage_outbound_call', { action: 'hangup', utterance: 'Operator hang up on them' });
    await f.acknowledge(); await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.destination, null);
    assert.equal(f.providers.creates, 0);
    assert.deepEqual(f.providers.ended, []);
  } finally { await f.dispose(); }
});

test('a delayed switch retains its target through restart and creates it once', async () => {
  const f = await fixture();
  try {
    await f.utterance('Operator call office');
    await f.board.tool(primary, 'vapi-id', 'dial', 'manage_outbound_call', { action: 'dial', label: 'office', utterance: 'Operator call office' });
    await f.acknowledge();
    f.providers.calls.set(destination, 'in-progress');
    const d = (await f.store.get(primary))?.destination; assert.ok(d);
    await f.board.leg(primary, d.attempt, 'destination', destination, 'in-progress');
    await f.board.privateMode(primary); await f.board.joined(primary, conference);
    const end = f.providers.end.bind(f.providers);
    let delayed = true;
    f.providers.end = async (...args) => { if (!delayed) await end(...args); };
    await f.utterance('Operator switch to number 1');
    assert.deepEqual(await f.board.tool(primary, 'vapi-id', 'switch', 'manage_outbound_call', { action: 'switch', label: 'number 1', utterance: 'Operator switch to number 1' }), { result: 'End this call and call number 1?' });
    assert.deepEqual(await f.confirm(), { result: 'Switching now.' });
    await f.acknowledge();
    assert.equal((await f.store.get(primary))?.pendingSwitch?.label, 'number 1');
    await f.store.putContact('number 1', '+15550009999');
    delayed = false; f.providers.calls.set(destination, 'completed');
    const recovered = new Switchboard(new Store(f.db), f.providers, log);
    await recovered.reconcile(); await recovered.reconcile();
    const current = await f.store.get(primary);
    assert.equal(current?.destination?.label, 'number 1');
    assert.equal(current?.destination?.number, '+15550002222');
    assert.equal(current?.pendingSwitch, null);
    assert.equal(f.providers.creates, 2);
    assert.ok(!f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});

test('slow recovery reads do not block private-mode requests and stale observations are discarded', async () => {
  const f = await fixture();
  let release = () => {};
  let recovery: Promise<void> | undefined;
  try {
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const call = f.providers.call.bind(f.providers);
    f.providers.call = async id => {
      if (id === primary) { entered(); await blocked; return { sid: primary, status: 'completed' }; }
      return call(id);
    };
    await f.store.locked(primary, async s => { s.commandMode = 'closed'; });
    recovery = f.board.reconcile(); await started;
    await f.board.privateMode(primary);
    // The fixture keeps the caller in the bridge; verified coaching opens private mode.
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
    release(); await recovery;
    assert.equal((await f.store.get(primary))?.phase, 'active');
    assert.equal(f.providers.closed, false);
  } finally { release(); await recovery; await f.dispose(); }
});

test('private-mode request survives lease contention and is recovered after restart', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { s.commandMode = 'closed'; });
    await f.db.query("UPDATE sessions SET lease_owner='test-owner',lease_until=(unixepoch('subsec')*1000)+60000 WHERE primary_call_id=$1", [primary]);
    await assert.rejects(f.board.privateMode(primary), Locked);
    assert.ok(await f.store.privateRequest(primary));
    await f.db.query('UPDATE sessions SET lease_owner=NULL,lease_until=NULL WHERE primary_call_id=$1', [primary]);
    await new Switchboard(new Store(f.db), f.providers, log).expireWindows();
    assert.equal(await f.store.privateRequest(primary), null);
    assert.equal((await f.store.get(primary))?.commandMode, 'open');
  } finally { await f.dispose(); }
});

test('unchanged callbacks and repeated saves do not rewrite session or attempt data', async () => {
  const f = await fixture();
  try {
    f.db.exec(`CREATE TABLE writes (name text);
      CREATE TRIGGER session_write AFTER UPDATE OF data ON sessions BEGIN INSERT INTO writes VALUES ('sessions'); END;
      CREATE TRIGGER attempt_insert AFTER INSERT ON call_attempts BEGIN INSERT INTO writes VALUES ('call_attempts'); END;
      CREATE TRIGGER attempt_write AFTER UPDATE ON call_attempts BEGIN INSERT INTO writes VALUES ('call_attempts'); END;`);
    await f.store.locked(primary, async (_s, save) => { await save(); await save(); });
    await f.board.transcript(primary, 'retired-operator', 'Operator status', Date.now());
    assert.equal((await f.db.query('SELECT * FROM writes')).rowCount, 0);
    await f.store.locked(primary, async (s, save) => { s.notice = 'Hello.'; await save(); await save(); });
    assert.deepEqual((await f.db.query('SELECT name FROM writes')).rows, [{ name: 'sessions' }]);
    await f.db.query('DELETE FROM writes');
    await f.store.locked(primary, async (s, save) => { if (s.operator) s.operator.createdAt--; await save(); await save(); });
    assert.deepEqual((await f.db.query('SELECT name FROM writes ORDER BY name')).rows, [{ name: 'call_attempts' }, { name: 'sessions' }]);
  } finally { await f.dispose(); }
});

test('due-session selection ignores future deadlines and ended sessions', async () => {
  const f = await fixture();
  try {
    await migrate(f.db);
    assert.deepEqual(await f.store.due(), []);
    await f.store.requestPrivate(primary);
    assert.equal((await f.store.due())[0]?.primaryCallId, primary);
    const request = await f.store.privateRequest(primary); assert.ok(request);
    await f.store.clearPrivateRequest(primary, request);
    await f.store.locked(primary, async s => { s.commandDeadline = Date.now() + 60_000; });
    assert.deepEqual(await f.store.due(), []);
    await f.store.locked(primary, async s => { s.commandDeadline = Date.now() - 1; });
    assert.equal((await f.store.due()).length, 1);
    await f.store.locked(primary, async s => { s.phase = 'ended'; });
    assert.deepEqual(await f.store.due(), []);
  } finally { await f.dispose(); }
});

test('retention deletes expired session history and dedup records while preserving live sessions', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { if (s.operator) s.operator.createdAt--; });
    await f.store.beginResult('vapi-id', 'old-tool', 'fingerprint');
    await f.store.locked(primary, async s => { s.phase = 'ended'; s.operator = null; });
    const live = f.board.newSession('CA' + '5'.repeat(32));
    await f.store.create(live);
    await f.db.query("UPDATE sessions SET updated_at=(unixepoch('subsec')*1000)-2678400000");
    await f.store.prune();
    assert.equal(await f.store.get(primary), undefined);
    assert.ok(await f.store.get(live.primaryCallId));
    assert.equal(await f.store.result('vapi-id', 'old-tool'), undefined);
    assert.equal((await f.db.query('SELECT * FROM call_attempts')).rowCount, 0);
  } finally { await f.dispose(); }
});

test('a secondary provider outage does not prevent natural caller cleanup', async () => {
  const f = await fixture();
  try {
    f.providers.calls.set(primary, 'completed');
    f.providers.vapiCall = async () => { throw new ProviderError('vapi', 503, true); };
    await f.board.reconcile();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.equal(f.providers.closed, true);
    assert.ok(!f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});
