import {closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
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

/** Lockfile path used to serialise cross-worker baseline writes in record mode. */
const LOCK_PATH = join(__dirname, 'baseline.json.lock');

/**
 * One baseline entry: the recorded median plus the provenance needed to read a
 * stale baseline (when it was taken, on what Node/platform). Provenance is
 * informational only; the gate compares against {@link BaselineEntry.medianMs}.
 */
export interface BaselineEntry {
  /** Median wall-clock duration in milliseconds for the label. */
  medianMs: number;
  /** ISO-8601 timestamp of when the entry was recorded. */
  recordedAt: string;
  /** Node version + platform/arch the entry was recorded on. */
  env: string;
}

/** Shape of tests/perf/baseline.json: label -> recorded entry. */
export type Baseline = Record<string, BaselineEntry>;

/**
 * Baseline mode, selected by the PERF_BASELINE env var:
 * - `gate` (default, also when unset): compare each median against the
 *   committed baseline and throw on a regression beyond REGRESSION_BUDGET.
 * - `record`: do not gate; write each measured median (with provenance) into
 *   tests/perf/baseline.json, deliberately rebaselining.
 */
export type BaselineMode = 'gate' | 'record';

/** Resolve the active baseline mode from the environment (default `gate`). */
export function baselineMode(): BaselineMode {
  return process.env.PERF_BASELINE === 'record' ? 'record' : 'gate';
}

/** Provenance string for a freshly recorded entry: `node <ver> <platform>/<arch>`. */
function currentEnv(): string {
  return `node ${process.version} ${process.platform}/${process.arch}`;
}

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

/** Read and parse the committed baseline, or an empty map when absent/empty. */
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
  const entry = baseline[label];

  if (entry === undefined) {
    // eslint-disable-next-line no-console
    console.info(
      `[perf] no baseline yet for "${label}" (measured ${measuredMs.toFixed(4)} ms); ` +
        `will record on rebaseline.`,
    );
    return;
  }

  const expected = entry.medianMs;
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
 * Acquire an exclusive cross-process lock on the baseline file by creating a
 * lockfile with the `wx` flag (fails if it already exists). Perf benches run
 * across parallel Jest workers, so record-mode writes must be serialised or
 * concurrent read-modify-write would lose entries. Spins briefly with a
 * synchronous backoff; the critical section is a single small file write, so
 * contention clears in microseconds.
 *
 * @throws if the lock cannot be acquired within the spin budget.
 */
function acquireLock(): number {
  const deadline = Date.now() + 5000;
  // Busy-wait is acceptable here: the held section is a tiny synchronous write,
  // this runs only in the explicit record flow, and there is no event loop turn
  // to yield to between the synchronous fs calls of a single bench assertion.
  for (;;) {
    try {
      return openSync(LOCK_PATH, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error('[perf] timed out acquiring baseline lock during record');
      }
    }
  }
}

/** Release the lock held via {@link acquireLock}. */
function releaseLock(fd: number): void {
  closeSync(fd);
  // Remove the lockfile so the next writer's `wx` open succeeds.
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // Already gone: nothing to do.
  }
}

/**
 * Record `medianMs` for `label` into the committed baseline, merging with any
 * existing entries. Serialised across workers via a lockfile so parallel
 * benches do not clobber each other's writes. Existing entries for other
 * labels are preserved, so a filtered record run (`-t`) updates only the
 * labels it measured.
 */
export function recordBaseline(label: string, medianMs: number): void {
  const fd = acquireLock();
  try {
    const baseline = loadBaseline();
    baseline[label] = {
      medianMs,
      recordedAt: new Date().toISOString(),
      env: currentEnv(),
    };
    const sorted = Object.keys(baseline)
      .sort()
      .reduce<Baseline>((acc, key) => {
        acc[key] = baseline[key];
        return acc;
      }, {});
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  } finally {
    releaseLock(fd);
  }
}

/**
 * Gate or record `measuredMs` for `label` depending on PERF_BASELINE.
 *
 * - In `gate` mode (default): assert the median stays within REGRESSION_BUDGET
 *   of the committed baseline; a missing label logs a "will record" notice and
 *   passes (so a newly added bench lands without a same-PR baseline edit).
 * - In `record` mode: write the median (with provenance) into the baseline and
 *   pass unconditionally.
 */
export function assertWithinBaseline(label: string, measuredMs: number): void {
  if (baselineMode() === 'record') {
    recordBaseline(label, measuredMs);
    return;
  }
  checkBudget(label, measuredMs, loadBaseline());
}
