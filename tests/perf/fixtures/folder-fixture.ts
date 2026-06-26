import { FileSnapshot } from '@/snapshots/file.snapshot';
import { FileVersion } from '@/snapshots/file.version';
import type { TFile } from 'obsidian';

/**
 * Deterministic fixtures for the folder aggregation perf benches. The
 * snapshot trees are generated in code, never committed as JSON, so the repo
 * stays small and a given shape always yields the same input. Every generator
 * is seeded only by its shape parameters, so the medians stay comparable across
 * runs.
 *
 * The fixtures build the exact shape the folder helpers read in production: a
 * flat list of live FileSnapshots, each carrying a populated version timeline
 * with historical timestamps, plus a sprinkling of tombstones (deletedTimestamp)
 * and moved-in snapshots (movedIntoAt) so `synthesize` emits all three point
 * kinds and `compareAt` exercises the existed-at-T grid (added / deleted /
 * modified / none), not just the live-modified path.
 */

/** A named fixture shape for the folder benches: tree geometry and density. */
export interface FolderFixtureShape {
  /** Human label used to namespace bench labels (folder.<method>.<shape>). */
  readonly name: 'shallow' | 'nested' | 'wide';
  /** Folder nesting depth (path segments before the file name). */
  readonly depth: number;
  /** Total number of files spread across the tree. */
  readonly files: number;
  /** Intermediate versions pre-loaded on each file's timeline. */
  readonly versionsPerFile: number;
  /** Lines in each generated file body. */
  readonly lines: number;
}

/**
 * The three fixture shapes the benches exercise, per the bench spec: shallow (3
 * folders, 30 files, 10 versions/file), nested (10 folders deep, 100 files, 20
 * versions/file), wide (3 folders deep, 1000 files, 5 versions/file). `depth`
 * is the folder nesting under the shared root; `files` is the total file count
 * spread across the tree. Frozen so a bench cannot mutate them between
 * iterations.
 */
export const FIXTURE_SHAPES: Readonly<Record<FolderFixtureShape['name'], FolderFixtureShape>> = Object.freeze({
  shallow: { name: 'shallow', depth: 3, files: 30, versionsPerFile: 10, lines: 20 },
  nested: { name: 'nested', depth: 10, files: 100, versionsPerFile: 20, lines: 20 },
  wide: { name: 'wide', depth: 3, files: 1000, versionsPerFile: 5, lines: 20 },
});

/** The shared root every fixture path lives under, so a real subtree match runs. */
export const ROOT_PATH = 'vault/root';

/**
 * The base timeline timestamp (ms). Version timestamps fan out forward from
 * here by one minute per version, so a probe timestamp in the middle of the
 * range makes `compareAt`'s backward version scan resolve a real interior
 * version rather than short-circuiting at either end.
 */
const BASE_TS: number = Date.UTC(2026, 0, 1);

/** One minute in ms; the spacing between consecutive version timestamps. */
const STEP_MS = 60_000;

/**
 * Build a minimal `TFile`-like object that satisfies the snapshot's path
 * accessor (`snapshot.file.path`) without dragging in Obsidian's full type.
 *
 * @param {string} path - The vault-relative path to stamp on the file
 * @return {TFile} A structural TFile carrying `path`, `name`, `extension`
 */
function makeFile(path: string): TFile {
  const name: string = path.split('/').pop() ?? path;
  const extension: string = name.includes('.') ? name.split('.').pop() ?? '' : '';

  return { path, name, extension } as unknown as TFile;
}

/**
 * Build the vault-relative path for a file index under the shared root, nested
 * `depth` folders deep. The leaf folder index is derived from the file index so
 * files distribute across distinct folders rather than all sharing one leaf.
 *
 * @param {number} fileIndex - The file's ordinal
 * @param {number} depth - Folder nesting depth under the root
 * @return {string} The vault-relative path, always starting with ROOT_PATH
 */
function buildPath(fileIndex: number, depth: number): string {
  const segments: string[] = [ROOT_PATH];

  for (let d = 0; d < depth; d++) {
    // Vary each level by the file index so the tree fans out instead of being a
    // single deep chain; the modulo keeps segment names bounded and reused so
    // sibling files share parent folders the way a real vault does.
    segments.push(`folder-${d}-${(fileIndex >> d) % 4}`);
  }

  segments.push(`file-${fileIndex}.md`);

  return segments.join('/');
}

