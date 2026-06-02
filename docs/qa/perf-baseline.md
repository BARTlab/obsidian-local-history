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

This runs in **gate** mode by default: each benchmark measures a median (over a
fixed iteration count) and compares it to the matching entry in
`tests/perf/baseline.json`. The run fails (exit non-zero) if any median exceeds
its baseline by more than the regression budget.

## Regression budget

The budget is **relative**, not absolute: a measured median may exceed its
baseline by up to **20%** before the gate fails. The value lives in one place,
`REGRESSION_BUDGET` in `tests/perf/harness.ts`; this document and the gate share
that single source of truth.

A relative budget is deliberate. Absolute millisecond thresholds are
hardware-fragile and would break on every contributor's machine. The baseline
numbers are per-machine (recorded on the maintainer's hardware), but the 20%
ratio is portable, so the suite catches a genuine algorithmic regression without
flagging a slower laptop.

## How to read a failure

A gate failure prints one line per regressed label, for example:

```
[perf] regression on "snapshot.updateChanges.medium": measured 1.4321 ms exceeds
baseline 1.0000 ms by more than the 20% budget (ceiling 1.2000 ms).
```

The line names the label, the measured median, the recorded baseline, and the
ceiling (`baseline x 1.20`). If the failure is a real regression, fix the hot
path. If it is hardware noise (a loaded CI box, thermal throttling), re-run; the
median already absorbs single GC pauses, but a heavily contended machine can
still skew a tight bench.

A newly added benchmark whose label is **not** in `baseline.json` is **not** a
failure: the gate logs a `no baseline yet ... will record` notice and passes, so
a new bench can land in the same PR without a baseline edit. Record its number
on the next deliberate rebaseline.

## How to rebaseline

Rebaselining overwrites `tests/perf/baseline.json` with fresh medians. Run:

```bash
PERF_BASELINE=record npm run test:perf
```

In **record** mode the gate is disabled: each benchmark writes its measured
`medianMs`, an ISO `recordedAt` timestamp, and an `env` string (Node version +
platform/arch) into `baseline.json`, and the run always exits 0. Existing entries
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
