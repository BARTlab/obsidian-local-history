import {FileSnapshot} from '@/snapshots/file.snapshot';
import type {SnapshotCaptureOptions} from '@/types';

/**
 * Deterministic fixtures for the snapshot perf benches (T03). Content is
 * generated in code, never committed as JSON, so the repo stays small and the
 * sizes are reproducible from the parameters below. Every generator is pure
 * and seeded only by line/version counts, so a given size always yields the
 * same input and the medians stay comparable across runs.
 */

/** A named fixture size: line count and intermediate-version count. */
export interface SnapshotFixtureSize {
  /** Human label used to namespace bench labels (snapshot.<method>.<size>). */
  readonly name: 'small' | 'medium' | 'large';
  /** Number of lines in the generated file body. */
  readonly lines: number;
  /** Number of intermediate versions to pre-load on the timeline. */
  readonly versions: number;
}

/**
 * The three fixture sizes the bench exercises, per the T03 spec: small (50
 * lines, 5 versions), medium (500 lines, 50 versions), large (5000 lines, 200
 * versions). Frozen so a bench cannot mutate them between iterations.
 */
export const FIXTURE_SIZES: Readonly<Record<SnapshotFixtureSize['name'], SnapshotFixtureSize>> = Object.freeze({
  small: {name: 'small', lines: 50, versions: 5},
  medium: {name: 'medium', lines: 500, versions: 50},
  large: {name: 'large', lines: 5000, versions: 200},
});

/**
 * Capture options with both cadence gates open and generous caps, so a forced
 * or threshold-met capture always fires and the dedup/evict paths are the only
 * thing gating a push during the bench.
 */
export const OPEN_CAPTURE_OPTIONS: Readonly<SnapshotCaptureOptions> = Object.freeze({
  enabled: true,
  intervalMs: 0,
  editThreshold: 1,
  maxVersions: 1_000_000,
  maxVersionAgeDays: 0,
});

/**
 * Build the file body for a size as an array of distinct lines. Each line is
 * unique so tracker edits and content compares do real work instead of hitting
 * trivial equal strings.
 *
 * @param {number} count - Number of lines to generate
 * @return {string[]} The generated lines, length `count`
 */
export function buildLines(count: number): string[] {
  const lines: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    lines[i] = `line ${i} - the quick brown fox jumps over the lazy dog ${i * 7}`;
  }
  return lines;
}

/** Build the file body for a size as a single newline-joined string. */
export function buildContent(size: SnapshotFixtureSize): string {
  return buildLines(size.lines).join('\n');
}

/**
 * Construct a fresh {@link FileSnapshot} from a size's generated content. The
 * tracker, marker baseline, history baseline, and state are all populated by
 * the constructor, so the result is ready for tracker mutations and changes
 * recomputation.
 *
 * @param {SnapshotFixtureSize} size - The fixture size to build
 * @return {FileSnapshot} A snapshot of `size.lines` distinct lines
 */
export function buildSnapshot(size: SnapshotFixtureSize): FileSnapshot {
  return new FileSnapshot(buildContent(size), '\n');
}

/**
 * Construct a snapshot whose current state diverges from the marker baseline
 * across the whole file, so {@link FileSnapshot#updateChanges} has the maximum
 * amount of tracker work to do (every tracked line resolves to a change). The
 * even lines are edited in place and the rest stay, producing a dense change
 * map without altering line counts.
 *
 * @param {SnapshotFixtureSize} size - The fixture size to build
 * @return {FileSnapshot} A snapshot with half its lines edited
 */
export function buildEditedSnapshot(size: SnapshotFixtureSize): FileSnapshot {
  const snapshot: FileSnapshot = buildSnapshot(size);
  const edited: string[] = buildLines(size.lines);

  for (let i = 0; i < edited.length; i += 2) {
    snapshot.findCurrentLine(i)?.change(`edited ${edited[i]}`);
    edited[i] = `edited ${edited[i]}`;
  }

  snapshot.updateState(edited);

  return snapshot;
}

/**
 * Construct a snapshot pre-loaded with `size.versions` intermediate versions on
 * its timeline via the public capture API. Each captured version freezes a
 * distinct content so no capture is deduped away; capture runs forced so the
 * cadence gates do not suppress it. The returned snapshot is at exactly
 * `size.versions` entries (capped well below `maxVersions`), so a subsequent
 * forced capture in the bench drives the evict path with a non-trivial array.
 *
 * @param {SnapshotFixtureSize} size - The fixture size to build
 * @return {FileSnapshot} A snapshot with `size.versions` timeline entries
 */
export function buildVersionedSnapshot(size: SnapshotFixtureSize): FileSnapshot {
  const snapshot: FileSnapshot = buildSnapshot(size);
  const body: string[] = buildLines(size.lines);

  for (let v = 0; v < size.versions; v++) {
    const previous: string[] = body.slice();
    previous[0] = `version ${v} marker`;
    snapshot.captureVersion(previous, OPEN_CAPTURE_OPTIONS, true);
  }

  return snapshot;
}
