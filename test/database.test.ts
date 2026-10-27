import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database.js';
import { Store, Locked } from '../src/store.js';
import { migrate } from '../src/migrate.js';
import { Switchboard } from '../src/switchboard.js';
import { FakeProviders, log, primary } from './helpers.js';

test('SQLite persists sessions, contacts, attempts and dedup results across file reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-sqlite-'));
  const path = join(directory, 'nested', 'switchboard.sqlite');
  let db = new Database(path);
  try {
    await migrate(db);
    const store = new Store(db);
    await store.create(new Switchboard(store, new FakeProviders(), log).newSession(primary));
    await store.locked(primary, async s => {
      s.endPrimaryOnCleanup = true;
      s.notice = 'No answer.';
      s.noticeDelivery = { content: s.notice, retryAt: Date.now() + 3000, expiresAt: Date.now() + 60_000 };
    });
    await store.putContact('office', '+15550001111');
    db.query("INSERT INTO call_attempts(attempt_id,primary_call_id,role,data) VALUES('persisted-attempt',$1,'operator',$2)", [primary, { vapiCallId: 'vapi-id' }]);
    await store.beginResult('vapi-id', 'tool', 'fingerprint');
    await store.finishResult('vapi-id', 'tool', { result: 'Saved.' });
    db.close(); db = new Database(path);
    await migrate(db);
    const recovered = new Store(db);
    assert.equal((await recovered.get(primary))?.phase, 'active');
    assert.equal((await recovered.get(primary))?.endPrimaryOnCleanup, true);
    assert.equal((await recovered.get(primary))?.noticeDelivery?.content, 'No answer.');
    assert.deepEqual(db.query("SELECT data FROM call_attempts WHERE attempt_id='persisted-attempt'").rows, [{ data: { vapiCallId: 'vapi-id' } }]);
    assert.equal(await recovered.contact('office'), '+15550001111');
    assert.deepEqual(await recovered.result('vapi-id', 'tool'), { fingerprint: 'fingerprint', reply: { result: 'Saved.' } });
    assert.throws(() => db.query("INSERT INTO contacts(label,number) VALUES('invalid','+1bad')"));
    assert.throws(() => db.query("INSERT INTO call_attempts VALUES('attempt','missing','operator','{}',0)"));
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('separate SQLite connections fence expired lease owners and roll back failed saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-leases-'));
  const path = join(directory, 'switchboard.sqlite');
  const db = new Database(path), other = new Database(path);
  try {
    await migrate(db);
    const store = new Store(db), second = new Store(other);
    await store.create(new Switchboard(store, new FakeProviders(), log).newSession(primary));
    await store.locked(primary, async (stale, save) => {
      other.query('UPDATE sessions SET lease_until=0 WHERE primary_call_id=$1', [primary]);
      await second.locked(primary, async fresh => { fresh.notice = 'Current owner'; });
      stale.notice = 'Expired owner';
      await assert.rejects(save(), Locked);
      // The outer automatic save also verifies lease ownership.
    }).then(() => assert.fail('Expired owner must fail'), error => assert.ok(error instanceof Locked));
    assert.equal((await store.get(primary))?.notice, 'Current owner');
    assert.throws(() => db.transaction(() => {
      db.query("INSERT INTO contacts(label,number) VALUES('rollback','+15550001111')");
      throw new Error('abort');
    }), /abort/);
    assert.equal(await second.contact('rollback'), undefined);
    assert.throws(() => other.query("INSERT INTO call_attempts VALUES('attempt','missing','operator','{}',0)"));
  } finally { other.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});
