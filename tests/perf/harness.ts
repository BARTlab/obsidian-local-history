import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';

/**
 * Relative regression budget for the perf gate. A measured median may exceed
 * its committed baseline by up to this fraction before the gate fails. Lives
 * in one place so the gate logic and the error message share a single source
 * of truth; documented in docs/qa/perf-baseline.md.
 */
export const REGRESSION_BUDGET = 0.2;

/** Absolute path to the committed baseline file. */
export const BASELINE_PATH = join(__dirname, 'baseline.json');

/** Shape of tests/perf/baseline.json: label -> median milliseconds. */
export type Baseline = Record<string, number>;

/**
 * Run `fn` `iters` times and return the median wall-clock duration in
 * milliseconds, measured with node:perf_hooks. The median is used instead of
 * the mean so a single GC pause or scheduler hiccup does not skew the result.
 *
 * @throws if `iters` is not a positive integer.
 */
export function measure(label: string, fn: () => void, iters: number): number {
  if (!Number.isInteger(iters) || iters <= 0) {
    throw new Error(`measure(${label}): iters must be a positive integer, got ${iters}`);
  }

  const samples: number[] = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    fn();
    samples[i] = performance.now() - start;
  }

  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 0 ? (samples[mid - 1] + samples[mid]) / 2 : samples[mid];
}

/** Read and parse the committed baseline, or an empty map when absent. */
export function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    return {};
  }
  const raw = readFileSync(BASELINE_PATH, 'utf8').trim();
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw) as Baseline;
}

/**
 * Pure budget check, decoupled from disk so it is deterministically testable.
 *
 * - Missing baseline label: logs a "no baseline yet, will record" notice and
 *   returns without throwing, so benches can land before their numbers exist.
 * - Over budget: throws naming the label, baseline, measured value, and the
 *   budget percentage.
 */
export function checkBudget(label: string, measuredMs: number, baseline: Baseline): void {
  const expected = baseline[label];

  if (expected === undefined) {
    // eslint-disable-next-line no-console
    console.info(
      `[perf] no baseline yet for "${label}" (measured ${measuredMs.toFixed(4)} ms); ` +
        `will record on rebaseline.`,
    );
    return;
  }

  const ceiling = expected * (1 + REGRESSION_BUDGET);
  if (measuredMs > ceiling) {
    const budgetPct = (REGRESSION_BUDGET * 100).toFixed(0);
    throw new Error(
      `[perf] regression on "${label}": measured ${measuredMs.toFixed(4)} ms exceeds ` +
        `baseline ${expected.toFixed(4)} ms by more than the ${budgetPct}% budget ` +
        `(ceiling ${ceiling.toFixed(4)} ms).`,
    );
  }
}

/**
 * Assert that `measuredMs` for `label` stays within REGRESSION_BUDGET of the
 * committed baseline in tests/perf/baseline.json. Thin disk-backed wrapper
 * over {@link checkBudget}.
 */
export function assertWithinBaseline(label: string, measuredMs: number): void {
  checkBudget(label, measuredMs, loadBaseline());
}
