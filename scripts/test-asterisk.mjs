import { spawnSync } from 'node:child_process';

if (process.env.ASTERISK_TEST_ENABLED !== '1' || !process.env.ASTERISK_URL
  || !process.env.ASTERISK_USERNAME || !process.env.ASTERISK_PASSWORD) {
  console.error('Set ASTERISK_TEST_ENABLED=1 and ARI credentials for a disposable Asterisk instance.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap',
  'test/asterisk-live.test.ts', 'test/asterisk-audio.test.ts'], {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
const output = result.stdout ?? '';
if (result.error || result.status !== 0 || !/^# tests 2\s*$/m.test(output)
  || !/^# pass 2\s*$/m.test(output) || !/^# skipped 0\s*$/m.test(output)) {
  console.error('Required Asterisk evidence is failed, missing, or skipped.');
  process.exit(1);
}
