# Performance baseline and regression gate

The perf suite (`tests/perf/**.perf.ts`) microbenchmarks the plugin's pure hot
paths (snapshot tracker/version mutations, persistence serialize/parse/restore,
folder timeline/delta aggregation, diff/hunk/word rendering) and gates each
measured median against a committed baseline. It is a separate Jest project, so
the normal `npm test` dev loop never pays the bench cost.

## How to run

```bash
npm run test:perf
```

This runs in **gate** mode by default: each benchmark measures a time (over a
fixed iteration count) and compares it to the matching entry in
`tests/perf/baseline.json`. The run fails (exit non-zero) if any measurement
exceeds its baseline past the hybrid ceiling described below.

The script sets `NODE_OPTIONS=--expose-gc` so the harness can force a garbage
collection between samples (see "How the measurement is stabilised"). If you run
the perf project directly (`jest --config jest.config.perf.js`) without that
flag, the suite still works, but the heavy diff/render labels become noisier
because the GC stabilisation is skipped. Prefer `npm run test:perf`.

## How the measurement is stabilised

A naive median over a few iterations is far too noisy to gate at a tight budget:
ordinary CPU scheduling and GC pauses make sub-millisecond and allocation-heavy
labels swing 70-150% run-to-run, which produces non-deterministic false
positives. The harness (`measure` in `tests/perf/harness.ts`) removes most of
that noise at the source, in three layers:

1. **Warmup.** A short untimed warmup runs before sampling so the JIT has
   compiled the hot path and the caches are warm; the first few cold calls are
   never timed.
2. **Forced GC between samples.** Before each timed sample the harness runs a
   full GC (when `--expose-gc` is available, which `npm run test:perf` enables),
   so a GC pause caused by the previous iteration's allocations does not land
   inside the next measurement. GC is the dominant noise source on the
   allocation-heavy jsdom render and large diff paths. To keep the cheap
   high-iteration labels fast, GC is forced *adaptively*: only when the previous
   sample was non-trivial (above an internal threshold), since sub-millisecond
   paths allocate too little to provoke a mid-sample GC pause.
3. **Minimum, not median.** `measure` returns the **minimum** timed sample, not
   the median. For a deterministic compute path the true cost is a fixed lower
   bound and every perturbation can only *add* time, so the fastest observed run
   is the most reproducible. A real regression raises the floor too, so it still
   shows up in the minimum. (The baseline field is still named `medianMs` for
   file-format backward compatibility; the value it holds is the minimum.)

Diff/render benches that are intrinsically jittery also take more sample
iterations (see `itersFor` in `tests/perf/fixtures/diff-fixture.ts`) so the
minimum has enough chances to catch one clean, uncontended run even under
moderate machine load, while the expensive near-total `rewrite` shapes keep a
low iteration count to stay inside the suite time budget.

## Regression budget (hybrid ceiling)

The gate ceiling is the **maximum of two arms** - a measurement fails only when
it exceeds BOTH, i.e. it must exceed the larger of:

- **Relative arm:** `baseline * (1 + REGRESSION_BUDGET)`, with
  `REGRESSION_BUDGET = 0.4` (**40%**).
- **Absolute arm:** `baseline + ABS_SLACK_MS`, with `ABS_SLACK_MS = 0.8` ms.

Both constants live in `tests/perf/harness.ts`; this document and the gate share
that single source of truth.

Why hybrid:

- A purely **relative** budget is hardware-portable (the per-machine baseline
  cancels out of the ratio) but on sub-millisecond labels it is far tighter than
  ordinary jitter: a 0.04 ms baseline at 40% has a 0.056 ms ceiling, which any
  scheduler hiccup blows past. The **absolute arm** widens the ceiling on those
  tiny labels (a 0.04 ms baseline gets a 0.84 ms ceiling) so noise on paths too
  small to carry a real regression signal does not flap the gate - without
  un-gating them, since a genuinely large absolute regression still trips it.
- On multi-millisecond labels the **relative arm** dominates and stays tight, so
  a real algorithmic regression is still caught. A real ~2x (=100%) regression
  exceeds the 40% relative ceiling by a wide margin and fails the gate, naming
  the label.

The 40% / 0.8 ms values were chosen empirically, not guessed: across eight
record runs on an unloaded machine, 40% / 0.8 ms was the smallest pair that
produced **zero** false positives across all 56 cross-run baseline/measurement
pairs, while a real injected 2x slowdown on a hot path still failed the gate.

A relative-only or absolute-only model was rejected: relative-only flaps on tiny
labels, absolute-only is hardware-fragile on the slow ones. The two arms cover
each other's blind spot.

## How to read a failure

A gate failure prints one line per regressed label, for example:

```
[perf] regression on "folder.timeline.synthesize.wide": measured 14.4378 ms exceeds
baseline 7.0997 ms past the hybrid ceiling 9.9396 ms (max of +40% = 9.9396 ms and
+0.8 ms = 7.8997 ms).
```

The line names the label, the measured time, the recorded baseline, the
effective (hybrid) ceiling, and both arms that produced it. If the failure is a
real regression, fix the hot path. If it is hardware noise (a loaded CI box,
thermal throttling), re-run; the measurement is heavily stabilised (warmup +
forced GC + minimum-of-N), but a severely contended machine can still skew a
tight bench.

A newly added benchmark whose label is **not** in `baseline.json` is **not** a
failure: the gate logs a `no baseline yet ... will record` notice and passes, so
a new bench can land in the same PR without a baseline edit. Record its number
on the next deliberate rebaseline.

## How to rebaseline

Rebaselining overwrites `tests/perf/baseline.json` with fresh medians. Run:

```bash
PERF_BASELINE=record npm run test:perf
```

In **record** mode the gate is disabled: each benchmark writes its measured time
(the minimum-of-N, stored in the `medianMs` field), an ISO `recordedAt`
timestamp, and an `env` string (Node version + platform/arch) into
`baseline.json`, and the run always exits 0. Existing entries
for labels not measured in this run are preserved, so a filtered run
(`PERF_BASELINE=record npm run test:perf -- -t snapshot`) updates only those
labels.

`PERF_BASELINE` is the only switch: unset or `gate` enforces, `record` rewrites.
There is no CLI flag.

Commit the regenerated `baseline.json` as a reviewable diff.

## When to rebaseline

Rebaseline **only** after one of:

- a deliberate optimisation of a benched hot path (the new, lower numbers are
  the intended result), or
- a feature change that legitimately touches a benched hot path and shifts its
  cost (the new numbers reflect the new, accepted behaviour).

Do **not** rebaseline to silence a gate failure you have not explained. Silent
or routine rebaselining defeats regression detection: it hides drift instead of
surfacing it. A baseline bump must be a conscious, reviewed decision, captured in
its own commit with a message that says why the numbers moved.

## Provenance

Last recorded: 2026-06-04 on node v24.15.0 (linux/x64), plugin commit b92b4dd
(measurement method: warmup + adaptive forced GC + minimum-of-N; hybrid ceiling
max(+40%, +0.8 ms)).
