import {describe, expect, it} from '@jest/globals';

import {assertWithinBaseline, checkBudget, measure, REGRESSION_BUDGET} from './harness';

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

  it('disk-backed gate passes when the baseline has no entry for the label', () => {
    // The committed baseline does not contain this synthetic label, so the
    // gate must treat it as "record on next pass" and not throw.
    expect(() => assertWithinBaseline('harness/__missing-label__', 123.456)).not.toThrow();
  });

  it('gate passes when the measured value is within budget', () => {
    const baseline = {'harness/within': 10};
    // 10 * 1.2 = 12 ceiling; 11 is under it.
    expect(() => checkBudget('harness/within', 11, baseline)).not.toThrow();
  });

  it('gate trips on a synthetic over-budget value', () => {
    const baseline = {'harness/over': 10};
    // 10 * (1 + 0.2) = 12 ceiling; 13 exceeds it.
    const overBudget = 10 * (1 + REGRESSION_BUDGET) + 1;
    expect(() => checkBudget('harness/over', overBudget, baseline)).toThrow(/regression on "harness\/over"/);
  });
});
