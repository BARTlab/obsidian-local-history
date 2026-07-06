import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Relative regression budget for the perf gate. A measured time may exceed its
 * committed baseline by up to this fraction before the relative arm of the gate
 * trips. Lives in one place so the gate logic and the error message share a
 * single source of truth; documented in docs/qa/perf-baseline.md.
 *
 * Set to 0.4 (40%), not the tighter 20% first shipped: even after the measure()
 * stabilisations (warmup + adaptive GC + min-of-N), a few intrinsically jittery
 * jsdom render labels still swing ~30-35% run-to-run on an unloaded machine
 * (measured over 8 record runs: `diff.render.large.edit` 31%,
 * `diff.render.small.churn` 35%), which a 20% budget turned into recurring
 * false positives. 40% is the smallest budget under which no false positive was
 * observed across all 56 cross-run pairs of those 8 runs, while still failing
 * any genuine regression of 40% or more - a real ~2x (=100%) regression on a
 * hot path trips it with a wide margin, so the gate stays meaningful.
 */
export const REGRESSION_BUDGET = 0.4;

/**
 * Absolute slack (milliseconds) added on top of the baseline to form the second
 * arm of the hybrid ceiling. The gate fails only when a measurement exceeds
 * BOTH the relative ceiling (`baseline * (1 + REGRESSION_BUDGET)`) AND the
 * absolute ceiling (`baseline + ABS_SLACK_MS`), i.e. the gate ceiling is the
 * MAX of the two. On sub-millisecond labels even a 40% relative ceiling is
 * tighter than ordinary CPU-scheduling/GC jitter (a 0.04 ms baseline has a
 * 0.056 ms relative ceiling, which any preemption blows past), so the absolute
 * arm dominates there and absorbs that jitter; on multi-millisecond labels the
 * relative arm dominates and a real algorithmic regression still trips it.
 *
 * Set to 0.8 ms: the worst sub-millisecond absolute swing observed over 8
 * record runs was `diff.render.small.edit` at ~0.76 ms (baseline ~0.33 ms), and
 * 0.8 ms is the smallest slack that covered it with zero false positives across
 * all 56 cross-run pairs. It is far below the delta any real ~2x regression on
 * a path worth gating tightly (all multi-millisecond) produces, so the relative
 * arm, not this slack, is what guards those. Documented in
 * docs/qa/perf-baseline.md.
 */
export const ABS_SLACK_MS = 0.8;

/**
 * Default number of untimed warmup iterations run before sampling in
 * {@link measure}, expressed as a fraction of the timed iteration count (capped
 * by {@link MAX_WARMUP}). Warmup lets the JIT compile the hot path and the data
 * caches fill so the timed samples reflect steady-state cost, not cold-start
 * compilation, which is a large and irreproducible component on the first few
 * calls of a tiny path.
 */
const WARMUP_FRACTION = 0.2;

/** Hard cap on warmup iterations so an expensive bench does not pay a huge warmup tax. */
const MAX_WARMUP = 20;

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
  /**
   * Recorded wall-clock duration in milliseconds for the label, the statistic
   * {@link measure} returns (the minimum over the timed samples). The field is
   * named `medianMs` for backward compatibility with already-committed baseline
   * files; the value it carries is the min, not the median (see {@link measure}
   * for why the minimum is the right estimator for a regression gate).
   */
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
 * Run `fn` `iters` times (after a short untimed warmup) and return the MINIMUM
 * wall-clock duration in milliseconds across the timed samples, measured with
 * node:perf_hooks.
 *
 * The minimum (not the median or mean) is the statistic: for a deterministic
 * compute path the true cost is a fixed lower bound, and every perturbation
 * (scheduler preemption, GC, an interrupt) can only ADD time, never remove it.
 * The fastest observed sample is therefore the one least contaminated by noise
 * and the most reproducible run-to-run, which is exactly what a regression gate
 * needs: the median still carries half its samples above it and so drifts with
 * system load, producing the run-to-run false positives this gate suffered. A
 * genuine algorithmic regression raises the floor too, so it still shows up in
 * the minimum.
 *
 * `warmup` defaults to {@link WARMUP_FRACTION} of `iters` (capped by
 * {@link MAX_WARMUP}); pass an explicit count to override. Warmup iterations are
 * not timed.
 *
 * @throws if `iters` is not a positive integer, or `warmup` is negative.
 */
