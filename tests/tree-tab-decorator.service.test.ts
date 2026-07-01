import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';

import { FolderDeltaStatus } from '@/consts';
import { TreeTabDecoratorService } from '@/services/tree-tab-decorator.service';
import { TOKENS } from '@/services/tokens';
import { FileSnapshot } from '@/snapshots/file.snapshot';
import type { SnapshotsService } from '@/services/snapshots.service';
import type { TFile } from 'obsidian';

import { makeFile, makeInjectHost } from './helpers/builders';

/**
 * Drives a snapshot through a real one-line edit so `getChangesLinesCount()`
 * reports a genuine modification, mirroring the session-status helper tests.
 */
const makeModified = (file: TFile | null, carriedPath?: string): FileSnapshot => {
  const snapshot: FileSnapshot = new FileSnapshot('a\nb\nc', '\n', file);

  if (carriedPath !== undefined) {
    snapshot.path = carriedPath;
  }

  snapshot.trackers.findCurrentLine(1)?.change('B');
  snapshot.content.updateState(['a', 'B', 'c']);
  snapshot.updateChanges();

  return snapshot;
};

/**
 * Exposes the protected `computeStatuses` on a real, fully-constructed service.
 * The `@Inject(TOKENS.snapshots)` field resolves lazily through `plugin.get`, so
 * the service is built over a container host that resolves the snapshots token to
 * a stub reporting the given list and session-created paths. The method reads
 * nothing else, so it runs on genuine instance state instead of a prototype cast
 * that bypassed construction and hand-set `this`.
 */
class TestTreeTabDecoratorService extends TreeTabDecoratorService {
  public statuses(): Map<string, FolderDeltaStatus> {
    return this.computeStatuses();
  }
}

const computeStatuses = (snapshots: FileSnapshot[], sessionCreated: string[] = []): Map<string, FolderDeltaStatus> => {
  const snapshotsService = {
    getList: (): FileSnapshot[] => snapshots,
    getSessionCreatedPaths: (): ReadonlySet<string> => new Set(sessionCreated),
  } as unknown as SnapshotsService;

  const host = makeInjectHost((token: unknown): unknown =>
    token === TOKENS.snapshots ? snapshotsService : undefined,
  ) as unknown as ConstructorParameters<typeof TreeTabDecoratorService>[0];

  return new TestTreeTabDecoratorService(host).statuses();
};

describe('TreeTabDecoratorService.computeStatuses - path resolution', () => {
  it('tints a live snapshot and its ancestor folders by file.path', () => {
    const statuses = computeStatuses([makeModified(makeFile('folder/sub/note.md'))]);

    expect(statuses.get('folder/sub/note.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder/sub')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder')).toBe(FolderDeltaStatus.modified);
  });

  it('tints a restored snapshot with file = null by its carried path', () => {
    // After a reload a restored snapshot keeps its `modified` status but has
    // file = null until re-captured this session. Reading `file?.path` alone
    // dropped it from the tint map, so the folder stopped painting; the carried
    // path mirrors the map key and must place the file and its folders.
    const statuses = computeStatuses([makeModified(null, 'folder/sub/note.md')]);

    expect(statuses.get('folder/sub/note.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder/sub')).toBe(FolderDeltaStatus.modified);
    expect(statuses.get('folder')).toBe(FolderDeltaStatus.modified);
  });

  it('omits a null-file snapshot that carries no path at all', () => {
    const statuses = computeStatuses([makeModified(null)]);

    expect(statuses.size).toBe(0);
  });

  it('prefers the live file.path over a stale carried path', () => {
    const statuses = computeStatuses([makeModified(makeFile('root/live.md'), 'stale/old.md')]);

    expect(statuses.get('root/live.md')).toBe(FolderDeltaStatus.modified);
    expect(statuses.has('stale/old.md')).toBe(false);
    expect(statuses.has('stale')).toBe(false);
  });

  it('paints nothing for a restored snapshot re-baselined session-clean (root and nested alike)', () => {
    // A snapshot restored from disk carries its full history diff until the
    // session marker baseline is re-established. `restore` calls
    // resetMarkerBaseline so a fresh launch starts clean: the decorator must
    // paint neither the file rows nor their folders, consistently for a root
    // file and a nested one.
    const rootRestored = makeModified(makeFile('root-note.md'));
    const nestedRestored = makeModified(makeFile('folder/sub/note.md'));

    rootRestored.resetMarkerBaseline();
    nestedRestored.resetMarkerBaseline();

    const statuses = computeStatuses([rootRestored, nestedRestored]);

    expect(statuses.size).toBe(0);
  });
});
