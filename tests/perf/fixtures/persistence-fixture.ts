import { FileSnapshot } from '@/snapshots/file.snapshot';
import type {
  SerializedFileSnapshot,
  SerializedHistory,
  SnapshotCaptureOptions,
} from '@/types';
import type { TFile } from 'obsidian';

/**
 * Deterministic fixtures for the persistence perf benches. The serialized
 * snapshot sets are generated in code from the real FileSnapshot codec
 * (constructor + captureVersion + toJSON), never committed as JSON, so the repo
 * stays small and a given size always yields the same payload. Building through
 * the production codec keeps the fixtures faithful to what restoreFromDisk's
 * readAll really hands the service: each entry carries a populated tracker plus
 * an encoded version timeline, so serialize/parse/restore/retention measure the
 * same shape they pay for in production.
 */

/** A named fixture size: file count and total intermediate-version count. */
export interface PersistenceFixtureSize {
  /** Human label used to namespace bench labels (persistence.<method>.<size>). */
  readonly name: 'small' | 'medium' | 'large';
  /** Number of distinct file snapshots in the history set. */
  readonly files: number;
  /** Total intermediate versions across all files (versionsPerFile * files). */
  readonly versions: number;
  /** Number of lines in each generated file body. */
  readonly lines: number;
}

/**
 * The three fixture sizes the benches exercise, per the bench spec: small (20
 * files / 100 versions total), medium (200 files / 2000 total), large (2000
 * files / 20000 total). `versions` is the documented total; per-file count is
 * `versions / files` (5, 10, 10). Line bodies stay small so the large set
 * (2000 files) builds and round-trips in well under a second. Frozen so a bench
 * cannot mutate them between iterations.
 */
export const FIXTURE_SIZES: Readonly<Record<PersistenceFixtureSize['name'], PersistenceFixtureSize>> = Object.freeze({
  small: { name: 'small', files: 20, versions: 100, lines: 40 },
  medium: { name: 'medium', files: 200, versions: 2000, lines: 40 },
  large: { name: 'large', files: 2000, versions: 20000, lines: 40 },
});

/**
 * Capture options that always push a version (cadence gates open, caps generous)
 * so each forced capture lands its own distinct version on the timeline rather
 * than being deduped or evicted while the fixture is built.
 */
const OPEN_CAPTURE_OPTIONS: Readonly<SnapshotCaptureOptions> = Object.freeze({
  enabled: true,
  intervalMs: 0,
  editThreshold: 1,
  maxVersions: 1_000_000,
  maxVersionAgeDays: 0,
});

/**
 * Build a file body of `count` distinct lines for a given file index. The index
 * is woven into every line so two files never share content and the content
 * compares inside the codec and retention do real work.
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
 * Build one serialized snapshot for a file index by driving the real codec: a
 * FileSnapshot is constructed from the body, `versionsPerFile` distinct
 * intermediate versions are force-captured onto its timeline, then `toJSON`
 * encodes it to the on-disk shape. The `path` and `timestamp` are stamped
 * afterwards (the constructor leaves `path` empty without a TFile, and a fixed
 * monotonic timestamp keeps retention deterministic).
 *
 * @param {number} fileIndex - The file's ordinal (drives path + content)
 * @param {number} versionsPerFile - Intermediate versions to pre-load
 * @param {number} lineCount - Lines per file body
 * @param {number} timestamp - The snapshot timestamp to stamp
 * @return {SerializedFileSnapshot} The serialized snapshot payload
 */
function buildSerializedSnapshot(
  fileIndex: number,
  versionsPerFile: number,
  lineCount: number,
  timestamp: number,
): SerializedFileSnapshot {
  const body: string[] = buildLines(fileIndex, lineCount);
  const snapshot: FileSnapshot = new FileSnapshot(body.join('\n'), '\n');

  for (let v = 0; v < versionsPerFile; v++) {
    const previous: string[] = body.slice();

    previous[0] = `file ${fileIndex} version ${v} marker`;
    snapshot.captureVersion(previous, OPEN_CAPTURE_OPTIONS, true);
  }

  const payload: SerializedFileSnapshot = snapshot.toJSON();

  payload.path = `notes/folder-${fileIndex % 50}/file-${fileIndex}.md`;
  payload.timestamp = timestamp;

  return payload;
}

