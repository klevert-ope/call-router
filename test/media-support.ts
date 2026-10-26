import assert from 'node:assert/strict';

export async function cleanupAll(actions: (() => unknown | Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(actions.map(async action => action()));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed');
}

export const frequencies = [440, 660, 880] as const;
export function toneLevels(samples: readonly number[]): number[] {
  return frequencies.map(frequency => {
    let real = 0, imaginary = 0;
    for (let i = 0; i < samples.length; i++) {
      const phase = 2 * Math.PI * frequency * i / 8000;
      real += samples[i]! * Math.cos(phase); imaginary += samples[i]! * Math.sin(phase);
    }
    return 2 * Math.hypot(real, imaginary) / Math.max(1, samples.length);
  });
}
export function expectTones(levels: readonly number[], expected: number[], forbidden: number[], label: string): void {
  for (const index of expected) assert.ok(levels[index]! > 2000, `${label}: missing ${frequencies[index]} Hz (${levels[index]})`);
  for (const index of forbidden) assert.ok(levels[index]! < 700, `${label}: leaked ${frequencies[index]} Hz (${levels[index]})`);
}
