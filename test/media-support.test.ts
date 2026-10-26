import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupAll, toneLevels, expectTones } from './media-support.js';

function tone(...frequencies: number[]) {
  return Array.from({ length: 160 }, (_, i) => frequencies.reduce((value, hz) => value + 5000 * Math.sin(2 * Math.PI * hz * i / 8000), 0));
}
test('audio oracle rejects loopback, wrong peers, and destination leakage to operator', () => {
  expectTones(toneLevels(tone(660)), [1], [0, 2], 'caller');
  expectTones(toneLevels(tone(440)), [0], [1, 2], 'operator');
  assert.throws(() => expectTones(toneLevels(tone(440)), [1], [0, 2], 'caller loopback'));
  assert.throws(() => expectTones(toneLevels(tone(880)), [1], [0], 'wrong peer'));
  assert.throws(() => expectTones(toneLevels(tone(440, 660)), [0], [1], 'spy both'));
});
test('cleanup attempts every remote deletion and closes local resources after a failure', async () => {
  const attempted: string[] = [];
  await assert.rejects(cleanupAll([
    () => { attempted.push('first channel'); throw new Error('ARI unavailable'); },
    () => { attempted.push('second channel'); },
    () => { attempted.push('bridge'); },
    () => { attempted.push('UDP'); },
    () => { attempted.push('WebSocket'); },
    () => { attempted.push('database'); },
  ]), AggregateError);
  assert.deepEqual(attempted, ['first channel', 'second channel', 'bridge', 'UDP', 'WebSocket', 'database']);
});