export function measure(
  label: string,
  fn: () => void,
  iters: number,
  warmup: number = Math.min(MAX_WARMUP, Math.ceil(iters * WARMUP_FRACTION)),
): number {
  if (!Number.isInteger(iters) || iters <= 0) {
    throw new Error(`measure(${label}): iters must be a positive integer, got ${iters}`);
  }

  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new Error(`measure(${label}): warmup must be a non-negative integer, got ${warmup}`);
  }

  for (let i = 0; i < warmup; i++) {
    fn();
  }

  let min = Infinity;
  let prevElapsed = 0;

  for (let i = 0; i < iters; i++) {
    // Collect garbage before timing so a GC pause triggered by the previous
    // iteration's allocations does not land inside this sample. GC is the
    // dominant run-to-run noise source on the allocation-heavy paths (jsdom
    // diff render, large word/line diffs): without this, those labels swing
    // 70-155% run-to-run; with it they settle to single-digit-percent.
    //
    // Only the costly paths need this, and forcing a full GC before every
    // sample of a cheap 200-iteration label would multiply the suite runtime
    // for no stability gain (sub-millisecond paths allocate too little to
    // provoke a mid-sample GC pause and are already stable from min-of-N). So
    // GC is forced adaptively: only when the previous sample crossed
    // GC_SAMPLE_THRESHOLD_MS, plus once up front to clear the warmup's garbage.
    // Exposed only when Node runs with --expose-gc (the test:perf script sets
    // it); absent that flag forceGc is a no-op and the gate leans on its hybrid
    // ceiling.
    if (i === 0 || prevElapsed >= GC_SAMPLE_THRESHOLD_MS) {
      forceGc();
    }

    const start = performance.now();
    fn();
    const elapsed = performance.now() - start;
    prevElapsed = elapsed;

    if (elapsed < min) {
      min = elapsed;
    }
  }

  return min;
}

/**
 * Per-sample cost (milliseconds) above which {@link measure} forces a GC before
 * the next sample. Below this a path allocates too little to risk a mid-sample
 * GC pause and is already stable from min-of-N, so skipping GC there keeps the
 * cheap high-iteration labels fast.
 */
const GC_SAMPLE_THRESHOLD_MS = 1;

/**
 * Reference to Node's manual GC trigger, present only when the process was
 * started with `--expose-gc`. Captured once at module load.
 */
const exposedGc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;

/** Run a full GC if `--expose-gc` made one available; otherwise a no-op. */
function forceGc(): void {
  if (exposedGc !== undefined) {
    exposedGc();
  }
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
 * The ceiling is HYBRID: a measurement fails only when it exceeds BOTH the
 * relative ceiling (`baseline * (1 + REGRESSION_BUDGET)`) and the absolute
 * ceiling (`baseline + ABS_SLACK_MS`), i.e. the effective ceiling is the MAX of
 * the two. The absolute arm widens the gate just enough on sub-millisecond
 * labels (where a flat 20% is tighter than ordinary jitter) without un-gating
 * them, while the relative arm keeps multi-millisecond labels tight so a real
 * ~2x regression still trips. See ABS_SLACK_MS for the reasoning.
 *
 * - Missing baseline label: logs a "no baseline yet, will record" notice and
 *   returns without throwing, so benches can land before their numbers exist.
 * - Over budget: throws naming the label, baseline, measured value, and the
 *   effective ceiling.
 */
export function checkBudget(label: string, measuredMs: number, baseline: Baseline): void {
  const entry = baseline[label];

  if (entry === undefined) {
     
    console.info(
      `[perf] no baseline yet for "${label}" (measured ${measuredMs.toFixed(4)} ms); ` +
        'will record on rebaseline.',
    );

    return;
  }

  const expected = entry.medianMs;
  const relativeCeiling = expected * (1 + REGRESSION_BUDGET);
  const absoluteCeiling = expected + ABS_SLACK_MS;
  const ceiling = Math.max(relativeCeiling, absoluteCeiling);

  if (measuredMs > ceiling) {
    const budgetPct = (REGRESSION_BUDGET * 100).toFixed(0);
    throw new Error(
      `[perf] regression on "${label}": measured ${measuredMs.toFixed(4)} ms exceeds ` +
        `baseline ${expected.toFixed(4)} ms past the hybrid ceiling ${ceiling.toFixed(4)} ms ` +
        `(max of +${budgetPct}% = ${relativeCeiling.toFixed(4)} ms and ` +
        `+${ABS_SLACK_MS} ms = ${absoluteCeiling.toFixed(4)} ms).`,
    );
  }
}

/**
 * Acquire an exclusive cross-process lock on the baseline file by creating a
 * lockfile with the `wx` flag (fails if it already exists). Perf benches run
 * across parallel vitest workers, so record-mode writes must be serialised or
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
