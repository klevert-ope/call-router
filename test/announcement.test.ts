import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, primary, config, log } from './helpers.js';
import { Switchboard } from '../src/switchboard.js';

test('retry a failed PIN prompt after recovery and backend restart', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => {
      s.authentication = { state: 'pending', attempts: 0, deadline: Date.now() + 60_000, lastTranscriptAt: 0, promptedGeneration: null };
      s.commandMode = 'arming';
      s.commandDeadline = s.authentication.deadline;
    });
    const say = f.providers.say.bind(f.providers);
    let rejectOnce = true;
    f.providers.say = async (...args) => {
      if (rejectOnce) { rejectOnce = false; throw new Error('Injected announcement failure'); }
      return say(...args);
    };
    const session = await f.store.get(primary);
    assert.ok(session?.conferenceId);
    await assert.rejects(f.board.joined(primary, session.conferenceId), /Injected announcement failure/);
    await f.store.locked(primary, async s => { if (s.announcement) s.announcement.retryAt = 0; });
    const restarted = new Switchboard(f.store, f.providers, log, config.OPERATOR_PIN);
    await restarted.suspendControls();
    await restarted.reconcile();
    assert.ok(f.providers.spoken.includes('Please speak your four digit PIN.'), 'Pending authentication must recover its undelivered PIN prompt');
  } finally { await f.dispose(); }
});

test('retry an undelivered readiness announcement for an idle caller', async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => { s.commandMode = 'arming'; });
    const say = f.providers.say.bind(f.providers);
    let rejectOnce = true;
    f.providers.say = async (...args) => {
      if (rejectOnce) { rejectOnce = false; throw new Error('Injected announcement failure'); }
      return say(...args);
    };
    const session = await f.store.get(primary);
    assert.ok(session?.conferenceId);
    await assert.rejects(f.board.joined(primary, session.conferenceId), /Injected announcement failure/);
    await f.store.locked(primary, async s => { if (s.announcement) s.announcement.retryAt = 0; });
    await f.board.reconcile();
    assert.ok(f.providers.spoken.includes('Operator ready.'), 'Idle callers must receive readiness after transient delivery failure');
  } finally { await f.dispose(); }
});

for (const pending of [true, false]) test(`recover a failed ${pending ? 'PIN' : 'readiness'} context update without opening authorization early`, async () => {
  const f = await fixture();
  try {
    await f.store.locked(primary, async s => {
      s.commandMode = 'arming';
      if (pending) s.authentication = { state: 'pending', attempts: 0, deadline: Date.now() + 60_000, lastTranscriptAt: 0, promptedGeneration: null };
    });
    const context = f.providers.context.bind(f.providers); let rejectOnce = true;
    f.providers.context = async (...args) => {
      if (rejectOnce) { rejectOnce = false; throw new Error('Injected context failure'); }
      return context(...args);
    };
    const s = await f.store.get(primary); assert.ok(s?.conferenceId);
    await assert.rejects(f.board.joined(primary, s.conferenceId));
    assert.equal((await f.store.get(primary))?.commandMode, 'arming');
    await f.store.locked(primary, async s => { if (s.announcement) s.announcement.retryAt = 0; });
    await f.board.reconcile();
    assert.ok(f.providers.spoken.includes(pending ? 'Please speak your four digit PIN.' : 'Operator ready.'));
    assert.equal((await f.store.get(primary))?.announcement, null);
  } finally { await f.dispose(); }
});

test('permanent announcement failure closes the whole call at its delivery deadline', async t => {
  const f = await fixture(); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    await f.store.locked(primary, async s => { s.commandMode = 'arming'; });
    f.providers.say = async () => { throw new Error('Permanent control failure'); };
    const s = await f.store.get(primary); assert.ok(s?.conferenceId);
    await assert.rejects(f.board.joined(primary, s.conferenceId));
    now += 60_000; await f.board.expireWindows();
    assert.equal((await f.store.get(primary))?.phase, 'ended');
    assert.ok(f.providers.ended.includes(primary));
  } finally { await f.dispose(); }
});