/**
 * Build a file body of `count` distinct lines for a given file index. The index
 * is woven into every line so two files never share content and the content
 * compares inside `compareAt` (contentEquals) do real work.
 *
 * @param {number} fileIndex - The file's ordinal, mixed into each line
 * @param {number} count - Number of lines to generate
 * @return {string[]} The generated lines, length `count`
 */
function buildLines(fileIndex: number, count: number): string[] {
  const lines: string[] = new Array(count);

  for (let i = 0; i < count; i++) {
    lines[i] = `file ${fileIndex} line ${i} - the quick brown fox jumps over the lazy dog ${i * 7}`;
  }

  return lines;
}

/**
 * Build one live snapshot for a file index with a deterministic version
 * timeline. Versions carry historical timestamps fanning forward from
 * {@link BASE_TS}, and each version body differs from the next so the timeline
 * scan and content compares do non-trivial work. The snapshot timestamp is
 * pinned to the earliest version so `firstSeenAt` is stable and the file reads
 * as existing across the whole probe range.
 *
 * @param {number} fileIndex - The file's ordinal (drives path + content)
 * @param {FolderFixtureShape} shape - The fixture shape (depth, density)
 * @return {FileSnapshot} The populated live snapshot
 */
function buildLiveSnapshot(fileIndex: number, shape: FolderFixtureShape): FileSnapshot {
  const body: string[] = buildLines(fileIndex, shape.lines);
  const snapshot: FileSnapshot = new FileSnapshot(body.join('\n'), '\n', makeFile(buildPath(fileIndex, shape.depth)));

  const versions: FileVersion[] = new Array(shape.versionsPerFile);

  for (let v = 0; v < shape.versionsPerFile; v++) {
    const lines: string[] = body.slice();

    lines[0] = `file ${fileIndex} version ${v} marker`;
    versions[v] = new FileVersion(lines, BASE_TS + v * STEP_MS);
  }

  snapshot.versions = versions;
  snapshot.timestamp = BASE_TS;

  return snapshot;
}

/**
 * Build a flat list of snapshots for a fixture shape: mostly live files, with
 * every fifth file turned into a tombstone (deleted mid-range) and every
 * seventh marked moved-in (mid-range), so `synthesize` emits capture, delete,
 * and move-in points and `compareAt` exercises every branch of its status grid.
 *
 * @param {FolderFixtureShape} shape - The fixture shape to build
 * @return {FileSnapshot[]} The generated snapshots, all under ROOT_PATH
 */
export function buildSnapshots(shape: FolderFixtureShape): FileSnapshot[] {
  const snapshots: FileSnapshot[] = new Array(shape.files);
  const midTs: number = BASE_TS + Math.floor((shape.versionsPerFile / 2)) * STEP_MS;

  for (let f = 0; f < shape.files; f++) {
    const snapshot: FileSnapshot = buildLiveSnapshot(f, shape);

    if (f % 5 === 0) {
      // A tombstone deleted after the mid-range probe: existed at T, gone now,
      // so compareAt resolves the 'deleted' branch with a real base at T.
      snapshot.deletedTimestamp = midTs + STEP_MS;
    } else if (f % 7 === 0) {
      // A moved-in file whose move predates the probe: existed at T at the new
      // path, exercising the moved-in existence branch.
      snapshot.movedIntoAt = BASE_TS;
    }

    snapshots[f] = snapshot;
  }

  return snapshots;
}

/**
 * The mid-range probe timestamp T for a shape, used by the `compareAt` bench so
 * the backward version scan resolves an interior version rather than the
 * earliest or latest, matching a folder-tree redraw against a timeline point in
 * the middle of the file's history.
 *
 * @param {FolderFixtureShape} shape - The fixture shape
 * @return {number} The probe timestamp in ms
 */
export function probeTimestamp(shape: FolderFixtureShape): number {
  return BASE_TS + Math.floor(shape.versionsPerFile / 2) * STEP_MS;
}