/**
 * Build the full serialized snapshot set for a fixture size. The total version
 * count is spread evenly across files (`versions / files`, rounded down, at
 * least one). Timestamps descend by one minute per file so retention's
 * newest-first sort has a strict, deterministic order to work with.
 *
 * @param {PersistenceFixtureSize} size - The fixture size to build
 * @return {SerializedFileSnapshot[]} The generated serialized snapshots
 */
export function buildSerializedSnapshots(size: PersistenceFixtureSize): SerializedFileSnapshot[] {
  const versionsPerFile: number = Math.max(1, Math.floor(size.versions / size.files));
  const base: number = Date.UTC(2026, 0, 1);
  const snapshots: SerializedFileSnapshot[] = new Array(size.files);

  for (let f = 0; f < size.files; f++) {
    snapshots[f] = buildSerializedSnapshot(f, versionsPerFile, size.lines, base - (f * 60_000));
  }

  return snapshots;
}

/** Build the full serialized history payload (version + snapshots) for a size. */
export function buildSerializedHistory(size: PersistenceFixtureSize): SerializedHistory {
  return { version: 2, snapshots: buildSerializedSnapshots(size) };
}

/**
 * A spying plugin stub for the SnapshotsService and PersistenceService benches.
 * Holds an in-memory vault adapter whose mutating ops are counted so the bench
 * can prove no disk write escapes, plus a path-to-file map so
 * `restore` takes the live-file branch (FileSnapshot.fromJSON with a real file)
 * for every fixture path rather than the orphan/tombstone branch.
 */
export interface PluginStub {
  /** The plugin object passed to the services under test. */
  readonly plugin: unknown;
  /** Count of mutating adapter calls (write/rename/remove/mkdir/rmdir). */
  writeCount(): number;
}

/**
 * Build a plugin stub wired with the fixture's file paths and an injected
 * settings service returning the given retention caps. Every fixture path
 * resolves to a minimal TFile so `SnapshotsService.restore` rebuilds a live
 * snapshot per entry; the in-memory adapter records mutating calls so the bench
 * asserts zero writes.
 *
 * @param {string[]} paths - The vault-relative paths the fixtures use
 * @param {Record<string, number>} retention - Retention caps by settings key
 * @return {PluginStub} The stub plugin plus a write counter
 */
export function buildPluginStub(paths: string[], retention: Record<string, number>): PluginStub {
  let mutations = 0;

  const adapter = {
    write: async (): Promise<void> => {
      mutations++;
    },
    rename: async (): Promise<void> => {
      mutations++;
    },
    remove: async (): Promise<void> => {
      mutations++;
    },
    mkdir: async (): Promise<void> => {
      mutations++;
    },
    rmdir: async (): Promise<void> => {
      mutations++;
    },
    read: async (): Promise<string> => '',
    exists: async (): Promise<boolean> => false,
    list: async (): Promise<{ files: string[]; folders: string[] }> => ({ files: [], folders: [] }),
  };

  const files: Map<string, TFile> = new Map();

  for (const path of paths) {
    const name: string = path.split('/').pop() ?? path;
    const extension: string = name.includes('.') ? name.split('.').pop() ?? '' : '';

    files.set(path, { path, name, extension } as unknown as TFile);
  }

  const settingsService = {
    value: (key: string): number => retention[key] ?? 0,
  };

  const plugin = {
    get: (): unknown => settingsService,
    getActiveEditorView: (): undefined => undefined,
    getActiveFile: (): null => null,
    getFileByPath: (path: string): TFile | null => files.get(path) ?? null,
    forceUpdate: (): void => undefined,
    forceUpdateEditor: (): void => undefined,
    emit: (): void => undefined,
    t: (key: string): string => key,
    manifest: { dir: 'plugins/local-history', id: 'local-history' },
    app: {
      vault: {
        adapter,
        configDir: '.obsidian',
      },
    },
  };

  return {
    plugin,
    writeCount: (): number => mutations,
  };
}

/** The retention caps used by the benches: generous so nothing is evicted. */
export const OPEN_RETENTION: Readonly<Record<string, number>> = Object.freeze({
  'retention.maxEntries': 0,
  'retention.maxAgeDays': 0,
  'retention.maxDeletedEntries': 0,
  'retention.maxDeletedAgeDays': 0,
});
