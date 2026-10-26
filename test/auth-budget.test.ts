import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { migrate } from '../src/migrate.js';
import { fixture, primary } from './helpers.js';

test('global PIN pacing survives file reopen and permits one later retry without a permanent lockout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-auth-'));
  let db = new Database(join(directory, 'auth.sqlite'));
  try {
    await migrate(db); const store = new Store(db); const now = Date.now();
    for (let i = 0; i < 6; i++) assert.equal(store.recordPinFailure(now), true);
    assert.equal(store.pinAllowed(now), false);
    db.close(); db = new Database(join(directory, 'auth.sqlite'));
    const restarted = new Store(db);
    assert.equal(restarted.claimPinAttempt(now + 29_999), false);
    assert.equal(restarted.claimPinAttempt(now + 30_000), true);
    assert.equal(restarted.claimPinAttempt(now + 30_000), false);
    restarted.recordPinSuccess();
    assert.equal(restarted.claimPinAttempt(now + 30_001), true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('admission caps pending authentication and new sessions before operator allocation', async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.admit(f.board.newSession('auth-one')), true);
    assert.equal(f.store.admit(f.board.newSession('auth-two')), true);
    assert.equal(f.store.admit(f.board.newSession('auth-three')), false);
    assert.equal(await f.store.get('auth-three'), undefined);
    await f.store.locked('auth-one', async s => { s.phase = 'ended'; });
    await f.store.locked('auth-two', async s => { s.phase = 'ended'; });
    for (let i = 0; i < 18; i++) {
      const s = f.board.newSession(`auth-next-${i}`); assert.equal(f.store.admit(s), true);
      await f.store.locked(s.primaryCallId, async current => { current.phase = 'ended'; });
    }
    assert.equal(f.store.admit(f.board.newSession('auth-over-limit')), false);
    assert.equal(f.providers.operatorCreates, 0);
  } finally { await f.dispose(); }
});

test('redial preserves pacing but anyone with the correct PIN can retry after the short cooldown', async t => {
  const f = await fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    for (let i = 0; i < 6; i++) f.store.recordPinFailure();
    assert.equal(f.store.admit(f.board.newSession('redial')), true);
    await f.store.locked(primary, async s => {
      s.authentication = { state: 'pending', attempts: 0, deadline: Date.now() + 60_000, lastTranscriptAt: 0, promptedGeneration: s.operator!.generation };
      s.commandMode = 'arming';
    });
    await f.board.transcript(primary, 'vapi-id', '0427', now);
    assert.equal((await f.store.get(primary))?.phase, 'active');
    assert.equal((await f.store.get(primary))?.authentication.state, 'pending');
    const auth = (await f.store.get(primary))?.authentication;
    assert.ok(auth?.state === 'pending' && auth.attempts === 0);
    assert.equal(f.providers.spoken.at(-1), 'Please wait, then repeat four digits.');
    now += 30_000;
    await f.board.transcript(primary, 'vapi-id', '0427', now);
    assert.equal((await f.store.get(primary))?.authentication.state, 'verified');
    assert.equal(f.store.pinAllowed(), true);
  } finally { await f.dispose(); }
});
