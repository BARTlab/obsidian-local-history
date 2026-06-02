import {describe, expect, it} from '@jest/globals';

import {
  assertWithinBaseline,
  type Baseline,
  baselineMode,
  checkBudget,
  measure,
  REGRESSION_BUDGET,
} from './harness';

/** Build a one-label baseline with the given median; provenance is filler. */
function baselineWith(label: string, medianMs: number): Baseline {
  return {[label]: {medianMs, recordedAt: '2026-01-01T00:00:00.000Z', env: 'node test'}};
}

/**
 * Self-test for the perf harness. Runs under jest.config.perf.js only (named
 * *.perf.ts so the default `npm test` never picks it up). Proves the three
 * harness contracts the later benches rely on: measure returns a positive
 * median, the gate is lenient when a baseline label is missing, and the gate
 * trips on a synthetic over-budget value.
 */
describe('perf harness', () => {
  it('measure returns a positive median over the iteration count', () => {
    const median = measure('harness/self-test', () => {
      let acc = 0;
      for (let i = 0; i < 1000; i++) {
        acc += i;
      }
      // Touch acc so the loop is not optimised away.
      if (acc < 0) {
        throw new Error('unreachable');
      }
    }, 50);

    expect(median).toBeGreaterThan(0);
    expect(Number.isFinite(median)).toBe(true);
  });

  it('measure rejects a non-positive iteration count', () => {
    expect(() => measure('harness/bad-iters', () => undefined, 0)).toThrow();
  });

  it('resolves baseline mode from PERF_BASELINE (record only when explicitly set)', () => {
    // Robust under either invocation: gate is the default for unset/anything
    // else, record only when PERF_BASELINE is exactly "record".
    const expected = process.env.PERF_BASELINE === 'record' ? 'record' : 'gate';
    expect(baselineMode()).toBe(expected);
  });

  it('disk-backed gate passes when the baseline has no entry for the label', () => {
    // The committed baseline does not contain this synthetic label, so the
    // gate must treat it as "record on next pass" and not throw.
    expect(() => assertWithinBaseline('harness/__missing-label__', 123.456)).not.toThrow();
  });

  it('gate passes when the measured value is within budget', () => {
    const baseline = baselineWith('harness/within', 10);
    // 10 * 1.2 = 12 ceiling; 11 is under it.
    expect(() => checkBudget('harness/within', 11, baseline)).not.toThrow();
  });

  it('gate trips on a synthetic over-budget value', () => {
    const baseline = baselineWith('harness/over', 10);
    // 10 * (1 + 0.2) = 12 ceiling; 13 exceeds it.
    const overBudget = 10 * (1 + REGRESSION_BUDGET) + 1;
    expect(() => checkBudget('harness/over', overBudget, baseline)).toThrow(/regression on "harness\/over"/);
  });
});
