# Performance baseline and regression gate

The perf suite (`tests/perf/**.perf.ts`) microbenchmarks the plugin's pure hot
paths (snapshot, persistence, folder timeline/delta, diff/hunk/word rendering)
and gates each measured minimum against a committed baseline. It is a separate
Jest project (`jest.config.perf.js`), so `npm test` never pays the bench cost.

## How to run

```bash
npm run test:perf
```

Runs in **gate** mode by default: each benchmark measures a time and compares it
to the matching entry in `tests/perf/baseline.json`, failing (exit non-zero) if a
measurement exceeds its baseline past the hybrid ceiling below. The script sets
`NODE_OPTIONS=--expose-gc` so the harness can force a GC between samples; without
that flag the run still works but the heavy diff/render labels get noisier.

## How the measurement is stabilised

`measure` in `tests/perf/harness.ts` removes run-to-run noise in three layers,
documented at their source there:

- **Warmup:** untimed calls first, so timing excludes cold JIT compilation.
- **Adaptive forced GC:** a full GC before non-trivial samples (needs
  `--expose-gc`) keeps a prior iteration's GC pause out of the next measurement.
- **Minimum, not median:** the minimum sample is the most reproducible estimator
  here (kept in the `medianMs` field for file-format compatibility).

## Regression budget (hybrid ceiling)

The gate ceiling is the **maximum** of a relative arm
(`baseline * (1 + REGRESSION_BUDGET)`) and an absolute arm
(`baseline + ABS_SLACK_MS`); a measurement fails only when it exceeds both. The
two constants and their reasoning live in `tests/perf/harness.ts`, the single
source of truth: the relative arm keeps large labels tight, the absolute arm
absorbs sub-millisecond jitter too small to hide a real regression.

## How to read a failure

A gate failure prints one line per regressed label, for example:

```
[perf] regression on "folder.timeline.synthesize.wide": measured 14.4378 ms exceeds
baseline 7.0997 ms past the hybrid ceiling 9.9396 ms (max of +40% = 9.9396 ms and
+0.8 ms = 7.8997 ms).
```

It names the label, measured time, recorded baseline, effective ceiling, and both
arms. A real regression means fix the hot path; hardware noise (loaded CI, thermal
throttling) means re-run. A label **not** in `baseline.json` is not a failure: the
gate logs a `no baseline yet ... will record` notice and passes, so a new bench
lands without a baseline edit.

## Rebaselining

```bash
PERF_BASELINE=record npm run test:perf
```

In **record** mode the gate is disabled: each benchmark writes its measured time
(`medianMs`), an ISO `recordedAt`, and an `env` string, and the run exits 0.
Unmeasured labels are preserved, so a filtered run (`... -- -t snapshot`) updates
only those. `PERF_BASELINE` is the only switch (unset/`gate` enforces, `record`
rewrites). Commit the regenerated `baseline.json` as a reviewable diff.

Rebaseline **only** after a deliberate optimisation of a benched hot path or a
feature change that legitimately shifts its cost. Do **not** rebaseline to silence
an unexplained gate failure: that hides drift instead of surfacing it. A baseline
bump is a conscious, reviewed decision in its own commit whose message says why.

## Provenance

The baseline holds 39 labels recorded on node v24.15.0 (linux/x64). Each entry
carries its own `recordedAt` and `env` in `baseline.json`, the record of what was
measured when.

- **2026-06-05, commit 416a270** - partial re-baseline of
  `persistence.restore.medium`: the restore path now calls
  `FileSnapshot.resetMarkerBaseline()` per restored snapshot
  (`src/snapshots/history-serializer.ts`), so its minimum rose past the relative
  arm (~62 ms); the other 38 labels were unchanged.
- **2026-06-04, commit df287d7** - initial recording of all labels.
