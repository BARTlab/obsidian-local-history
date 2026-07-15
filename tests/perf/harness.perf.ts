import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ABS_SLACK_MS,
  assertWithinBaseline,
  type Baseline,
  baselineMode,
  checkBudget,
  measure,
  REGRESSION_BUDGET,
} from './harness';

/** Build a one-label baseline with the given median; provenance is filler. */
function baselineWith(label: string, medianMs: number): Baseline {
  return { [label]: { medianMs, recordedAt: '2026-01-01T00:00:00.000Z', env: 'node test' } };
}

/**
 * Self-test for the perf harness. Runs under vitest.config.perf.ts only (named
 * *.perf.ts so the default `npm test` never picks it up). Proves the harness
 * contracts the later benches rely on: measure returns a positive minimum and
 * honours warmup, the gate is lenient when a baseline label is missing, the
 * hybrid ceiling trips on a synthetic over-budget value, and the absolute arm
 * widens the ceiling on a tiny-baseline label.
 */
describe('perf harness', () => {
  const ambientScale = process.env.PERF_CEILING_SCALE;

  // checkBudget reads PERF_CEILING_SCALE from the environment; the synthetic
  // ceilings below assume the default scale, so pin it per test and hand the
  // ambient value (CI sets 2) back to the real benches afterwards.
  beforeEach(() => {
    delete process.env.PERF_CEILING_SCALE;
  });

  afterAll(() => {
    if (ambientScale !== undefined) {
      process.env.PERF_CEILING_SCALE = ambientScale;
    }
  });

  it('measure returns a positive minimum over the iteration count', () => {
    const min = measure('harness/self-test', () => {
      let acc = 0;

      for (let i = 0; i < 1000; i++) {
        acc += i;
      }

      // Touch acc so the loop is not optimised away.
      if (acc < 0) {
        throw new Error('unreachable');
      }
    }, 50);

    expect(min).toBeGreaterThan(0);
    expect(Number.isFinite(min)).toBe(true);
  });

  it('measure runs warmup iterations without timing them', () => {
    let calls = 0;
    measure('harness/warmup', () => {
      calls++;
    }, 10, 5);
    // 5 warmup + 10 timed calls = 15 total invocations.
    expect(calls).toBe(15);
  });

  it('measure rejects a non-positive iteration count', () => {
    expect(() => measure('harness/bad-iters', () => undefined, 0)).toThrow();
  });

  it('measure rejects a negative warmup count', () => {
    expect(() => measure('harness/bad-warmup', () => undefined, 10, -1)).toThrow();
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
    // Hybrid ceiling = max(10 * (1 + 0.4) = 14, 10 + 0.8 = 10.8) = 14; 11 is under it.
    const within = 10 * (1 + REGRESSION_BUDGET) - 1;
    expect(() => checkBudget('harness/within', within, baseline)).not.toThrow();
  });

  it('gate trips on a synthetic over-budget value (relative arm dominates)', () => {
    const baseline = baselineWith('harness/over', 10);
    // Hybrid ceiling = max(14, 10.8) = 14; 15 exceeds it.
    const overBudget = 10 * (1 + REGRESSION_BUDGET) + 1;
    expect(() => checkBudget('harness/over', overBudget, baseline)).toThrow(/regression on "harness\/over"/);
  });

  it('PERF_CEILING_SCALE multiplies the hybrid ceiling (slow-runner mode)', () => {
    const baseline = baselineWith('harness/scaled', 10);
    const prev = process.env.PERF_CEILING_SCALE;
    process.env.PERF_CEILING_SCALE = '2';

    try {
      // Hybrid ceiling = max(14, 10.8) * 2 = 28; 20 passes only thanks to the scale.
      expect(() => checkBudget('harness/scaled', 20, baseline)).not.toThrow();
      // Past the scaled ceiling still trips.
      expect(() => checkBudget('harness/scaled', 29, baseline)).toThrow(/regression on "harness\/scaled"/);
      // A junk value must fail loudly, not silently weaken or restore the gate.
      process.env.PERF_CEILING_SCALE = 'fast';
      expect(() => checkBudget('harness/scaled', 20, baseline)).toThrow(/PERF_CEILING_SCALE/);
    } finally {
      if (prev === undefined) {
        delete process.env.PERF_CEILING_SCALE;
      } else {
        process.env.PERF_CEILING_SCALE = prev;
      }
    }
  });

  it('absolute arm widens the ceiling on a tiny-baseline label', () => {
    // Baseline 0.04 ms: relative ceiling 0.056 ms, absolute ceiling 0.84 ms; the
    // hybrid max is the absolute arm, so a 0.2 ms reading (a +400% relative jump
    // that is just scheduling jitter on a sub-0.1 ms path) must NOT trip the gate.
    const baseline = baselineWith('harness/tiny', 0.04);
    expect(() => checkBudget('harness/tiny', 0.2, baseline)).not.toThrow();
    // A value past the absolute ceiling (a real regression) still trips.
    expect(() => checkBudget('harness/tiny', 0.04 + ABS_SLACK_MS + 0.01, baseline)).toThrow(
      /regression on "harness\/tiny"/,
    );
  });
});
